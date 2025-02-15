// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: (C) 2025 nerditation <nerditation@users.noreply.github.com>
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import * as vscode from 'vscode'
import * as dbx from './distrobox'
import { server_binary_path, server_download_url, server_extract_path, system_identifier } from './remote';

export class DistroboxResolver {
	cmd: dbx.MainCommandBuilder;
	name: string;
	os: string = "linux";
	arch: string = require("os").arch();

	private constructor(cmd: dbx.MainCommandBuilder, name: string) {
		this.cmd = cmd;
		this.name = name;
	}

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
			throw ("distro's libc is neither musl nor glibc")
		}
		return resolver
	}

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

	public async download_server_tarball() {
		const { os, arch } = this;
		const downloader = await fetch(server_download_url(os, arch));
		// TODO: what if server didn't send `Content-Length` header?
		const total_size = parseInt((downloader.headers.get('Content-Length')!), 10);
		let buffer: Uint8Array[] = [];
		await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: "downloading vscodium-reh",
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

	public async try_start_new_server() {
		const { cmd, name, os, arch } = this;
		const output = await cmd.enter(name, "bash").pipe(
			`
			RUN_DIR=$XDG_RUNTIME_DIR/vscodium-reh-${system_identifier(os, arch)}-${name}
			LOG_FILE=$RUN_DIR/log
			PID_FILE=$RUN_DIR/pid
			PORT_FILE=$RUN_DIR/port
			COUNT_FILE=$RUN_DIR/count

			SERVER_FILE=$HOME/${server_binary_path(os, arch)}

			# open lock file
			exec 200> $LOCK_FILE

			# enter critical section
			flock -x 200

			if [[ -f $SERVER_FILE ]]; then
				mkdir -p $RUN_DIR
				nohup $SERVER_FILE --accept-server-license-terms --telemetry-level off --host localhost --port 0 --without-connection-token > $LOG_FILE &
				echo $! > $PID_FILE

				for i in {1..5}; do
					# alpine doesn't have gnu grep, Perl regex is not supported by busybox
					#LISTENING_ON="$(grep -oP '(?<=Extension host agent listening on )\\d+' $LOG_FILE)"
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
					echo ERROR
				fi
			else
				echo NOT INSTALLED
			fi
			`
		);
		return new TextDecoder('utf8').decode(output)
	}

	public async find_running_server_port() {
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
		return new TextDecoder('utf8').decode(output)
	}

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
		return new TextDecoder('utf8').decode(output).trim() == "true"
	}

	/**
	 * stop
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
				kill $(cat $PID_FILE)
				rm -f $PORT_FILE $PID_FILE $COUNT_FILE
			fi
			`
		);
	}
}

function linux_arch_to_nodejs_arch(arch: string): string {
	// TODO:
	// I don't have arm system to test
	switch (arch) {
		case "x86_64":
		case "x86-64":
		case "amd64":
			return "x64";
		case "i386":
		case "i686":
			return "ia32";
		default:
			throw (`TODO linux arch ${arch}`)
			return arch;
	}
}
