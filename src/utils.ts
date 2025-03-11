// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: (C) 2025 nerditation <nerditation@users.noreply.github.com>
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import { ChildProcessWithoutNullStreams } from "child_process";
import { once } from "events";

export const utf8 = new TextDecoder("utf8");


export interface ChildProcessOutput {
	exit_code: number | null,
	signal: NodeJS.Signals | null,
	stdout: Uint8Array,
	stderr: string,
}

export class PipedChildProcess {

	constructor(
		public child: ChildProcessWithoutNullStreams,
	) { }

	public finish(input?: string | Uint8Array): Promise<ChildProcessOutput> {
		console.log("finish", input);
		return new Promise((resolve, reject) => {
			const child = this.child;
			const stdout_chunks: Uint8Array[] = [];
			const stderr_chunks: Uint8Array[] = [];
			child.stdout.on("data", chunk => stdout_chunks.push(chunk));
			child.stderr.on("data", chunk => stderr_chunks.push(chunk));
			child.on("close", (exit_code, signal) => {
				resolve({
					exit_code,
					signal,
					stdout: Buffer.concat(stdout_chunks),
					stderr: utf8.decode(Buffer.concat(stderr_chunks)),
				});
			});
			child.stdin.end(input);
		});
	}

	public write(data: string | Uint8Array): Promise<void> {
		return new Promise((resolve, reject) => {
			this.child.stdin.write(data, error => {
				if (error) {
					reject(error);
				} else {
					resolve();
				}
			});
		});
	}

	public async read(size?: number): Promise<Buffer> {
		await once(this.child.stdout, "readable");
		return await this.child.stdout.read(size);
	}

	public async pipe(data?: string | Uint8Array): Promise<Uint8Array> {
		console.log(`pipe: ${data}`);
		const output = await this.finish(data);
		if (output.signal || (output.exit_code && output.exit_code != 0)) {
			throw output;
		} else {
			return output.stdout;
		}
	}

	public pipe_text(data?: string | Uint8Array): Promise<string> {
		return this.pipe(data).then(output => utf8.decode(output));
	}

	public async pipe_command(data: string | Uint8Array): Promise<Buffer> {
		await this.write(data);
		return this.read();
	}
}
