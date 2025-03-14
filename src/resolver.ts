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

import * as net from "net";

import * as vscode from 'vscode';
import { server_binary_path, server_download_url, server_extract_path, system_identifier } from './remote';
import { arch as node_arch } from 'os';
import { DistroManager, GuestDistro } from './agent';
import { once } from "events";
import { PromiseWithChild } from "child_process";
import { delay_millis } from "./utils";
import { disconnect } from "process";

const extension = vscode.extensions.getExtension("nerditation.open-remote-distrobox");

/**
 * this is the class that "does the actual work", a.k.a. business logic
 *
 * the name is not very descriptive, but I don't know what's better
 */
export class DistroboxResolver implements vscode.TreeDataProvider<string> {
	public server_port?: number;
	private constructor(
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
	public static async create(guest: GuestDistro): Promise<DistroboxResolver> {
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
		const control_script_path = `${server_session_dir}/control-${extension?.packageJSON.version}.sh`;
		const control_script = get_control_script(server_command_path);
		await guest.exec("mkdir", "-p", server_session_dir);
		await guest.write_to_file(control_script_path, control_script);
		await guest.exec("chmod", "+x", control_script_path);
		return new DistroboxResolver(
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
	 * pipe the tarball to a `tar` command running in the guest.
	 *
	 * since the data is downloaded from the internet, it's convenient to use
	 * an array of chunks as arguments.
	 *
	 * @param buffer raw bytes (in chunks) of the `gzip` compressed tarball
	 */
	public async extract_server_tarball(buffer: Uint8Array) {
		await this.guest.exec_with_input(buffer, this.control_script_path, "install");
	}

	/**
	 * download the server from the internet using the `fetch` API
	 *
	 * @returns the file contents in chunks of unspecified sizes
	 */
	public async download_server_tarball(): Promise<Uint8Array[]> {
		return vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: "downloading vscodium remote server",
		}, async (progress, candel) => {
			progress.report({
				message: "connecting to server..."
			});
			const downloader = await fetch(this.server_download_url);
			if (downloader.status != 200) {
				throw `${downloader.status} ${this.server_download_url}`;
			}
			// TODO: what if server didn't send `Content-Length` header?
			const total_size = parseInt((downloader.headers.get('Content-Length')!), 10);
			progress.report({
				message: "transferring data..."
			});
			const buffer: Uint8Array[] = [];
			for await (const chunk of downloader.body!) {
				const bytes = chunk as Uint8Array;
				progress.report({
					increment: bytes.length * 100 / total_size
				});
				buffer.push(bytes);
			}
			console.log("download successful");
			return buffer;
		});
	}

	/**
	 * try to start a new server process and find the port number
	 *
	 * @returns the `stdout` of the launch script, can be one of:
	 * - a tcp port number on success
	 * - "NOT INSTALLED", if the server binary is not installed
	 * - "ERROR", if failed to launch the server or find the port number
	 */
	public async try_start_new_server(): Promise<string> {
		const env = vscode.workspace.getConfiguration().get<Record<string, string | boolean>>("distroboxRemoteServer.launch.environment") ?? {};
		const commands = [];
		for (const name in env) {
			const value = env[name];
			if (typeof value == 'string') {
				commands.push(`${name}="${value}"`);
			} else if (value == true) {
				const local_value = process.env[name];
				if (local_value) {
					commands.push(`${name}="${local_value}"`);
				}
			}
		}
		return (await this.guest.exec(this.control_script_path, "synchronized-start")).stdout;
	}

	/**
	 * try to detect an running server and find the port number
	 *
	 * @returns the `stdout` of the shell script, can be one of:
	 * - a tcp port number, on success
	 * - "NOT RUNNING"
	 */
	public async find_running_server_port(): Promise<string> {
		return (await this.guest.exec(this.control_script_path, "synchronized-connect")).stdout;
	}

	/**
	 * check if the server is already installed
	 */
	public async is_server_installed(): Promise<boolean> {
		return await this.guest.is_file(this.server_command_path);
	}

	/**
	 * shutdown the server, will be called in `extension.deactivate()`
	 */
	public shutdown_server() {
		this.guest.exec(this.control_script_path, "synchronized-disconnect",).child.unref();
	}

	/**
	 * the full process to resolve the port number for the remote server
	 *
	 * this is called by `vscode.RemoteAuthorityResolver.resolve()`
	 */
	public async resolve_server_port(): Promise<number | undefined> {
		console.log(`resolving distrobox guest: ${this.guest.name}`);

		let port;
		const running_port = await this.find_running_server_port();
		console.log("running port", running_port);
		port = parseInt(running_port, 10);
		if (!isNaN(port)) {
			this.server_port = port;
			console.log(`running server listening at ${running_port}`);
			return port;
		}

		if (!await this.is_server_installed()) {
			const buffer: Uint8Array[] = await this.download_server_tarball();
			await this.extract_server_tarball(Buffer.concat(buffer));
		}

		const new_port = await this.try_start_new_server();
		console.log("new port", new_port);
		port = parseInt(new_port, 10);
		if (!isNaN(port)) {
			this.server_port = port;
			console.log(`new server started at ${new_port}`);
			return port;
		}
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

	async getChildren(element?: string | undefined): Promise<string[]> {
		if (element) {
			return [];
		} else {
			return [
				`guest name: ${this.guest.name}`,
				`guest os: ${this.guest_os}`,
				`guest architecture: ${this.guest_arch}`,
				"----------------",
				`server session directory: ${this.server_session_dir}`,
				`server path: ${this.server_command_path}`,
				`server port: ${this.server_port ?? "0"}`,
				`server pid (wrapper): ${(await this.guest.read_text_file(`${this.server_session_dir}/pid1`)).trim()}`,
				`server pid (node): ${(await this.guest.read_text_file(`${this.server_session_dir}/pid2`)).trim()}`,
				``
			];
		}
	}

	getTreeItem(element: string): vscode.TreeItem {
		return new vscode.TreeItem(element);
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
	nohup \
		"$SERVER_COMMAND" \
		--accept-server-license-terms \
		--telemetry-level off \
		--host localhost \
		--port 0 \
		--without-connection-token \
		2>&1 \
		>"$LOG_FILE" \
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
