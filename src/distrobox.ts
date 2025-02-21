// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: (C) 2024, 2025 nerditation <nerditation@users.noreply.github.com>
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

/**
 * @module distrobox
 *
 * this module implements (very minimal) command line builders. these builders
 * are used to correctly build the command line to invoke `distrobox`, which can
 * be used for APIs such as `child_process.exec()` or `child_process.spawn()`.
 *
 * there's a [distrobox-node] package in the npm registry, but it does not work
 * inside containers such as the flatpak sandbox.
 *
 * [distrobox-node]: https://github.com/darksystemgit/distrobox-node
 */

import * as cp from "child_process";
import which = require("which");

export abstract class CommandLineBuilder {
	/**
	 * build the command line.
	 *
	 * this method should return an array of strings coresponding to `argv` as
	 * in C's `main()` function, i.e. the first element `argv[0]` is the command
	 * itself.
	 */
	public abstract build(): string[];

	/**
	 * convenient wrapper for `child_process.execFile()` with the returned `argv`
	 * of `this.build()`.
	 *
	 * unlike `child_process.exec()`, this function can be awaited.
	 *
	 * @returns a promise that resolves to a struct similar to the return value
	 * of `child_process.exec()`, but this function will only throw if the child
	 * process is killed. in case it exited with non-zero exit code, I still try
	 * to capture the stdout and stderr, together with the exit code.
	 */
	public async exec(): Promise<{ exit_code?: string | number, stdout: string, stderr: string }> {
		const args = this.build();
		const cmd = args.shift()!;
		return new Promise((resolve, reject) => {
			cp.execFile(cmd, args, (error, stdout, stderr) => {
				if (error != null) {
					if (error.killed) {
						reject(error);
					} else {
						resolve({
							exit_code: error.code ?? -1,
							stdout: error.stdout ?? stdout,
							stderr: error.stderr ?? stderr
						});
					}
				} else {
					resolve({ stdout, stderr });
				}
			});
		});
	}

	/**
	 * convenient wrapper for `child_process.spawn()` with the returned `argv`
	 * of `this.build()`.
	 *
	 * @param {cp.SpawnOptions} opts - the same options as `child_process.spawn()`
	 * @returns {cp.ChildProcess} the same as `child_process.spawn()`
	 */
	public spawn(opts?: cp.SpawnOptions) {
		const args = this.build();
		const cmd = args.shift()!;
		if (opts) {
			return cp.spawn(cmd, args, opts);
		} else {
			return cp.spawn(cmd, args);
		}
	}

	/**
	 * spawn the child process with `stdin` and `stdout` redirected to pipes.
	 *
	 * the given input is written to `stdin`, and the `stdout` is read until
	 * the pipe is closed. the data is read as raw bytes, the user can convert
	 * it to text strings as needed.
	 *
	 * this function assumes the child process would eventually exit after
	 * its `stdin` is closed, and its `stdout` is closed when it exits.
	 *
	 * if the child process runs forever without exiting even after `stdin` is
	 * closed, the returned promise will never resolve.
	 *
	 * if the child process closes its `stdout` early, the promise might be
	 * resolved before the child process actually exited.
	 *
	 * @param input - data written to the `stdin` of the child process
	 * @returns {Promise<Buffer>} the raw bytes read from the `stdout`
	 */
	public pipe(input: any): Promise<Buffer> {
		const child = this.spawn({ stdio: ['pipe', 'pipe', 'inherit'] });
		child.stdin?.write(input);
		child.stdin?.end();
		return new Promise((resolve, reject) => {
			child.stdout?.on('error', reject);
			const output_chunks: Uint8Array[] = [];
			child.stdout?.on('data', (chunk) => output_chunks.push(chunk as Uint8Array));
			child.stdout?.on('end', () => resolve(Buffer.concat(output_chunks)));
		});
	}
}

/**
 * the builder for the main `distrobox` command
 *
 * this builder is used by the builders for individual subcommands
 *
```console
distrobox version: 1.8.0

Choose one of the available commands:
        assemble
        create
        enter
        list | ls
        rm
        stop
        upgrade
        ephemeral
        generate-entry
        version
        help

```
 */
export class MainCommandBuilder extends CommandLineBuilder {

	/**
	 * construct the builder with the given command line.
	 *
	 * @example
	 * ```ts
	 * const local = new distrobox.MainCommandBuilder(['/user/bin/distrobox']);
	 * const flatpak_host = new distrobox.MainCommandBuilder(['/usr/bin/flatpak-spawn', '--host', 'distrobox']);
	 * const distrobox_host = new distrobox.MainCommandBuilder(['/usr/bin/distrobox-host-exec', 'distrobox']);
	 * ```
	 * @param argv - the command line to invoke `distrobox`
	 */
	constructor(public argv: string[]) {
		super();
	}

	/**
	 * try to automatically find out how to invoke `distrobox` command
	 *
	 * currently these heuristics are used, in this order:
	 * - if there's a `distrobox` command in `$PATH`, then use it
	 * - if inside a flatpak sandbox, try `flatpak-spawn --host distrbox`
	 * - if inside a distrobox guest, use `distrobox-host-exec distrobox`
	 */
	public static async auto(): Promise<MainCommandBuilder> {
		try {
			const distrobox_path = await which('distrobox');
			console.log(`found distrobox: ${distrobox_path}`);
			return new MainCommandBuilder([distrobox_path]);
		} catch {
			console.log("local distrobox not found");
		}
		try {
			const flatpak_spawn_path = await which('flatpak-spawn');
			console.log(`inside flatpak sandbox: ${flatpak_spawn_path}`);
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
			console.log(`found distrobox on flatpak host: ${banner}`);
			return new MainCommandBuilder([flatpak_spawn_path, '--host', 'distrobox']);
		} catch {
			console.log("didn't find distrobox on flatpak host");
		}
		try {
			const distrobox_host_exec_path = await which('distrobox-host-exec');
			console.log(`inside distrobox guest: ${distrobox_host_exec_path}`);
			return new MainCommandBuilder([distrobox_host_exec_path, 'distrobox']);
		} catch {
			console.log("not inside distrobox guest");
		}
		throw ("didn't find distrobox command");
	}

	/**
	 * the main command without any subcommand just prints the usage
	 */
	public build(): string[] {
		return this.argv;
	}

	/**
	 * shorthand to construct a builder for the subcommand `distrobox-list`
	 */
	public list(): ListCommandBuilder {
		return new ListCommandBuilder(this);
	}

	/**
	 * shorthand to construct a builder for the subcommand `distrobox-enter`
	 */
	public enter(name?: string, ...args: string[]): EnterCommandBuilder {
		return new EnterCommandBuilder(this, name, ...args);
	}
}

/**
 * the builder for the `distrobox list` subcommand
 *
```console
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
```
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
		const argv = [...this._command.argv, "list"];
		if (this._help) {
			argv.push("--help");
		}
		if (this._no_color) {
			argv.push("--no-color");
		}
		if (this._root) {
			argv.push("--root");
		}
		if (this._verbose) {
			argv.push("--verbose");
		}
		if (this._version) {
			argv.push("--version");
		}
		return argv;
	}

	/**
	 * `run()` wraps `this.exec` and parse the output into structured data
	 */
	public async run(): Promise<Record<string, string>[]> {
		const { stdout } = await this.exec();
		const lines = stdout.split("\n").filter(line => line != "");
		const header = lines.shift()!;
		const fields = header.split("|").map(s => s.trim().toLowerCase());
		return lines.map((line) => {
			function zip<T, U>(ts: T[], us: U[]): [T, U][] {
				return ts.map((t, i) => [t, us[i]]);
			}
			return Object.fromEntries(zip(fields, line.split("|").map(s => s.trim())));
		});
	}
}

/**
 * the builder for the `distrobox enter` subcommand
 *
```console
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
```
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
		const argv = [...this._command.argv, "enter"];
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
			argv.push("--help");
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
