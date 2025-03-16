// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: (C) 2025 nerditation <nerditation@users.noreply.github.com>
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

/**
 * @module resolver
 *
 * implement the full process to download, install, launch the remote server,
 * and to extract the port number the server is listening at.
 *
 * this module uses the `distrobox` module to run commands in the guest distro.
 * most of the commands are executed through `bash` scripts that is piped to
 * the `stdin` of the bash process.
 *
 * distrobox will always install bash for the guest, even for distros with
 * different default shell, such as `alpine` linux
 */


import * as vscode from 'vscode';
import { server_binary_path, server_download_url, system_identifier } from './remote';
import { arch as node_arch } from 'os';
import { DistroManager, GuestDistro } from './agent';
import { ExtensionGlobals } from "./extension";
import { DetailsView } from './view';
import { detect_platform, download_server_tarball } from './setup';

/**
 * this is the class that "does the actual work", a.k.a. business logic
 *
 * the name is not very descriptive, but I don't know what's better
 */
export class DistroboxResolver {
	private constructor(
		public g: ExtensionGlobals,
		public guest: GuestDistro,
		public guest_os: string,
		public guest_arch: string,
		public control_script_path: string,
		public server_command_path: string,
		public server_download_url: string,
		public server_session_dir: string,
	) {
	}

	/**
	 * this is the actual "constructor" users should use
	 *
	 * this function will try to "guess" the os and architecture for the guest.
	 * the official builds of `vscodium-reh` has two variants for linux, `alpine`
	 * and `linux`. I'm lazy and I just check the libc, if its `musl`, I use
	 * `alpine`, and if its `glibc`, I use `linux`. this is good enough for me.
	 *
	 * @param cmd the command line builder for how to invoke the `distrobox` command
	 * @param name the name of the guest container
	 * @returns a promise that resolves to `Self`
	 */
	public static async create(g: ExtensionGlobals, guest: GuestDistro): Promise<DistroboxResolver> {
		let ldd_info;
		try {
			ldd_info = (await guest.exec("bash", "-c", "ldd --version 2>&1")).stdout;
		} catch (e: any) {
			// musl'd ldd doesn't support `--version`, it will exit with code 1
			// promisified execFile will throw exception for non-zero exit code
			// but the stdout is still captured
			ldd_info = e.stdout;
		}
		// `lsb_release` might not be installed on alpine
		// I just check for the `musl` libc, which is the libc used by `alpine`
		// I could also check `/etc/os-release` too, but it's good enough for me.
		const is_musl = ldd_info.match(/musl libc \((.+)\)/);
		let os = "linux", arch = node_arch();
		if (is_musl) {
			os = "alpine";
			arch = linux_arch_to_nodejs_arch(is_musl[1]);
		} else if (ldd_info.match(/Free Software Foundation/)) {
			// glibc's ldd doesn't show the archtecture, need probe further
			// can't use `uname`, 32 bit guests can run on 64 bit host
			const ldd_info = (await guest.exec("ldd", "/bin/sh")).stdout;
			const glibc_ld_path = ldd_info.match(/\/lib(64)?\/ld-linux-(.+).so/)!;
			arch = linux_arch_to_nodejs_arch(glibc_ld_path[2]);
		} else {
			throw ("distro's libc is neither musl nor glibc");
		}

		const xdg_runtime_dir = (await guest.exec("bash", "-c", 'echo "$XDG_RUNTIME_DIR"')).stdout.trim();
		const server_session_dir = `${xdg_runtime_dir}/vscodium-reh-${system_identifier(os, arch)}-${guest.name}`;
		const server_command_path = `$HOME/${server_binary_path(os, arch)}`;
		const control_script_path = `${server_session_dir}/control-${g.context.extension.packageJSON.version}.sh`;
		const control_script = get_control_script(server_command_path);
		await guest.exec("mkdir", "-p", server_session_dir);
		await guest.write_to_file(control_script_path, control_script);
		await guest.exec("chmod", "+x", control_script_path);
		return new DistroboxResolver(
			g,
			guest,
			os,
			arch,
			control_script_path,
			server_command_path,
			server_download_url(os, arch),
			server_session_dir,
		);
	}

	/**
	 * clear_session_files
	 *
	 * if the server was not properly shutdown, you might have problems to start
	 * new server sessions. this method tries to clean up a potential crashed
	 * session.
	 */
	public async clear_session_files() {
		this.guest.exec(this.control_script_path, "stop",).child.unref();
	}
}

function linux_arch_to_nodejs_arch(arch: string): string {
	// TODO:
	// I don't have arm system to test
	// arm stuff stolen from `open-remote-wsl`
	// https://github.com/jeanp413/open-remote-wsl/blob/20824d50a3346f5fbd7875d3319a1445d8dc1c1e/src/serverSetup.ts#L192
	// also from vscode-remote-oss
	// https://github.com/xaberus/vscode-remote-oss/blob/05938a2efda61006c7178081feb610c00ea53615/utils/update-reh-server.sh#L31
	switch (arch) {
		case "x86_64":
		case "x86-64":
		case "amd64":
			return "x64";
		case "i386":
		case "i686":
			throw "32 bit x86 is not supported";
			return "ia32";
		case "armv7l":
		case "armv8l":
			return "armhf";
		case "arm64":
		case "aarch64":
			return "arm64";
		case "ppc64le":
			return "ppc64le";
		case "riscv64":
			return "riscv64";
		case "loongarch64":
			return "loong64";
		case "s390x":
			return "s390x";
		default:
			throw (`unsupported linux arch ${arch}`);
			return arch;
	}
}

function get_control_script(server_command_path: string) {
	const env = vscode.workspace.getConfiguration().get<Record<string, string | boolean>>("distroboxRemoteServer.launch.environment") ?? {};
	const exports = [];
	for (const name in env) {
		const value = env[name];
		if (typeof value == 'string') {
			exports.push(`${name}="${value}"`);
		} else if (value == true) {
			const local_value = process.env[name];
			if (local_value) {
				exports.push(`${name}="${local_value}"`);
			}
		}
	}
	return `#!/bin/bash

# configuration
SERVER_COMMAND=${server_command_path}
SESSION_DIR="$(dirname "$(realpath "$0")")"


# session files
PORT_FILE=$SESSION_DIR/port
LOG_FILE=$SESSION_DIR/log
COUNT_FILE=$SESSION_DIR/count
PID1_FILE=$SESSION_DIR/pid1
PID2_FILE=$SESSION_DIR/pid2


# for debug purpose only
status() {
	if [[ -f "$PID1_FILE" ]] && kill -0 $(cat "$PID1_FILE") 2>/dev/null; then
		echo "server is running"
		echo "client count: $(cat "$COUNT_FILE")"
		echo "pid1: $(cat "$PID1_FILE"), pid2: $(cat "$PID2_FILE")"
		echo "socket: $(ss -tlnp | grep ":$(cat "$PORT_FILE")")"
		echo "-----------------------------------------------------------"
		cat "$LOG_FILE"
	else
		echo "server is NOT running"
	fi
}


# if a server is running, print the port to stdout and increase use count
connect_server() {
	# make sure server process is still running
	if [[ -f "$PID2_FILE" ]] && kill -0 $(cat "$PID2_FILE") 2>/dev/null; then
		# check the port is open and is bound by the server process
		if [[ -z "$(ss -tlnp | grep ":$(cat $PORT_FILE)" | grep "pid=$(cat "$PID2_FILE")")" ]]; then
			stop_server
			echo STALE
		else
			count="$(cat "$COUNT_FILE")"
			count="$(($"count" + 1))"
			echo "$count" >"$COUNT_FILE"
			cat "$PORT_FILE"
		fi
	else
		echo NOT RUNNING;
	fi
}


# decrease use count, kill the server process if reached zero
# but sleep several seconds first, just in case vscodium reloads the extension
disconnect_server() {
	# grace period to prevent thrashing server process
	sleep "$1"

	if [[ -f "$COUNT_FILE" ]]; then
		# decrease the use count
		count="$(cat "$COUNT_FILE")"
		count="$(("$count" - 1))"
		echo "$count" >"$COUNT_FILE"
		if [[ "$count" -eq 0 ]]; then
			stop_server
		fi
	else
		echo "NOT CONNECTED"
	fi
}


# launch the process daemonized,
start_server() {
	${exports.map(variable => "export " + variable).join("\n\t")}
	nohup \\
		"$SERVER_COMMAND" \\
		--accept-server-license-terms \\
		--telemetry-level off \\
		--host localhost \\
		--port 0 \\
		--without-connection-token \\
		2>&1 \\
		>"$LOG_FILE" \\
		&

	# save the wrapper pid1, the node pid2 needs to be found later
	PID1=$!

	# try to extract the port number from the server output
	for ((i = 0; i < $1; i++)); do
		PORT="$(sed -n 's/.*Extension host agent listening on \\([0-9]\\+\\).*/\\1/p' "$LOG_FILE")"
		if [[ -n "$PORT" ]]; then
			break
		fi
		sleep 0.1
	done

	# if succeeded, initialize the use count to 1
	# save the port number, and print it to stdout
	if [[ -n "$PORT" ]]; then
		# ps output contains a leading space, use 'xargs' to trim
		PID2=$(ps --ppid $PID1 --format pid= | xargs)
		echo "1" >"$COUNT_FILE"
		echo "$PID1" >"$PID1_FILE"
		echo "$PID2" >"$PID2_FILE"
		echo "$PORT" >"$PORT_FILE"
		echo "$PORT"
	else
		stop_server
		echo ERROR
	fi
}


# kill the server process
stop_server() {
	if [[ -f "$PID2_FILE" ]]; then
		kill "$(cat "$PID2_FILE")" 2>/dev/null
	fi
	if [[ -f "$PID1_FILE" ]]; then
		kill "$(cat "$PID1_FILE")" 2>/dev/null
	fi
	rm -f "$PORT_FILE" "$COUNT_FILE" "$PID1_FILE" "$PID2_FILE"
}


# extract the server tarball
install_server() {
	# SERVER_COMMAND is in the format $HOME/.vscodium-server/bin/codium-reh-OS-VERSION/bin/codium-server
	SERVER_INSTALL_DIR="$(dirname "$(dirname "$SERVER_COMMAND")")"
	mkdir -p "$SERVER_INSTALL_DIR"
	exec tar -xz -C "$SERVER_INSTALL_DIR"
}


# first try to connect, if failed, then try to start new
# intended to be called holding a lock
connect_or_start_server() {
	PORT=$(connect_server)
	if [[ "$PORT" =~ ^[0-9]+$ ]]; then
		echo $PORT
	else
		start_server 10
	fi
}


# Command-line argument handling
case "$1" in
	connect)
		connect_server
		;;
	disconnect)
		disconnect_server "\${2:-0}"
		;;
	start)
		start_server "\${2:-10}"
		;;
	stop)
		stop_server
		;;
	connect-or-start)
		connect_or_start_server
		;;
	install)
		install_server
		;;
	-h|--help)
		echo "Usage: $0 {connect|disconnect|start|stop}"
		;;
	synchronized-connect)
		flock -o "$SESSION_DIR" "$0" connect
		;;
	synchronized-disconnect)
		sleep \${2:-5}
		flock -o "$SESSION_DIR" "$0" disconnect 0
		;;
	synchronized-start)
		flock -o "$SESSION_DIR" "$0" connect-or-start
		;;
	*)
		status
		;;
esac
`;
}

/**
 * the above class is stateful and slow to setup, I want the extension
 * activation be fast.
 */
class RemoteAuthorityResolver implements vscode.RemoteAuthorityResolver {

	constructor(
		public g: ExtensionGlobals,
	) {
	}

	async resolve(authority: string, _context: vscode.RemoteAuthorityResolverContext) {
		const logger = this.g.logger;
		logger.appendLine(`resolving ${authority}`);

		const [remote, guest_name_encoded] = authority.split('+', 2);
		console.assert(remote == "distrobox");
		const guest_name = decodeURIComponent(guest_name_encoded);
		const manager = await DistroManager.which();
		const guest = await manager.get(guest_name);
		const [os, arch] = await detect_platform(guest);
		logger.appendLine(`guest container: ${os}-${arch}`);

		// prepare the script
		const xdg_runtime_dir = (await guest.exec("bash", "-c", 'echo "$XDG_RUNTIME_DIR"')).stdout.trim();
		const server_session_dir = `${xdg_runtime_dir}/vscodium-reh-${system_identifier(os, arch)}-${guest.name}`;
		const control_script_path = `${server_session_dir}/control-${this.g.context.extension.packageJSON.version}.sh`;

		// first try it optimistically, to reduce startup latency
		let port = NaN;
		try {
			const output = await guest.exec(control_script_path, "synchronized-start");
			logger.appendLine(`first attempt output: ${output.stdout}`);
			port = parseInt(output.stdout);
		} catch (e) {
			logger.appendLine(`first attemp failed: ${e}`);
		}

		const server_command_path = `$HOME/${server_binary_path(os, arch)}`;
		const server_tarball_url = server_download_url(os, arch);

		// do it properly
		if (isNaN(port)) {
			logger.appendLine("preparing server control script");

			await guest.exec("mkdir", "-p", server_session_dir);
			await guest.write_to_file(
				control_script_path,
				get_control_script(server_command_path)
			);
			await guest.exec("chmod", "+x", control_script_path);

			logger.appendLine(`control script written to ${control_script_path}`);

			if (!guest.is_file(server_command_path)) {
				logger.appendLine("server not installed, start downloading");
				const buffer = await download_server_tarball(server_tarball_url);
				logger.appendLine("server downloaded, extracting");
				await guest.exec_with_input(buffer, control_script_path, "install");
				logger.appendLine("server installed");
			}

			const output = await guest.exec(control_script_path, "synchronized-start");
			port = parseInt(output.stdout);

			logger.appendLine(`second attempt output: ${output.stdout}`);
		}

		if (!isNaN(port)) {
			this.g.context.subscriptions.push(
				{
					dispose() {
						logger.appendLine(`disconnecting from remote server`);
						guest.exec(control_script_path, "synchronized-disconnect").child.unref();
					},
				},
				vscode.workspace.registerResourceLabelFormatter({
					scheme: 'vscode-remote',
					authority: 'distrobox+*',
					formatting: {
						label: "${path}",
						separator: "/",
						tildify: true,
						normalizeDriveLetter: false,
						workspaceSuffix: `distrobox: ${guest_name}`,
						workspaceTooltip: `Connected to ${guest_name}`
					}
				}),
				vscode.window.registerTreeDataProvider(
					"distrobox.server-info",
					new DetailsView(
						guest,
						os,
						arch,
						control_script_path,
						server_command_path,
						server_tarball_url,
						server_session_dir,
						port
					),
				)
			);
			return new vscode.ResolvedAuthority("localhost", port);
		}
		throw vscode.RemoteAuthorityResolverError.TemporarilyNotAvailable("failed to launch server in guest distro");
	}

	// distrobox guests share the host network, so port forwarding is just nop
	tunnelFactory(tunnelOptions: vscode.TunnelOptions, tunnelCreationOptions: vscode.TunnelCreationOptions): Thenable<vscode.Tunnel> | undefined {
		const host = tunnelOptions.remoteAddress.host;
		// this should be unnecessary, I'm just paranoid, just in case.
		if (host != "localhost"
			&& host != "127.0.0.1"
			&& host != "::1"
			&& host != "*"
			&& host != "0.0.0.0"
			&& host != "::") {
			this.g.logger.appendLine(`forwarding port for ${host}`);
			return undefined;
		}
		return new Promise((resolve, reject) => {
			const dispose_event = new vscode.EventEmitter<void>();
			resolve({
				remoteAddress: tunnelOptions.remoteAddress,
				protocol: tunnelOptions.protocol,
				localAddress: tunnelOptions.remoteAddress,
				onDidDispose: dispose_event.event,
				dispose() {
					dispose_event.fire();
					dispose_event.dispose;
				}
			});
		});
	}
}

export function register_distrobox_remote_authority_resolver(g: ExtensionGlobals) {

	g.context.subscriptions.push(
		vscode.workspace.registerRemoteAuthorityResolver("distrobox", new RemoteAuthorityResolver(g))
	);

}
