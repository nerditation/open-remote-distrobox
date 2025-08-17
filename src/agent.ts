// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: (C) 2025 nerditation <nerditation@users.noreply.github.com>
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import * as cp from "child_process";
import * as vscode from "vscode";

import which = require("which");

import { EnterCommandBuilder, MainCommandBuilder } from "./distrobox";
import { promisify } from "util";

const execFile = promisify(cp.execFile);

/**
 * @module agent
 *
 * wrapper over "raw" distrobox command line builder
 *
 * this module sits in between vscodium API and distrobox abstraction layer
 *
 * this module abstracts away the `distrobox` specific details.
 *
 * ideally, the resolver should not depends on `distrobox` directly, and maybe
 * this can be extended to support general container managers besides distrbox,
 * possibly even implement the `connected-container` remote authority by the
 * microsoft devcontainers extension.
 */


/**
 * an abstraction for the `distrobox` command, may change this to an interface.
 *
 * to enable the possibility to replace with different container manager in
 * the future, e.g. it should be possible to use `podman` directly.
 *
 * but I don't plan to do it since I don't really have the need.
 */
export class ContainerManager {

	private constructor(
		public cmd: MainCommandBuilder,
	) {
	}

	/**
	 * try to automatically find out how to invoke `distrobox` command
	 *
	 * currently these heuristics are used, in this order:
	 * - if there's a `distrobox` command in `$PATH`, then use it
	 * - if inside a flatpak sandbox, try `flatpak-spawn --host distrbox`
	 * - if inside a distrobox guest, use `distrobox-host-exec distrobox`
	 */
	public static async which(logger: vscode.LogOutputChannel): Promise<ContainerManager> {
		const with_argv = (...argv: string[]) => {
			return new ContainerManager(new MainCommandBuilder(...argv));
		};
		try {
			const distrobox_path = await which('distrobox');
			logger.appendLine(`found distrobox: ${distrobox_path}`);
			return with_argv(distrobox_path);
		} catch {
			logger.appendLine("local distrobox not found");
		}
		try {
			const host_spawn_path = await which('host-spawn');
			logger.appendLine(`inside container with host-spawn: ${host_spawn_path}`);
			const banner = await new Promise<string>((resolve, reject) => {
				cp.execFile(
					host_spawn_path,
					['distrobox', '--version'],
					(error, stdout) => {
						if (error) {
							reject(error);
						} else {
							resolve(stdout);
						}
					});
			});
			logger.appendLine(`found distrobox on container host: ${banner}`);
			return with_argv(host_spawn_path, "--no-pty", "distrobox");
		} catch {
			logger.appendLine("didn't find distrobox with host-spawn");
		}
		try {
			const flatpak_spawn_path = await which('flatpak-spawn');
			logger.appendLine(`inside flatpak sandbox: ${flatpak_spawn_path}`);
			const banner = await new Promise<string>((resolve, reject) => {
				cp.execFile(
					flatpak_spawn_path,
					['--host', 'distrobox', '--version'],
					(error, stdout) => {
						if (error) {
							reject(error);
						} else {
							resolve(stdout);
						}
					});
			});
			logger.appendLine(`found distrobox on flatpak host: ${banner}`);
			return with_argv(flatpak_spawn_path, '--host', 'distrobox');
		} catch {
			logger.appendLine("didn't find distrobox on flatpak host");
		}
		try {
			const distrobox_host_exec_path = await which('distrobox-host-exec');
			logger.appendLine(`inside distrobox guest: ${distrobox_host_exec_path}`);
			return with_argv(distrobox_host_exec_path, 'distrobox');
		} catch {
			logger.appendLine("not inside distrobox guest");
		}
		throw ("didn't find distrobox command");
	}

	/**
	 * encapsulate the `distrbox list` command
	 */
	public async refresh_guest_list(): Promise<GuestContainer[]> {
		const { stdout } = await this.cmd.list().exec();
		const lines = stdout.split("\n").filter(line => line != "");
		const header = lines.shift()!;
		// just a quick check in case different version of `distrobox` changed columns
		const column_names = header.split("|").map(s => s.trim());
		const expected_columns = ["ID", "NAME", "STATUS", "IMAGE"];
		column_names.every((column, i) => console.assert(column == expected_columns[i]));
		return lines.map((line) => {
			const [id, name, _status, image] = line.split("|").map(s => s.trim());
			return new GuestContainer(this.cmd.enter(name).no_tty().no_workdir(), id, name, image);
		});
	}

	/**
	 * get a `GuestDistro` by its `name`
	 */
	public async get(name: string): Promise<GuestContainer> {
		const guest = (await this.refresh_guest_list()).find(guest => guest.name == name);
		if (!guest) {
			throw `distro "${name}" does not exist`;
		}
		return guest;
	}
}

/**
 * information about a specific guest container,
 *
 * this type is an abstraction of primitive operations needed to setup the
 * vscodium remote server.
 *
 * in theory, the absolute minimal requirement is the ability to run commands
 * in the guest container and access to the `stdin` and `stdout` of the commands.
 *
 * currently, most functionality is implemented in a bash script, which is
 * written to the container.
 */
export class GuestContainer {
	// fields corresponding to the columns of the output of `distrobox list`
	// TODO:
	//   the `status` field doesn't update, which is not useful,
	//   make it private for now. maybe parse it properly in the future
	constructor(
		private cmd: EnterCommandBuilder,
		public readonly id: string,
		public readonly name: string,
		public readonly image: string,
	) {
	}

	/**
	 * a primitive to write to the given path and set the executable permission
	 *
	 * this is used to write the server control bash script to the container
	 */
	public write_executable_file(path: string, data: string | Uint8Array) {
		// need bash for redirection, and variable expansion, such as "$XDG_RUNTIME_DIR"
		return this.exec_with_input(data, "bash", "-c", `mkdir -p "$(dirname "${path}")" && cat >"${path}" && chmod +x "${path}"`);
	}

	/**
	 * a primitive to read the content of the given file as utf8 text
	 *
	 * this is unnecessary to setup the remote server and resolve the authority,
	 * it's currently used for the details view
	 */
	public read_text_file(path: string): Promise<string> {
		return this.exec("bash", "-c", `cat "${path}"`).then(output => output.stdout);
	}

	/**
	 * a primitive to check if the given file exist
	 *
	 * this is used to decide whether the server is already installed.
	 *
	 * technically this is unnecessary, as long we can execute command in the
	 * container.
	 */
	public async is_file(path: string): Promise<boolean> {
		const output = await this.exec("bash", "-c", `if [[ -f "${path}" ]]; then echo true; else echo false; fi`);
		return output.stdout.trim() == "true";
	}

	/**
	 * execute command `find $path -name $name`
	 *
	 * `findutils` is installed by distrobox
	 */
	public async find_file_by_name(path: string, name: string): Promise<string> {
		try {
			const output = await this.exec("bash", "-c", `find "${path}" -name "${name}"`);
			return output.stdout.trim()
		} catch {
			return ""
		}
	}

	/**
	 * exec: run the command in the guest container using `distrobox enter`
	 *
	 * just a wrapper for promisified `child_process.execFile`
	 *
	 * the return type has a `child` field, if you await on it, it resolves
	 * to a struct { stdout: string, stderr: string }
	 */
	public exec(...command: string[]) {
		const argv = this.cmd.args(...command).build();
		const argv0 = argv.shift()!;
		const promise = execFile(argv0, argv);
		return promise;
	}

	/**
	 * exec_with_input: similar to `exec`, but send `input` to `stdin`
	 *
	 * in theory, this is the absolute minimum requirement for the container
	 * manager. as long we can run command inside the container, and pipe
	 * data to its `stdin` and from its `stdout`, (assuming the container
	 * is running a basic linux distribution), everthing else can be implemented
	 * on top of this.
	 */
	public exec_with_input(input: string | Uint8Array, ...command: string[]) {
		const argv = this.cmd.args(...command).build();
		const argv0 = argv.shift()!;
		const promise = execFile(argv0, argv);
		promise.child.stdin?.end(input);
		return promise;
	}
}
