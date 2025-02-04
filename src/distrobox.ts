// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: (C) 2024, 2025 nerditation <nerditation@users.noreply.github.com>
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import * as cp from "child_process";

export abstract class CommandLineBuilder {
	/**
	 * build
	 */
	public abstract build(): string[];

	/**
	 * exec
	 */
	public async exec(): Promise<{ stdout: string, stderr: string }> {
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
	 * spawn_raw
	 */
	public spawn(opts?: cp.SpawnOptions) {
		let args = this.build();
		const cmd = args.shift()!;
		if (opts?.env) {
			opts.env = Object.assign({}, process.env, opts.env);
		}
		if (opts) {
			return cp.spawn(cmd, args, opts)
		} else {
			return cp.spawn(cmd, args)
		}
	}
}

export class MainCommandBuilder extends CommandLineBuilder {

	constructor(public argv: string[]) {
		super()
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
	 * build
	 */
	public build(): string[] {
		return this.argv
	}

	/**
	 * list
	 */
	public list(): ListCommandBuilder {
		return new ListCommandBuilder(this);
	}

	/**
	 * enter
	 */
	public enter(name?: string, ...args: string[]): EnterCommandBuilder {
		return new EnterCommandBuilder(this, name, ...args);
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
export class ListCommandBuilder extends CommandLineBuilder {
	_command: MainCommandBuilder;
	_help: boolean = false;
	_no_color: boolean = false;
	_root: boolean = false;
	_verbose: boolean = false;
	_version: boolean = false;

	constructor(command: MainCommandBuilder) {
		super();
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
	public async run(): Promise<Record<string, string>[]> {
		const { stdout } = await this.exec();
		let lines = stdout.split("\n").filter(line => line != "");
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

/**
distrobox version: 1.8.0.1

Usage:

		  distrobox-enter --name fedora-39 -- bash -l
		  distrobox-enter my-alpine-container -- sh -l
		  distrobox-enter --additional-flags "--preserve-fds" --name test -- bash -l
		  distrobox-enter --additional-flags "--env MY_VAR=value" --name test -- bash -l
		  MY_VAR=value distrobox-enter --additional-flags "--preserve-fds" --name test -- bash -l

Options:

		  --name/-n:              name for the distrobox                                          default: my-distrobox
		  --/-e:                  end arguments execute the rest as command to execute at login   default: default nerditation's shell
		  --clean-path:           reset PATH inside container to FHS standard
		  --no-tty/-T:            do not instantiate a tty
		  --no-workdir/-nw:       always start the container from container's home directory
		  --additional-flags/-a:  additional flags to pass to the container manager command
		  --help/-h:              show this message
		  --root/-r:              launch podman/docker/lilipod with root privileges. Note that if you need root this is the preferred
										  way over "sudo distrobox" (note: if using a program other than 'sudo' for root privileges is necessary,
										  specify it through the DBX_SUDO_PROGRAM env variable, or 'distrobox_sudo_program' config variable)
		  --dry-run/-d:           only print the container manager command generated
		  --verbose/-v:           show more verbosity
		  --version/-V:           show version

 */
export class EnterCommandBuilder extends CommandLineBuilder {
	_command: MainCommandBuilder;
	_name?: string;
	_clean_path: boolean = false;
	_no_tty: boolean = false;
	_no_workdir: boolean = false;
	_additional_flags?: string;
	_help: boolean = false;
	_root: boolean = false;
	_dry_run: boolean = false;
	_verbose: boolean = false;
	_version: boolean = false;

	_args: string[] = [];

	constructor(command: MainCommandBuilder, name?: string, ...args: string[]) {
		super();
		this._command = command;
		this._name = name;
		this._args = args;
	}

	/**
	 * --name/-n
	 */
	public name(name: string): this {
		this._name = name;
		return this;
	}

	/**
	 * --clean-path
	 */
	public clean_path(): this {
		this._clean_path = true;
		return this;
	}

	/**
	 * --no-tty/-T
	 */
	public no_tty(): this {
		this._no_tty = true;
		return this;
	}

	/**
	 * --no-workdir/-nw
	 */
	public no_workdir(): this {
		this._no_workdir = true;
		return this;
	}

	/**
	 * --additional-flags/-a
	 */
	public additional_flags(flags: string): this {
		this._additional_flags = flags;
		return this;
	}

	/**
	 * --help/-h
	 */
	public help(): this {
		this._help = true;
		return this;
	}

	/**
	 * --root/-r
	 */
	public root(): this {
		this._root = true;
		return this;
	}

	/**
	 * --dry-run/-d
	 */
	public dry_run() {
		this._dry_run = true;
		return this;
	}

	/**
	 * --verbose/-v
	 */
	public verbose() {
		this._verbose = true;
		return this;
	}

	/**
	 * --version/-V
	 */
	public version() {
		this._version = true;
		return this;
	}

	/**
	 * args
	 */
	public args(args: string[]) {
		this._args = args;
		return this;
	}

	/**
	 * build
	 */
	public build() {
		let argv = [...this._command.argv, "enter"];
		if (this._name) {
			argv.push("--name");
			argv.push(this._name);
		}
		if (this._clean_path) {
			argv.push("--clean-path");
		}
		if (this._no_tty) {
			argv.push("--no-tty");
		}
		if (this._no_workdir) {
			argv.push("--no-workdir");
		}
		if (this._additional_flags) {
			argv.push("--additional-flags");
			argv.push(this._additional_flags);
		}
		if (this._help) {
			argv.push("--help")
		}
		if (this._root) {
			argv.push("--root");
		}
		if (this._dry_run) {
			argv.push("--dry-run");
		}
		if (this._verbose) {
			argv.push("--verbose");
		}
		if (this._version) {
			argv.push("--version");
		}

		argv.push("--");

		return argv.concat(this._args);
	}

}
