// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: (C) 2025 nerditation <nerditation@users.noreply.github.com>
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import { arch as node_arch } from "os";

import * as vscode from "vscode";

import { GuestContainer } from "./agent";


/**
 * @module setup
 *
 * this module defines how to setup the server by running commands in the
 * container.
 */


/**
 * this function will try to "guess" the os and architecture for the guest.
 *
 * the official builds of `vscodium-reh` has two variants for linux, `alpine`
 * and `linux`. I'm lazy and I just check the libc, if its `musl`, I use
 * `alpine`, and if its `glibc`, I use `linux`. this is good enough for me.
 *
 * the glibc `ldd` support a command line flag `--version`, which print the
 * version information to **stdout**.
 *
 * on opensuse tumbleweed, the output looks like this:
 *
```text
ldd (GNU libc) 2.40
Copyright (C) 2024 Free Software Foundation, Inc.
This is free software; see the source for copying conditions.  There is NO
warranty; not even for MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
Written by Roland McGrath and Ulrich Drepper.
```
 *
 * on ubuntu lts, the output looks like this:
 *
```text
ldd (Ubuntu GLIBC 2.39-0ubuntu8.4) 2.39
Copyright (C) 2024 Free Software Foundation, Inc.
This is free software; see the source for copying conditions.  There is NO
warranty; not even for MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
Written by Roland McGrath and Ulrich Drepper.
```
 *
 * the musl `ldd` will always print a usage to *stderr* when called directly,
 * it does NOT understand the `--version` flag.
 *
 * here's the output on a alpine linux:
 *
```text
musl libc (x86_64)
Version 1.2.5
Dynamic Program Loader
Usage: /lib/ld-musl-x86_64.so.1 [options] [--] pathname
```
 *
 * I decided to use `ldd` because it's always available on every linux distro,
 * so potentially this can also be used for containers not managed by distrobox
 *
 */
export async function detect_platform(guest: GuestContainer): Promise<[string, string]> {
	let ldd_info;
	// musl'd ldd always have exit code "1" when invoked directly
	// promisified execFile will throw exception for non-zero exit code
	// but I don't care the exit code, as long the stdout is captured.
	try {
		ldd_info = (await guest.exec("bash", "-c", "ldd --version 2>&1")).stdout;
	} catch (e: any) {
		ldd_info = e.stdout;
	}
	const is_musl = ldd_info.match(/musl libc \((.+)\)/);
	let os = "linux", arch = node_arch();
	if (is_musl) {
		os = "alpine";
		arch = linux_arch_to_nodejs_arch(is_musl[1]);
	} else if (ldd_info.match(/Free Software Foundation/)) {
		// glibc's ldd doesn't show the archtecture name in the version info,
		// I decided to use the dynamic loader's name to find the architecture
		// can't use `uname`, since it returns the kernel's architecture,
		// but the container userland might be different, at least on x86,
		// for example, a x86_64 host can run i686 container.
		const ldd_info = (await guest.exec("ldd", "/bin/true")).stdout;
		// the output of ldd may look like this when the is dynamic linker resolved differently:
		//   `/lib64/ld-linux-x86-64.so.2 => /usr/lib64/ld-linux-x86-64.so.2 (0x00007faa96298000)`
		// I didn't know this because the systems I tested (opensuse and ubuntu) is like this:
		//   `/lib64/ld-linux-x86-64.so.2 (0x00007fce8f048000)`
		// the simple capture `(.+)` will greedily catpture extra stuff until the last `.so`
		// excluding the dot character from the capture should work around this issue.
		const glibc_ld_path = ldd_info.match(/ld-linux-([^.]+)\.so/)!;
		arch = linux_arch_to_nodejs_arch(glibc_ld_path[1]);
	} else {
		throw ("distro's libc is neither musl nor glibc");
	}
	return [os, arch];
}

/**
 * map the system's archtecture name to nodejs's equivalence
 */
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

/**
 * this function downloads the server tarball from the given url, with a
 * progress bar, returns a `Buffer`
 */
export async function download_server_tarball(url: string,): Promise<Buffer> {
	return vscode.window.withProgress({
		location: vscode.ProgressLocation.Notification,
		title: "downloading vscodium remote server",
	}, async (progress, candel) => {
		progress.report({
			message: "connecting to server..."
		});
		const downloader = await fetch(url);
		if (downloader.status != 200) {
			throw `${downloader.status} ${url}`;
		}
		const content_length_header = downloader.headers.get('Content-Length');
		let total_size;
		if (content_length_header) {
			total_size = parseInt(content_length_header, 10);
		}
		progress.report({
			message: "transferring data..."
		});
		const buffer: Uint8Array[] = [];
		for await (const chunk of downloader.body!) {
			const bytes = chunk as Uint8Array;
			if (total_size) {
				progress.report({
					increment: bytes.length * 100 / total_size
				});
			}
			buffer.push(bytes);
		}
		return Buffer.concat(buffer);
	});
}

/**
 * this is a bash script running in the guest container, which implements the
 * core functionalities to start and stop the server, and bookkeep some session
 * states.
 *
 * this script requires `bash` specifically, which is assumed to be installed
 * for distrobox managed containers by default. the script also uses certain
 * "essential" programs, which should also be guaranteed by `distrbox-init`,
 * see:
 *
 * https://github.com/89luca89/distrobox/blob/main/docs/posts/distrobox_custom.md#requirements
 *
 * but just for documentary purpose and also for the possibility if this extension
 * would be extended to general containers, not just distrbox, the list in current
 * implementation includes:
 *
 * - `ps` from `procps-ng`, to find pid of the vscodium remote server.
 *   - busybox is NOT enough, the `codium-server` command is a wrapper script,
 *     which launches the real server process (nodejs). when running the
 *     server without tty, sending signals to the shell process of the wrapper
 *     script does not kill the real server process. so I need the `ps` command
 *     to find the child process of the wrapper script
 * - `ss` from `iproute2`, to check server's tcp port is open
 * - regex utils like `grep` and `sed`
 *   - only need basic features, so busybox is good enough
 * - `xargs` from `findutils`, used as a `trim` function
 *   - alternatives exists so it is not required, I choose it because it's short
 * - `tar`, for server installation
 *   - currently the server tarball is `gzip` compressed, so busybox is ok
 * - common commands from `coreutils`, such as `cat`, `mkdir`, `nohup`, etc
 * - `flock` from `util-linux`, to synchronize potential concurrent access
 *   - busybox should also be ok.
 */
export function get_control_script(server_install_path: string, server_application_name: string) {
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
SERVER_INSTALL_DIR="${server_install_path}"
SERVER_COMMAND=$(find "$SERVER_INSTALL_DIR" -name "${server_application_name}")
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
		echo "socket: $(lsof -iTCP:$(cat "$PORT_FILE") -sTCP:LISTEN)"
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
		if [[ "$(lsof -iTCP:$(cat "$PORT_FILE") -sTCP:LISTEN  -t)" != "$(cat "$PID2_FILE")" ]]; then
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
		>"$LOG_FILE" \\
		2>&1 \\
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
	#SERVER_INSTALL_DIR="$(dirname "$(dirname "$SERVER_COMMAND")")"
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
