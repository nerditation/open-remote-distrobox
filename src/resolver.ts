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
import * as dbx from './distrobox';
import { server_binary_path, server_download_url, server_extract_path, system_identifier } from './remote';
import { arch } from 'os';

/**
 * this is the class that "does the actual work", a.k.a. business logic
 *
 * the name is not very descriptive, but I don't know what's better
 */
export class DistroboxResolver {
	cmd: dbx.MainCommandBuilder;
	name: string;
	os: string = "linux";
	arch: string = arch();

	private constructor(cmd: dbx.MainCommandBuilder, name: string) {
		this.cmd = cmd;
		this.name = name;
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
	public static async for_guest_distro(cmd: dbx.MainCommandBuilder, name: string): Promise<DistroboxResolver> {
		const resolver = new DistroboxResolver(cmd, name);
		const { stdout: ldd_info, stderr: ldd_info_err } = await cmd.enter(name, "ldd", "--version").exec();
		// `lsb_release` might not be installed on alpine
		// I just check for the `musl` libc, which is the libc used by `alpine`
		// I could also check `/etc/os-release` too, but it's good enough for me.
		const is_musl = ldd_info_err.match(/musl libc \((.+)\)/);
		if (is_musl) {
			resolver.os = "alpine";
			resolver.arch = linux_arch_to_nodejs_arch(is_musl[1]);
		} else if (ldd_info.match(/GNU libc/)) {
			// glibc's ldd doesn't show the archtecture, need probe further
			// can't use `uname`, 32 bit guests can run on 64 bit host
			const { stdout: ldd_info } = await cmd.enter(name, "ldd", "/bin/sh").exec();
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
		const { cmd, name, os, arch } = this;
		const path = server_extract_path(os, arch);
		await cmd.enter(
			name,
			"mkdir",
			"-p",
			`${path}`
		)
			.no_workdir()
			.exec();
		const tar = cmd.enter(
			name,
			"tar",
			"-xz",
			"-C",
			`${path}`
		)
			.no_tty()
			.no_workdir()
			.spawn({
				stdio: ['pipe', 'inherit', 'inherit']
			});
		for (const chunk of buffer) {
			await new Promise<void>((resolve, reject) => {
				tar.stdin?.write(chunk, (err) => {
					if (err) {
						reject(err);
					} else {
						resolve();
					}
				});
			});
		}
		await new Promise<void>((resolve, reject) => tar.stdin?.end(resolve));
	}

	/**
	 * download the server from the internet using the `fetch` API
	 *
	 * @returns the file contents in chunks of unspecified sizes
	 */
	public async download_server_tarball(): Promise<Uint8Array[]> {
		const { os, arch } = this;
		const downloader = await fetch(server_download_url(os, arch));
		if (downloader.status != 200) {
			throw `${downloader.status} ${server_download_url(os, arch)}`;
		}
		// TODO: what if server didn't send `Content-Length` header?
		const total_size = parseInt((downloader.headers.get('Content-Length')!), 10);
		const buffer: Uint8Array[] = [];
		await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: "downloading vscodium remote server",
		}, async (progress, candel) => {
			for await (const chunk of downloader.body!) {
				const bytes = chunk as Uint8Array;
				progress.report({
					increment: bytes.length * 100 / total_size
				});
				buffer.push(bytes);
			}
		});
		console.log("download successful");
		return buffer;
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
		const { cmd, name, os, arch } = this;
		const output = await cmd.enter(name, "bash").pipe(
			`
			RUN_DIR=$XDG_RUNTIME_DIR/vscodium-reh-${system_identifier(os, arch)}-${name}
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
		return new TextDecoder('utf8').decode(output);
	}

	/**
	 * try to detect an running server and find the port number
	 *
	 * @returns the `stdout` of the shell script, can be one of:
	 * - a tcp port number, on success
	 * - "NOT RUNNING"
	 */
	public async find_running_server_port(): Promise<string> {
		const { cmd, name, os, arch } = this;
		const output = await cmd.enter(name, "bash").pipe(
			`
			RUN_DIR=$XDG_RUNTIME_DIR/vscodium-reh-${system_identifier(os, arch)}-${name}
			LOCK_FILE=$RUN_DIR/lock
			COUNT_FILE=$RUN_DIR/count
			PORT_FILE=$RUN_DIR/port

			# open lock file
			exec 200> $LOCK_FILE

			# enter critical section
			flock -x 200

			if [[ -f $PORT_FILE ]]; then
				count=$(cat $COUNT_FILE)
				count=$(($count + 1))
				echo $count > $COUNT_FILE
				cat $PORT_FILE
			else
				echo NOT RUNNING;
			fi
			`
		);
		return new TextDecoder('utf8').decode(output);
	}

	/**
	 * check if the server is already installed
	 */
	public async is_server_installed(): Promise<boolean> {
		const { cmd, name, os, arch } = this;
		const output = await cmd.enter(name, "bash").pipe(

			`
			SERVER_FILE=$HOME/${server_binary_path(os, arch)}
			if [[ -f $SERVER_FILE ]]; then
				echo true
			else
				echo false
			fi
			`
		);
		return new TextDecoder('utf8').decode(output).trim() == "true";
	}

	/**
	 * shutdown the server, will be called in `extension.deactivate()`
	 */
	public async shutdown_server() {
		const { cmd, name, os, arch } = this;
		await cmd.enter(name, "bash").pipe(
			`
			RUN_DIR=$XDG_RUNTIME_DIR/vscodium-reh-${system_identifier(os, arch)}-${name}
			LOCK_FILE=$RUN_DIR/lock
			COUNT_FILE=$RUN_DIR/count
			PORT_FILE=$RUN_DIR/port
			PID_FILE=$RUN_DIR/pid

			# open lock file
			exec 200> $LOCK_FILE

			# enter critical section
			flock -x 200

			count=$(cat $COUNT_FILE)
			count=$(($count - 1))
			echo $count > $COUNT_FILE

			if [[ $count -eq 0 ]]; then
				kill $(ps --ppid $(cat $PID_FILE) -o pid=)
				rm -f $PORT_FILE $PID_FILE $COUNT_FILE
			fi
			`
		);
	}

	/**
	 * the full process to resolve the port number for the remote server
	 *
	 * this is called by `vscode.RemoteAuthorityResolver.resolve()`
	 */
	public async resolve_server_port(): Promise<number | undefined> {
		console.log(`resolving distrobox guest: ${this.name}`);

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
}

function linux_arch_to_nodejs_arch(arch: string): string {
	// TODO:
	// I don't have arm system to test
	// arm stuff stolen from `open-remote-wsl`
	// https://github.com/jeanp413/open-remote-wsl/blob/20824d50a3346f5fbd7875d3319a1445d8dc1c1e/src/serverSetup.ts#L192
	switch (arch) {
		case "x86_64":
		case "x86-64":
		case "amd64":
			return "x64";
		case "i386":
		case "i686":
			return "ia32";
		case "armv7l":
		case "armv8l":
			return "armhf";
		case "arm64":
		case "aarch64":
			return "arm64";
		default:
			throw (`TODO linux arch ${arch}`);
			return arch;
	}
}
