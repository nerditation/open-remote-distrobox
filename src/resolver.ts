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
import { arch } from 'os';
import { DistroManager, GuestDistro } from './agent';

/**
 * this is the class that "does the actual work", a.k.a. business logic
 *
 * the name is not very descriptive, but I don't know what's better
 */
export class DistroboxResolver {
	guest: GuestDistro;
	os: string = "linux";
	arch: string = arch();

	private constructor(guest: GuestDistro) {
		this.guest = guest;
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
	public static async for_guest_distro(guest: GuestDistro): Promise<DistroboxResolver> {
		const resolver = new DistroboxResolver(guest);
		const { stdout: ldd_info, stderr: ldd_info_err } = await guest.exec("ldd", "--version");
		// `lsb_release` might not be installed on alpine
		// I just check for the `musl` libc, which is the libc used by `alpine`
		// I could also check `/etc/os-release` too, but it's good enough for me.
		const is_musl = ldd_info_err.match(/musl libc \((.+)\)/);
		if (is_musl) {
			resolver.os = "alpine";
			resolver.arch = linux_arch_to_nodejs_arch(is_musl[1]);
		} else if (ldd_info.match(/Free Software Foundation/)) {
			// glibc's ldd doesn't show the archtecture, need probe further
			// can't use `uname`, 32 bit guests can run on 64 bit host
			const { stdout: ldd_info } = await guest.exec("ldd", "/bin/sh");
			const glibc_ld_path = ldd_info.match(/\/lib(64)?\/ld-linux-(.+).so/)!;
			resolver.arch = linux_arch_to_nodejs_arch(glibc_ld_path[2]);
		} else {
			throw ("distro's libc is neither musl nor glibc");
		}
		return resolver;
	}

	/**
	 * pipe the tarball to a `tar` command running in the guest.
	 *
	 * since the data is downloaded from the internet, it's convenient to use
	 * an array of chunks as arguments.
	 *
	 * @param buffer raw bytes (in chunks) of the `gzip` compressed tarball
	 */
	public async extract_server_tarball(buffer: Uint8Array[]) {
		const { guest, os, arch } = this;
		const path = server_extract_path(os, arch);
		const out = await guest.spawn_2("bash", "-c", `mkdir -p "${path}"; tar -xz -C "${path}"`).pipe(Buffer.concat(buffer));
		console.log(out);
	}

	/**
	 * download the server from the internet using the `fetch` API
	 *
	 * @returns the file contents in chunks of unspecified sizes
	 */
	public async download_server_tarball(): Promise<Uint8Array[]> {
		const { os, arch } = this;
		return vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: "downloading vscodium remote server",
		}, async (progress, candel) => {
			progress.report({
				message: "connecting to server..."
			});
			const downloader = await fetch(server_download_url(os, arch));
			if (downloader.status != 200) {
				throw `${downloader.status} ${server_download_url(os, arch)}`;
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

	public async try_start_new_server(): Promise<string> {
		const guest = this.guest;
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
		const run_dir = `$XDG_RUNTIME_DIR/vscodium-reh-${system_identifier(this.os, this.arch)}-${guest.name}`;
		const locker = guest.spawn_2("bash");
		locker.write(`mkdir -p "${run_dir}"\n`);
		locker.write(`exec 200>"${run_dir}/lock"\n`);
		console.log(await locker.pipe_command("flock -x 200; echo locked\n"));

		commands.push(
			"mkdir",
			"-p",
			`"${run_dir}"`,
			";",
			"exec",
			"nohup",
			`$HOME/${server_binary_path(this.os, this.arch)}`,
			"--accept-server-license-terms",
			"--telemetry-level off",
			"--host localhost",
			"--port 0",
			"--without-connection-token",
			`>"${run_dir}/log"`,
		);
		const pid = await guest.exec_text("bash", "-c", `(echo $BASHPID; ${commands.join(' ')})&`);
		console.log(pid);
		let port;
		for (let i = 0; i < 5; ++i) {
			const output = await guest.read_text_file(`${run_dir}/log`);
			const match = output.match(/Extension host agent listening on ([0-9]+)/);
			if (match) {
				port = match[1];
				break;
			}
		}
		if (port) {
			await guest.write_to_file(`${run_dir}/pid`, `${pid}`);
			await guest.write_to_file(`${run_dir}/count`, "1");
			await guest.write_to_file(`${run_dir}/port`, port);
		} else {
			const subpid = await guest.exec_text("ps", "--ppid", `${pid}`, "-o", "pid=");
			await guest.exec_text("kill", subpid);
			await guest.exec_text("kill", `${pid}`);
			port = "ERROR";
		}
		console.log(await locker.finish("flock -u 200; echo unlocked\n"));
		return port;
	}

	/**
	 * try to start a new server process and find the port number
	 *
	 * @returns the `stdout` of the launch script, can be one of:
	 * - a tcp port number on success
	 * - "NOT INSTALLED", if the server binary is not installed
	 * - "ERROR", if failed to launch the server or find the port number
	 */
	public async try_start_new_server_(): Promise<string> {
		const { guest, os, arch } = this;
		const env = vscode.workspace.getConfiguration().get<Record<string, string | boolean>>("distroboxRemoteServer.launch.environment") ?? {};
		const export_commands = [];
		for (const name in env) {
			const value = env[name];
			if (typeof value == 'string') {
				export_commands.push(`export ${name}="${value}"`);
			} else if (value == true) {
				const local_value = process.env[name];
				if (local_value) {
					export_commands.push(`export ${name}="${local_value}"`);
				}
			}
		}
		console.log("exported env for remote server: ", export_commands);
		const { stdout: output } = await guest.run_bash_script(
			`
			RUN_DIR=$XDG_RUNTIME_DIR/vscodium-reh-${system_identifier(os, arch)}-${guest.name}
			LOG_FILE=$RUN_DIR/log
			PID_FILE=$RUN_DIR/pid
			PORT_FILE=$RUN_DIR/port
			COUNT_FILE=$RUN_DIR/count

			SERVER_FILE=$HOME/${server_binary_path(os, arch)}

			mkdir -p $RUN_DIR

			# open lock file
			exec 200> $LOCK_FILE

			# enter critical section
			flock -x 200

			if [[ -f $SERVER_FILE ]]; then
				${export_commands.join('\n')}
				nohup \
					$SERVER_FILE \
					--accept-server-license-terms \
					--telemetry-level off \
					--host localhost \
					--port 0 \
					--without-connection-token \
					> $LOG_FILE \
					&
				echo $! > $PID_FILE

				for i in {1..5}; do
					LISTENING_ON=$(sed -n 's/.*Extension host agent listening on \\([0-9]\\+\\).*/\\1/p' $LOG_FILE)
					if [[ -n $LISTENING_ON ]]; then
						break
					fi
					sleep 0.5
				done

				if [[ -n $LISTENING_ON ]]; then
					echo "1" > $COUNT_FILE
					echo $LISTENING_ON | tee $PORT_FILE
				else
					kill $(cat $PID_FILE)
					echo ERROR
				fi
			else
				echo NOT INSTALLED
			fi
			`
		);
		return output;
	}

	public async find_running_server_port(): Promise<string> {
		const guest = this.guest;
		const run_dir = `$XDG_RUNTIME_DIR/vscodium-reh-${system_identifier(this.os, this.arch)}-${guest.name}`;
		const locker = guest.spawn_2("bash");
		locker.write(`mkdir -p "${run_dir}"\n`);
		locker.write(`exec 200>"${run_dir}/lock"\n`);
		console.log(await locker.pipe_command("flock -x 200; echo locked\n"));
		try {
			const port_line = await guest.read_text_file(`${run_dir}/port`);
			console.log(port_line);
			const port = parseInt(port_line, 10);
			const socket = new net.Socket();
			socket.setTimeout(2000);
			const can_connect = await new Promise<boolean>((resolve, reject) => {
				socket.on('connect', () => {
					console.log(`Connected to ${port} - Port is open`);
					socket.destroy();
					resolve(true);
				});
				socket.on('timeout', () => {
					console.log(`Connection to ${port} timed out - Port is closed`);
					socket.destroy();
					resolve(false);
				});
				socket.on('error', (err) => {
					console.log(`Error connecting to ${port} - Port is closed (${err.message})`);
					resolve(false);
				});
				socket.connect(port, "localhost");
			});
			if (can_connect) {
				const count = parseInt(await guest.read_text_file(`${run_dir}/count`), 10);
				console.log(count);
				await guest.write_to_file(`${run_dir}/count`, `${count + 1}`);
				await locker.pipe_command("flock -u 200; echo unlocked\n");
				return port_line;
			} else {
				await locker.finish("flock -u 200; echo unlocked\n");
				return "NOT RUNNING";
			}
		} catch (e) {
			console.log("port file not found");
			await locker.finish("flock -u 200; echo unlocked\n");
			return "NOT RUNNING";
		}
	}

	/**
	 * try to detect an running server and find the port number
	 *
	 * @returns the `stdout` of the shell script, can be one of:
	 * - a tcp port number, on success
	 * - "NOT RUNNING"
	 */
	public async find_running_server_port_(): Promise<string> {
		const { guest, os, arch } = this;
		const { stdout: output } = await guest.run_bash_script(
			`
			RUN_DIR=$XDG_RUNTIME_DIR/vscodium-reh-${system_identifier(os, arch)}-${guest.name}
			LOCK_FILE=$RUN_DIR/lock
			COUNT_FILE=$RUN_DIR/count
			PORT_FILE=$RUN_DIR/port

			# open lock file
			exec 200> $LOCK_FILE

			# enter critical section
			flock -x 200

			if [[ -f $PORT_FILE ]]; then
				if [[ -z "$(ss -tln | grep :$(cat $PORT_FILE))" ]]; then
					kill $(ps --ppid $(cat $PID_FILE) -o pid=)
					kill $(cat $PID_FILE)
					rm -f $PORT_FILE $PID_FILE $COUNT_FILE
					echo STALE
				else
					count=$(cat $COUNT_FILE)
					count=$(($count + 1))
					echo $count > $COUNT_FILE
					cat $PORT_FILE
				fi
			else
				echo NOT RUNNING;
			fi
			`
		);
		return output;
	}

	public async is_server_installed(): Promise<boolean> {
		return await this.guest.is_file(`$HOME/${server_binary_path(this.os, this.arch)}`);
	}

	/**
	 * check if the server is already installed
	 */
	public async is_server_installed_(): Promise<boolean> {
		const { guest, os, arch } = this;
		const { stdout: output } = await guest.run_bash_script(
			`
			SERVER_FILE=$HOME/${server_binary_path(os, arch)}
			if [[ -f $SERVER_FILE ]]; then
				echo true
			else
				echo false
			fi
			`
		);
		return output.trim() == "true";
	}

	public async shutdown_server() {
		const guest = this.guest;
		const run_dir = `$XDG_RUNTIME_DIR/vscodium-reh-${system_identifier(this.os, this.arch)}-${guest.name}`;
		const child = guest.spawn_2(
			"bash",
			"-c",
			`cd "${run_dir}"; sleep 10; flock "./lock" -c 'count=$(($(cat ./count) - 1)); echo "$count" >./count; if [[ "$count" -eq 0 ]]; then pid=$(cat ./pid); kill $(ps --ppid "$pid" -o pid=); kill $"pid"; rm -f port count pid; fi'`
		);
		child.child.unref();
	}

	/**
	 * shutdown the server, will be called in `extension.deactivate()`
	 */
	public async shutdown_server_() {
		const { guest, os, arch } = this;
		await guest.run_bash_script_detached(
			`
			RUN_DIR=$XDG_RUNTIME_DIR/vscodium-reh-${system_identifier(os, arch)}-${guest.name}
			LOCK_FILE=$RUN_DIR/lock
			COUNT_FILE=$RUN_DIR/count
			PORT_FILE=$RUN_DIR/port
			PID_FILE=$RUN_DIR/pid

			exec 1>&-
			sleep 5

			# open lock file
			exec 200> $LOCK_FILE

			# enter critical section
			flock -x 200

			count=$(cat $COUNT_FILE)
			count=$(($count - 1))
			echo $count > $COUNT_FILE

			if [[ $count -eq 0 ]]; then
				kill $(ps --ppid $(cat $PID_FILE) -o pid=)
				kill $(cat $PID_FILE)
				rm -f $PORT_FILE $PID_FILE $COUNT_FILE
			fi
			`,
		);
	}

	/**
	 * the full process to resolve the port number for the remote server
	 *
	 * this is called by `vscode.RemoteAuthorityResolver.resolve()`
	 */
	public async resolve_server_port(): Promise<number | undefined> {
		console.log(`resolving distrobox guest: ${this.guest.name}`);

		const running_port = parseInt((await this.find_running_server_port()), 10);
		if (!isNaN(running_port)) {
			console.log(`running server listening at ${running_port}`);
			return running_port;
		}

		if (!await this.is_server_installed()) {
			const buffer: Uint8Array[] = await this.download_server_tarball();
			await this.extract_server_tarball(buffer);
		}

		const new_port = parseInt((await this.try_start_new_server()), 10);
		if (!isNaN(new_port)) {
			console.log(`new server started at ${new_port}`);
			return new_port;
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
		const { guest, os, arch } = this;
		await guest.run_bash_script(
			`
			RUN_DIR=$XDG_RUNTIME_DIR/vscodium-reh-${system_identifier(os, arch)}-${guest.name}
			LOCK_FILE=$RUN_DIR/lock
			COUNT_FILE=$RUN_DIR/count
			PORT_FILE=$RUN_DIR/port
			PID_FILE=$RUN_DIR/pid

			# open lock file
			exec 200> $LOCK_FILE

			# enter critical section
			flock -x 200

			kill $(ps --ppid $(cat $PID_FILE) -o pid=)
			kill $(cat $PID_FILE)
			rm -f $PORT_FILE $PID_FILE $COUNT_FILE
			`,
		);

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

export class ServerInformation implements vscode.TreeDataProvider<string> {

	constructor(
		private guest_name: string,
		private guest_os: string,
		private guest_arch: string,

		private server_runtime_directory: string,
		private server_path: string,
		private server_port: number,
		private server_pid1: number,
		private server_pid2: number,
	) {
	}

	static async from(resolver: DistroboxResolver): Promise<ServerInformation> {
		const { guest, os, arch } = resolver;
		const output = await guest.spawn_piped("bash")(
			`
			RUN_DIR="$XDG_RUNTIME_DIR/vscodium-reh-${system_identifier(os, arch)}-${guest.name}"
			echo $RUN_DIR
			echo "$HOME/${server_binary_path(os, arch)}"
			cat $RUN_DIR/port
			cat $RUN_DIR/pid
			ps --ppid $(cat $RUN_DIR/pid) -o pid=
			`
		);
		const [
			server_runtime_directory,
			server_path,
			server_port,
			server_pid1,
			server_pid2,
		] = output.split('\n');

		return new ServerInformation(
			guest.name,
			os,
			arch,

			server_runtime_directory,
			server_path,
			parseInt(server_port, 10)!,
			parseInt(server_pid1, 10)!,
			parseInt(server_pid2, 10)!
		);
	}

	async getChildren(element?: string | undefined): Promise<string[]> {
		if (element) {
			return [];
		} else {
			return [
				`guest name: ${this.guest_name}`,
				`guest os: ${this.guest_os}`,
				`guest architecture: ${this.guest_arch}`,
				"----------------",
				`server runtime directory: ${this.server_runtime_directory}`,
				`server path: ${this.server_path}`,
				`server port: ${this.server_port}`,
				`server pid (wrapper): ${this.server_pid1}`,
				`server pid (node): ${this.server_pid2}`,
				``
			];
		}
	}

	getTreeItem(element: string): vscode.TreeItem {
		return new vscode.TreeItem(element);
	}
}
