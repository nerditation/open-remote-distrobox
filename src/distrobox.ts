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
	public pipe(input: any, opts?: cp.SpawnOptions): Promise<Buffer> {
		const child = this.spawn(Object.assign(opts ?? {}, { stdio: ['pipe', 'pipe', 'inherit'] }));
		child.stdin?.end(input);
		return new Promise((resolve, reject) => {
			child.stdout?.on('error', reject);
			const output_chunks: Uint8Array[] = [];
			child.stdout?.on('data', (chunk) => output_chunks.push(chunk as Uint8Array));
			child.stdout?.on('end', () => resolve(Buffer.concat(output_chunks)));
			child.unref();
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

	public argv: string[];

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
	constructor(...argv: string[]) {
		super();
		this.argv = argv;
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

	/**
	 * shorhand to construct a builder for the subcommand `distrobox-create`
	 */
	public create(): CreateCommandBuilder {
		return new CreateCommandBuilder(this);
	}

	/**
	 * shorhand to construct a builder for the subcommand `distrobox-rm`
	 */
	public rm(...names: string[]): RmCommandBuilder {
		return new RmCommandBuilder(this, ...names);
	}
}

/**
 * options for the `distrobox list` subcommand
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
export interface ListOptions {
	help: boolean;
	no_color: boolean;
	root: boolean;
	verbose: boolean;
	version: boolean;
}

/**
 * the builder for the `distrobox list` subcommand, see {@link ListOptions}
 */
export class ListCommandBuilder extends CommandLineBuilder {
	_prefix: MainCommandBuilder;
	_options: ListOptions;

	public static default_options(): ListOptions {
		return {
			help: false,
			no_color: false,
			root: false,
			verbose: false,
			version: false,

		};
	}

	constructor(command: MainCommandBuilder) {
		super();
		this._prefix = command;
		this._options = ListCommandBuilder.default_options();
	}

	public with_options(options: ListOptions) {
		this._options = options;
		return this;
	}

	/**
	 * `--help/-h`
	 */
	public help(): this {
		this._options.help = true;
		return this;
	}

	/**
	 * `--no-color`
	 */
	public no_color(): this {
		this._options.no_color = true;
		return this;
	}

	/**
	 * `--root/-r`
	 */
	public root(): this {
		this._options.root = true;
		return this;
	}

	/**
	 * `--verbose/-v`
	 */
	public verbose(): this {
		this._options.verbose = true;
		return this;
	}

	/**
	 * `--version/-V`
	 */
	public version(): this {
		this._options.version = true;
		return this;
	}

	/**
	 * build
	 */
	public build(): string[] {
		const argv = [...this._prefix.build(), "list"];
		if (this._options.help) {
			argv.push("--help");
		}
		if (this._options.no_color) {
			argv.push("--no-color");
		}
		if (this._options.root) {
			argv.push("--root");
		}
		if (this._options.verbose) {
			argv.push("--verbose");
		}
		if (this._options.version) {
			argv.push("--version");
		}
		return argv;
	}
}

/**
 * options for the `distrobox enter` subcommand
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
export interface EnterOptions {
	name?: string;
	clean_path: boolean;
	no_tty: boolean;
	no_workdir: boolean;
	additional_flags?: string;
	help: boolean;
	root: boolean;
	dry_run: boolean;
	verbose: boolean;
	version: boolean;
}

/**
 * the builder for the `distrobox enter` subcommand
 */
export class EnterCommandBuilder extends CommandLineBuilder {
	_prefix: MainCommandBuilder;
	_options: EnterOptions;
	_args: string[] = [];

	public static default_options(name?: string): EnterOptions {
		return {
			name,
			clean_path: false,
			no_tty: false,
			no_workdir: false,
			additional_flags: undefined,
			help: false,
			root: false,
			dry_run: false,
			verbose: false,
			version: false,
		};
	}

	constructor(command: MainCommandBuilder, name?: string, ...args: string[]) {
		super();
		this._prefix = command;
		this._options = EnterCommandBuilder.default_options(name);
		this._args = args;
	}

	public with_options(options: EnterOptions) {
		this._options = options;
		return this;
	}

	/**
	 * --name/-n
	 */
	public name(name: string): this {
		this._options.name = name;
		return this;
	}

	/**
	 * --clean-path
	 */
	public clean_path(): this {
		this._options.clean_path = true;
		return this;
	}

	/**
	 * --no-tty/-T
	 */
	public no_tty(): this {
		this._options.no_tty = true;
		return this;
	}

	/**
	 * --no-workdir/-nw
	 */
	public no_workdir(): this {
		this._options.no_workdir = true;
		return this;
	}

	/**
	 * --additional-flags/-a
	 */
	public additional_flags(flags: string): this {
		this._options.additional_flags = flags;
		return this;
	}

	/**
	 * --help/-h
	 */
	public help(): this {
		this._options.help = true;
		return this;
	}

	/**
	 * --root/-r
	 */
	public root(): this {
		this._options.root = true;
		return this;
	}

	/**
	 * --dry-run/-d
	 */
	public dry_run() {
		this._options.dry_run = true;
		return this;
	}

	/**
	 * --verbose/-v
	 */
	public verbose() {
		this._options.verbose = true;
		return this;
	}

	/**
	 * --version/-V
	 */
	public version() {
		this._options.version = true;
		return this;
	}

	/**
	 * args
	 */
	public args(...args: string[]) {
		this._args = args;
		return this;
	}

	/**
	 * build
	 */
	public build() {
		const argv = [...this._prefix.build(), "enter"];
		if (this._options.name) {
			argv.push("--name", this._options.name);
		}
		if (this._options.clean_path) {
			argv.push("--clean-path");
		}
		if (this._options.no_tty) {
			argv.push("--no-tty");
		}
		if (this._options.no_workdir) {
			argv.push("--no-workdir");
		}
		if (this._options.additional_flags) {
			argv.push("--additional-flags", this._options.additional_flags);
		}
		if (this._options.help) {
			argv.push("--help");
		}
		if (this._options.root) {
			argv.push("--root");
		}
		if (this._options.dry_run) {
			argv.push("--dry-run");
		}
		if (this._options.verbose) {
			argv.push("--verbose");
		}
		if (this._options.version) {
			argv.push("--version");
		}

		if (this._args.length > 0) {
			argv.push("--", ...this._args);
		}

		return argv;
	}

}

/**
 * options for the `distrobox create` command
 *
```console
distrobox version: 1.8.0

Usage:

		  distrobox create --image alpine:latest --name test --init-hooks "touch /var/tmp/test1 && touch /var/tmp/test2"
		  distrobox create --image fedora:39 --name test --additional-flags "--env MY_VAR-value"
		  distrobox create --image fedora:39 --name test --volume /opt/my-dir:/usr/local/my-dir:rw --additional-flags "--pids-limit 100"
		  distrobox create -i docker.io/almalinux/8-init --init --name test --pre-init-hooks "dnf config-manager --enable powertools && dnf -y install epel-release"
		  distrobox create --clone fedora-39 --name fedora-39-copy
		  distrobox create --image alpine my-alpine-container
		  distrobox create --image registry.fedoraproject.org/fedora-toolbox:latest --name fedora-toolbox-latest
		  distrobox create --pull --image centos:stream9 --home ~/distrobox/centos9
		  distrobox create --image alpine:latest --name test2 --additional-packages "git tmux vim"
		  distrobox create --image ubuntu:22.04 --name ubuntu-nvidia --nvidia

		  DBX_NON_INTERACTIVE=1 DBX_CONTAINER_NAME=test-alpine DBX_CONTAINER_IMAGE=alpine distrobox-create

Options:

		  --image/-i:             image to use for the container  default: registry.opensuse.org/opensuse/distrobox:latest
		  --name/-n:              name for the distrobox          default: my-distrobox
		  --hostname:             hostname for the distrobox      default: localhost.localdomain
		  --pull/-p:              pull the image even if it exists locally (implies --yes)
		  --yes/-Y:               non-interactive, pull images without asking
		  --root/-r:              launch podman/docker/lilipod with root privileges. Note that if you need root this is the preferred
										  way over "sudo distrobox" (note: if using a program other than 'sudo' for root privileges is necessary,
										  specify it through the DBX_SUDO_PROGRAM env variable, or 'distrobox_sudo_program' config variable)
		  --clone/-c:             name of the distrobox container to use as base for a new container
										  this will be useful to either rename an existing distrobox or have multiple copies
										  of the same environment.
		  --home/-H:              select a custom HOME directory for the container. Useful to avoid host's home littering with temp files.
		  --volume:               additional volumes to add to the container
		  --additional-flags/-a:  additional flags to pass to the container manager command
		  --additional-packages/-ap:      additional packages to install during initial container setup
		  --init-hooks:           additional commands to execute at the end of container initialization
		  --pre-init-hooks:       additional commands to execute at the start of container initialization
		  --init/-I:              use init system (like systemd) inside the container.
										  this will make host's processes not visible from within the container. (assumes --unshare-process)
										  may require additional packages depending on the container image: https://github.com/89luca89/distrobox/blob/main/docs/useful_tips.md#using-init-system-inside-a-distrobox
		  --nvidia:               try to integrate host's nVidia drivers in the guest
		  --unshare-devsys:          do not share host devices and sysfs dirs from host
		  --unshare-groups:          do not forward user's additional groups into the container
		  --unshare-ipc:          do not share ipc namespace with host
		  --unshare-netns:        do not share the net namespace with host
		  --unshare-process:          do not share process namespace with host
		  --unshare-all:          activate all the unshare flags below
		  --compatibility/-C:     show list of compatible images
		  --help/-h:              show this message
		  --no-entry:             do not generate a container entry in the application list
		  --dry-run/-d:           only print the container manager command generated
		  --verbose/-v:           show more verbosity
		  --version/-V:           show version

		  --absolutely-disable-root-password-i-am-really-positively-sure: ⚠ ⚠  when setting up a rootful distrobox, this will skip user password setup, leaving it blank. ⚠ ⚠

Compatibility:

		  for a list of compatible images and container managers, please consult the man page:
					 man distrobox-compatibility
		  or run
					 distrobox create --compatibility
		  or consult the documentation page on: https://github.com/89luca89/distrobox/blob/main/docs/compatibility.md
```
 */
export interface CreateOptions {
	name?: string;
	image?: string;
	hostname?: string;
	pull: boolean;
	yes: boolean;
	root: boolean;
	clone?: string;
	home?: string;

	volume?: string;
	additional_flags?: string | string[];
	additional_packages?: string | string[];
	init_hooks?: string;
	pre_init_hooks?: string;
	init: boolean;
	nvidia: boolean;

	unshare_devsys: boolean;
	unshare_groups: boolean;
	unshare_ipc: boolean;
	unshare_netns: boolean;
	unshare_process: boolean;
	unshare_all: boolean;

	compatibility: boolean;
	help: boolean;
	no_entry: boolean;
	dry_run: boolean;
	verbose: boolean;
	version: boolean;

	absolutely_disable_root_password_i_am_really_positively_sure: boolean;
}

/**
 * the builder for the `distrobox create` command
 */
export class CreateCommandBuilder extends CommandLineBuilder {
	_prefix: MainCommandBuilder;
	_options: CreateOptions;

	public static default_options(): CreateOptions {
		return {
			//name?: string;
			//image?: string;
			//hostname?: string;
			pull: false,
			yes: false,
			root: false,
			//clone?: string;
			//home?: string;

			//volume?: string;
			//additional_flags?: string|string[],
			//additional_packages: string|[],
			//init_hooks?: string;
			//pre_init_hooks?: string;
			init: false,
			nvidia: false,

			unshare_devsys: false,
			unshare_groups: false,
			unshare_ipc: false,
			unshare_netns: false,
			unshare_process: false,
			unshare_all: false,

			compatibility: false,
			help: false,
			no_entry: false,
			dry_run: false,
			verbose: false,
			version: false,

			absolutely_disable_root_password_i_am_really_positively_sure: false,

		};
	}
	constructor(cmd: MainCommandBuilder) {
		super();
		this._prefix = cmd;
		this._options = CreateCommandBuilder.default_options();
	}

	public with_options(options: CreateOptions) {
		this._options = options;
		return this;
	}

	/**
	 * build
	 */
	public build(): string[] {
		const argv = [...this._prefix.build(), "create"];

		if (this._options.image) {
			argv.push("--image", this._options.image);
		}
		if (this._options.name) {
			argv.push("--name", this._options.name);
		}
		if (this._options.hostname) {
			argv.push("--hostname", this._options.hostname);
		}
		if (this._options.pull) {
			argv.push("--pull");
		}
		if (this._options.yes) {
			argv.push("--yes");
		}
		if (this._options.root) {
			argv.push("--root");
		}
		if (this._options.clone) {
			argv.push("--clone", this._options.clone);
		}
		if (this._options.home) {
			argv.push("--home", this._options.home);
		}
		if (this._options.volume) {
			argv.push("--volume", this._options.volume);
		}
		if (this._options.additional_flags) {
			const flags =
				typeof this._options.additional_flags === "string" ?
					this._options.additional_flags :
					this._options.additional_flags.join(' ');
			argv.push("--additional-flags", flags);
		}
		if (this._options.additional_packages) {
			const packages =
				typeof this._options.additional_packages === "string" ?
					this._options.additional_packages :
					this._options.additional_packages.join(' ');
			argv.push("--additional-packages", packages);
		}
		if (this._options.init_hooks) {
			argv.push("--init-hooks", this._options.init_hooks);
		}
		if (this._options.pre_init_hooks) {
			argv.push("--pre-init-hooks", this._options.pre_init_hooks);
		}
		if (this._options.init) {
			argv.push("--init");
		}
		if (this._options.nvidia) {
			argv.push("--nvidia");
		}
		if (this._options.unshare_devsys) {
			argv.push("--unshare-devsys");
		}
		if (this._options.unshare_groups) {
			argv.push("--unshare-groups");
		}
		if (this._options.unshare_ipc) {
			argv.push("--unshare-ipc");
		}
		if (this._options.unshare_netns) {
			argv.push("--unshare-netns");
		}
		if (this._options.unshare_process) {
			argv.push("--unshare-process");
		}
		if (this._options.unshare_all) {
			argv.push("--unshare-all");
		}
		if (this._options.compatibility) {
			argv.push("--compatibility");
		}
		if (this._options.help) {
			argv.push("--help");
		}
		if (this._options.no_entry) {
			argv.push("--no-entry");
		}
		if (this._options.dry_run) {
			argv.push("--dry-run");
		}
		if (this._options.verbose) {
			argv.push("--verbose");
		}
		if (this._options.version) {
			argv.push("--version");
		}
		if (this._options.absolutely_disable_root_password_i_am_really_positively_sure) {
			argv.push("--absolutely-disable-root-password-i-am-really-positively-sure");
		}
		return argv;
	}

	/**
	 * --image/-i:
	 *
	 * image to use for the container
	 * default: registry.opensuse.org/opensuse/distrobox:latest
	 */
	public image(image: string) {
		this._options.image = image;
		return this;
	}

	/**
	 * --name/-n:
	 *
	 * name for the distrobox
	 * default: my-distrobox
	 */
	public name(name: string) {
		this._options.name = name;
		return this;
	}

	/**
	 * --hostname:
	 *
	 * hostname for the distrobox
	 * default: localhost.localdomain
	 */
	public hostname(hostname: string) {
		this._options.hostname = hostname;
		return this;
	}

	/**
	 * --pull/-p:
	 *
	 * pull the image even if it exists locally (implies --yes)
	 */
	public pull() {
		this._options.pull = true;
		return this;
	}

	/**
	 * --yes/-Y:
	 *
	 * non-interactive, pull images without asking
	 */
	public yes() {
		this._options.yes = true;
		return this;
	}

	/**
	 * --root/-r:
	 *
	 * launch podman/docker/lilipod with root privileges. Note that if you need root this is the preferred
	 * way over "sudo distrobox" (note: if using a program other than 'sudo' for root privileges is necessary,
	 * specify it through the DBX_SUDO_PROGRAM env variable, or 'distrobox_sudo_program' config variable)
	 */
	public root() {
		this._options.root = true;
		return this;
	}

	/**
	 * --clone/-c:
	 *
	 * name of the distrobox container to use as base for a new container
	 *
	 * this will be useful to either rename an existing distrobox or have multiple copies
	 * of the same environment.
	 */
	public clone(clone: string) {
		this._options.clone = clone;
		return this;
	}

	/**
	 * --home/-H:
	 *
	 * select a custom HOME directory for the container. Useful to avoid host's home littering with temp files.
	 */
	public home(home: string) {
		this._options.home = home;
		return this;
	}

	/**
	 * --volume:
	 *
	 * additional volumes to add to the container
	 */
	public volume(volume: string) {
		this._options.volume = volume;
		return this;
	}

	/**
	 * --additional-flags/-a:
	 *
	 * additional flags to pass to the container manager command
	 */
	public additional_flags(...flags: string[]) {
		this._options.additional_flags = flags;
		return this;
	}

	/**
	 * --additional-packages/-ap:
	 *
	 * additional packages to install during initial container setup
	 */
	public additional_packages(...packages: string[]) {
		this._options.additional_packages = packages;
		return this;
	}

	/**
	 * --init-hooks:
	 *
	 * additional commands to execute at the end of container initialization
	 */
	public init_hooks(hooks: string) {
		this._options.init_hooks = hooks;
		return this;
	}

	/**
	 * --pre-init-hooks:
	 *
	 * additional commands to execute at the start of container initialization
	 */
	public pre_init_hooks(hooks: string) {
		this._options.pre_init_hooks = hooks;
		return this;
	}

	/**
	 * --init/-I:
	 *
	 * use init system (like systemd) inside the container.
	 *
	 * this will make host's processes not visible from within the container. (assumes --unshare-process)
	 * may require additional packages depending on the container image:
	 * https://github.com/89luca89/distrobox/blob/main/docs/useful_tips.md#using-init-system-inside-a-distrobox
	 */
	public init() {
		this._options.init = true;
		return this;
	}

	/**
	 * --nvidia:
	 *
	 * try to integrate host's nVidia drivers in the guest
	 */
	public nvidia() {
		this._options.nvidia = true;
		return this;
	}

	/**
	 * --unshare-devsys:
	 *
	 * do not share host devices and sysfs dirs from host
	 */
	public unshare_devsys() {
		this._options.unshare_devsys = true;
		return this;
	}

	/**
	 * --unshare-groups:
	 *
	 * do not forward user's additional groups into the container
	 */
	public unshare_groups() {
		this._options.unshare_groups = true;
		return this;
	}

	/**
	 * --unshare-ipc:
	 *
	 * do not share ipc namespace with host
	 */
	public unshare_ipc() {
		this._options.unshare_ipc = true;
		return this;
	}

	/**
	 * --unshare-netns:
	 *
	 * do not share the net namespace with host
	 */
	public unshare_netns() {
		this._options.unshare_netns = true;
		return this;
	}

	/**
	 * --unshare-process:
	 *
	 * do not share process namespace with host
	 */
	public unshare_process() {
		this._options.unshare_process = true;
		return this;
	}

	/**
	 * --unshare-all:
	 *
	 * activate all the unshare flags below
	 */
	public unshare_all() {
		this._options.unshare_all = true;
		return this;
	}

	/**
	 * --compatibility/-C:
	 *
	 * show list of compatible images
	 */
	public compatibility() {
		this._options.compatibility = true;
		return this;
	}

	/**
	 * --help/-h:
	 *
	 * show this message
	 */
	public help() {
		this._options.help = true;
		return this;
	}

	/**
	 * --no-entry:
	 *
	 * do not generate a container entry in the application list
	 */
	public no_entry() {
		this._options.no_entry = true;
		return this;
	}

	/**
	 * dry-run/-d:
	 *
	 * only print the container manager command generated
	 */
	public dry_run() {
		this._options.dry_run = true;
		return this;
	}

	/**
	 * --verbose/-v:
	 *
	 * show more verbosity
	 */
	public verbose() {
		this._options.verbose = true;
		return this;
	}

	/**
	 * --version/-V:
	 *
	 * show version
	 */
	public version() {
		this._options.version = true;
		return this;
	}

	/**
	 * absolutely-disable-root-password-i-am-really-positively-sure:
	 *
	 * ⚠ ⚠  when setting up a rootful distrobox, this will skip user password setup, leaving it blank. ⚠ ⚠
	 */
	public absolutely_disable_root_password_i_am_really_positively_sure() {
		this._options.absolutely_disable_root_password_i_am_really_positively_sure = true;
		return this;
	}
}

/**
 * options for the `distrobox rm` subcommand
 *
```console
distrobox version: 1.8.0

Usage:

		  distrobox-rm [-f/--force] container-name [container-name1 container-name2 ...]

Options:

		  --all/-a:               delete all distroboxes
		  --force/-f:             force deletion
		  --rm-home:              remove the mounted home if it differs from the host user's one
		  --root/-r:              launch podman/docker/lilipod with root privileges. Note that if you need root this is the preferred
										  way over "sudo distrobox" (note: if using a program other than 'sudo' for root privileges is necessary,
										  specify it through the DBX_SUDO_PROGRAM env variable, or 'distrobox_sudo_program' config variable)
		  --help/-h:              show this message
		  --verbose/-v:           show more verbosity
		  --version/-V:           show version

```
 */
export interface RmOptions {
	names: string[];
	all: boolean;
	force: boolean;
	rm_home: boolean;
	root: boolean;
	help: boolean;
	verbose: boolean;
	version: boolean;
}

/**
 * the builder for the `distrobox rm` subcommand
 */
export class RmCommandBuilder extends CommandLineBuilder {
	_prefix: MainCommandBuilder;
	_options: RmOptions;

	public static default_options(...names: string[]): RmOptions {
		return {
			names,
			all: false,
			force: false,
			rm_home: false,
			root: false,
			help: false,
			verbose: false,
			version: false,

		};
	}

	constructor(cmd: MainCommandBuilder, ...names: string[]) {
		super();
		this._prefix = cmd;
		this._options = RmCommandBuilder.default_options(...names);
	}

	public with_options(options: RmOptions) {
		this._options = options;
		return this;
	}

	/**
	 * build
	 */
	public build(): string[] {
		const argv = [...this._prefix.build(), "rm"];
		if (this._options.all) {
			argv.push("--all");
		}
		if (this._options.force) {
			argv.push("--force");
		}
		if (this._options.rm_home) {
			argv.push("--rm-home");
		}
		if (this._options.root) {
			argv.push("--root");
		}
		if (this._options.help) {
			argv.push("--help");
		}
		if (this._options.verbose) {
			argv.push("--verbose");
		}
		if (this._options.version) {
			argv.push("--version");
		}

		argv.push(...this._options.names);

		return argv;
	}

	/**
	 * *replace* all the container names to be deleted
	 */
	public names(...names: string[]) {
		this._options.names = names;
		return this;
	}

	/**
	 * *append* another container name to be deleted
	 */
	public name(name: string) {
		this._options.names.push(name);
		return this;
	}

	/**
	 * --all/-a:
	 *
	 * delete all distroboxes
	 */
	public all() {
		this._options.all = true;
		return this;
	}

	/**
	 * --force/-f:
	 *
	 * force deletion
	 */
	public force() {
		this._options.force = true;
		return this;
	}

	/**
	 * --rm-home:
	 *
	 * remove the mounted home if it differs from the host user's one
	 */
	public rm_home() {
		this._options.rm_home = true;
		return this;
	}

	/**
	 * --root/-r:
	 *
	 * launch podman/docker/lilipod with root privileges. Note that if you need root this is the preferred
	 * way over "sudo distrobox" (note: if using a program other than 'sudo' for root privileges is necessary,
	 * specify it through the DBX_SUDO_PROGRAM env variable, or 'distrobox_sudo_program' config variable)
	 */
	public root() {
		this._options.root = true;
		return this;
	}

	/**
	 * --help/-h:
	 *
	 * show this message
	 */
	public help() {
		this._options.help = true;
		return this;
	}

	/**
	 * --verbose/-v:
	 *
	 * show more verbosity
	 */
	public verbose() {
		this._options.verbose = true;
		return this;
	}

	/**
	 * --version/-V:
	 *
	 * show version
	 */
	public version() {
		this._options.version = true;
		return this;
	}
}
