// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: (C) 2025 nerditation <nerditation@users.noreply.github.com>
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import * as cp from "child_process";

import which = require("which");

import { MainCommandBuilder } from "./distrobox";

/**
 * @module agent
 *
 * wrapper over "raw" distrobox command line builder
 *
 * this module sits in between vscodium API and distrobox abstraction layer
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
			return new GuestDistro(id, name, status, image);
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
}

/**
 * information about a specific guest container
 */
export class GuestDistro {
	// fields corresponding to the columns of the output of `distrobox list`
	constructor(
		public readonly id: string,
		public readonly name: string,
		public readonly status: string,
		public readonly image: string,
	) {
	}
}
