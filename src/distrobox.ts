// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: (C) 2024 nerditation <nerditation@users.noreply.github.com>
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import * as cp from "child_process";

export class MainCommandBuilder {

	constructor(public argv: string[]) {
	}

	/**
	 * default
	 */
	public static default(): MainCommandBuilder {
		return new MainCommandBuilder(["distrobox"])
	}

	/**
	 * from_flatpak
	 */
	public static flatpak_spawn_host(): MainCommandBuilder {
		return new MainCommandBuilder(["flatpak-spawn", "--host", "distrobox"])
	}

	/**
	 * list
	 */
	public list(): ListCommandBuilder {
		return new ListCommandBuilder(this);
	}
}

/**
distrobox version: 1.8.0

Usage:

		  distrobox-list

Options:

		  --help/-h:              show this message
		  --no-color:             disable color formatting
		  --root/-r:              launch podman/docker/lilipod with root privileges. Note that if you need root this is the preferred
										  way over "sudo distrobox" (note: if using a program other than 'sudo' for root privileges is necessary,
										  specify it through the DBX_SUDO_PROGRAM env variable, or 'distrobox_sudo_program' config variable)
		  --verbose/-v:           show more verbosity
		  --version/-V:           show version
 */
export class ListCommandBuilder {
	_command: MainCommandBuilder;
	_help: boolean = false;
	_no_color: boolean = false;
	_root: boolean = false;
	_verbose: boolean = false;
	_version: boolean = false;

	constructor(command: MainCommandBuilder) {
		this._command = command;
	}

	/**
	 * `--help/-h`
	 */
	public help(): this {
		this._help = true;
		return this;
	}

	/**
	 * `--no-color`
	 */
	public no_color(): this {
		this._no_color = true;
		return this;
	}

	/**
	 * `--root/-r`
	 */
	public root(): this {
		this._root = true;
		return this;
	}

	/**
	 * `--verbose/-v`
	 */
	public verbose(): this {
		this._verbose = true;
		return this;
	}

	/**
	 * `--version/-V`
	 */
	public version(): this {
		this._version = true;
		return this;
	}

	/**
	 * build
	 */
	public build(): string[] {
		let argv = [...this._command.argv, "list"];
		if (this._help) {
			argv.push("--help")
		}
		if (this._no_color) {
			argv.push("--no-color")
		}
		if (this._root) {
			argv.push("--root")
		}
		if (this._verbose) {
			argv.push("--verbose")
		}
		if (this._version) {
			argv.push("--version")
		}
		return argv;
	}

	/**
	 * exec
	 */
	public async exec_raw(): Promise<{ stdout: string, stderr: string }> {
		let args = this.build();
		const cmd = args.shift()!;
		return new Promise((resolve, reject) => {
			cp.execFile(cmd, args, (error, stdout, stderr) => {
				if (error != null) {
					reject(error);
				} else {
					resolve({ stdout, stderr })
				}
			})
		})
	}

	/**
	 * exec
	 */
	public async exec(): Promise<Record<string, string>[]> {
		const { stdout } = await this.exec_raw();
		let lines = stdout.split("\n");
		const header = lines.shift()!;
		const fields = header.split("|").map(s => s.trim().toLowerCase());
		return lines.map((line) => {
			function zip<T, U>(ts: T[], us: U[]): [T, U][] {
				return ts.map((t, i) => [t, us[i]]);
			}
			return Object.fromEntries(zip(fields, line.split("|").map(s => s.trim())));
		})
	}
}
