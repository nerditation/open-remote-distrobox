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
 * represents the main `distrobox` command
 *
 * I call it distro manager, similar to "container manager" like `podman`
 */
export class DistroManager {

	public cached_guest_list: GuestDistro[] = [];

	private constructor(
		private cmd: MainCommandBuilder,
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
	public static async which(): Promise<DistroManager> {
		return new DistroManager(await MainCommandBuilder.auto());
	}

	/**
	 * encapsulate the `distrbox list` command
	 */
	public async refresh_guest_list(): Promise<GuestDistro[]> {
		const { stdout } = await this.cmd.list().exec();
		const lines = stdout.split("\n").filter(line => line != "");
		const header = lines.shift()!;
		// just a quick check in case different version of `distrobox` changed columns
		const column_names = header.split("|").map(s => s.trim());
		const expected_columns = ["ID", "NAME", "STATUS", "IMAGE"];
		column_names.every((column, i) => console.assert(column == expected_columns[i]));
		this.cached_guest_list = lines.map((line) => {
			const [id, name, status, image] = line.split("|").map(s => s.trim());
			return new GuestDistro(this.cmd.enter(name).no_workdir(), id, name, status, image);
		});
		return this.cached_guest_list;
	}

	/**
	 * encapsulate the `distrobox rm` command
	 */
	public async delete(name: string, flags?: {
		force?: boolean,
		rm_home?: boolean,
		verbose?: boolean,
	}): Promise<{ exit_code?: string | number, stdout: string, stderr: string }> {
		const cmd_builder = this.cmd.rm(name);
		if (flags?.force) {
			cmd_builder.force();
		}
		if (flags?.rm_home) {
			cmd_builder.rm_home();
		}
		if (flags?.verbose) {
			cmd_builder.verbose();
		}
		return cmd_builder.exec();
	}

	/**
	 * a wrapper for `distrobox create --compatibility` command
	 */
	public async compatibility(): Promise<string[]> {
		const { stdout } = await this.cmd.create().compatibility().exec();
		return stdout.split('\n').map(s => s.trim()).filter(s => s != "");
	}

	/**
	 * encapsulate the `distrobox create` command
	 */
	public async create(opts: {
		name: string,
		image: string,

		hostname?: string,
		home?: string,

		volume?: string,
		additional_flags?: string[],
		additional_packages?: string[],
		init_hooks?: string,
		pre_init_hooks?: string,

		pull?: boolean,
		init?: boolean,
		nvidia?: boolean,

		unshare_devsys?: boolean,
		unshare_groups?: boolean,
		unshare_ipc?: boolean,
		unshare_netns?: boolean,
		unshare_process?: boolean,
		unshare_all?: boolean,

		no_entry?: boolean,
		dry_run?: boolean,
		verbose?: boolean,
	}) {
		const builder = this.cmd.create()
			.yes()
			.name(opts.name)
			.image(opts.image);
		if (opts.home) {
			builder.home(opts.home);
		}
		if (opts.hostname) {
			builder.hostname(opts.hostname);
		}
		if (opts.home) {
			builder.home(opts.home);
		}
		if (opts.volume) {
			builder.volume(opts.volume);
		}
		if (opts.additional_flags) {
			builder.additional_flags(...opts.additional_flags);
		}
		if (opts.additional_packages) {
			builder.additional_packages(...opts.additional_packages);
		}
		if (opts.init_hooks) {
			builder.init_hooks(opts.init_hooks);
		}
		if (opts.pre_init_hooks) {
			builder.pre_init_hooks(opts.pre_init_hooks);
		}
		if (opts.pull) {
			builder.pull();
		}
		if (opts.init) {
			builder.init();
		}
		if (opts.nvidia) {
			builder.nvidia();
		}
		if (opts.unshare_devsys) {
			builder.unshare_devsys();
		}
		if (opts.unshare_groups) {
			builder.unshare_groups();
		}
		if (opts.unshare_ipc) {
			builder.unshare_ipc();
		}
		if (opts.unshare_netns) {
			builder.unshare_netns();
		}
		if (opts.unshare_process) {
			builder.unshare_process();
		}
		if (opts.unshare_all) {
			builder.unshare_all();
		}
		if (opts.no_entry) {
			builder.no_entry();
		}
		if (opts.verbose) {
			builder.verbose();
		}
		if (opts.dry_run) {
			builder.dry_run();
		}
		return builder.exec();
	}

	/**
	 * get a `GuestDistro` by its `name`
	 */
	public async get(name: string): Promise<GuestDistro> {
		let guest = this.cached_guest_list.find(guest => guest.name == name);
		if (!guest) {
			await this.refresh_guest_list();
			guest = this.cached_guest_list.find(guest => guest.name == name);
		}
		if (!guest) {
			throw `distro "${name}" does not exist`;
		}
		return guest;
	}
}

/**
 * information about a specific guest container
 */
export class GuestDistro {
	// fields corresponding to the columns of the output of `distrobox list`
	// TODO:
	//   the `status` field doesn't update, which is not useful,
	//   make it private for now. maybe parse it properly in the future
	constructor(
		private cmd: EnterCommandBuilder,
		public readonly id: string,
		public readonly name: string,
		private readonly status: string,
		public readonly image: string,
	) {
	}

	/**
	 * wrapper for `distrobox enter` command using `child_process.exec()`
	 */
	public async exec(...args: string[]): Promise<{
		exit_code?: string | number,
		stdout: string,
		stderr: string
	}> {
		return this.cmd.args(...args).exec();
	}

	/**
	 * wrapper for `distrobox enter` command using `child_process.spawn()`
	 */
	public spawn(opts?: cp.SpawnOptions, ...args: string[]): cp.ChildProcess;
	public spawn(...args: string[]): cp.ChildProcess;
	public spawn(...vararg: any[]): cp.ChildProcess {
		let opts: cp.SpawnOptions | undefined;
		let args: string[];
		if (typeof vararg[0] === "object" && vararg[0] != null) {
			opts = vararg.shift();
			args = vararg;
		} else {
			args = vararg;
		}
		return this.cmd.args(...args).spawn(opts);
	}

	/**
	 * similar to `this.spawn()` but returns a function which acts like a pipe
	 */
	public spawn_piped(...args: string[]): (...inputs: any[]) => Promise<string> {
		const child = this.spawn(
			{
				stdio: ["pipe", "pipe", "inherit"]
			},
			...args
		);
		const output_chunks: Uint8Array[] = [];
		child.stdout?.on("data", (chunk: Uint8Array) => output_chunks.push(chunk));
		const child_closed = new Promise<number>((resolve, reject) => {
			child.on("close", (code, signal) => {
				if (signal) {
					reject(signal);
				} else {
					resolve(code ?? 0);
				}
			});
		});
		return async (...inputs: any[]) => {
			for (const chunk of inputs) {
				await new Promise<void>((resolve, reject) => {
					child.stdin?.write(chunk, (error) => {
						if (error) {
							reject(error);
						} else {
							resolve();
						}
					});
				});
			}
			await new Promise<void>((resolve, reject) => child.stdin?.end(resolve));
			await child_closed;
			const output = Buffer.concat(output_chunks);
			const decoder = new TextDecoder("utf8");
			return decoder.decode(output);
		};
	}

	/**
	 * run the given command in the terminal pane
	 */
	public create_terminal(name: string, ...args: string[]) {
		const argv = this.cmd.args(...args).build();
		const argv0 = argv.shift();
		const terminal = vscode.window.createTerminal({
			name,
			shellPath: argv0,
			shellArgs: argv,
			isTransient: true,
			message: `this is a terminal for the guest distro "${this.name}"`
		});
		return terminal;
	}
}
