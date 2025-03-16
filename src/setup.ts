// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: (C) 2025 nerditation <nerditation@users.noreply.github.com>
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import { arch as node_arch } from "os";

import * as vscode from "vscode";

import { GuestDistro } from "./agent";
import { ExtensionGlobals } from "./extension";


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
export async function detect_platform(guest: GuestDistro): Promise<[string, string]> {
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
		const glibc_ld_path = ldd_info.match(/ld-linux-(.+).so/)!;
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
