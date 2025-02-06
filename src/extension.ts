// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: (C) 2024, 2025 nerditation <nerditation@users.noreply.github.com>
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.


import * as vscode from 'vscode';

import * as dbx from './distrobox';
import { server_binary_path, server_download_url, server_extract_path, system_identifier } from './remote';

export function activate(context: vscode.ExtensionContext) {
	console.log('Congratulations, your extension "proposed-api-sample" is now active!');

	context.subscriptions.push(
		vscode.window.registerTreeDataProvider("distrobox.guests", new DistroboxLister)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("open-remote-distrobox.connect", connect_command)
	)

	context.subscriptions.push(
		vscode.workspace.registerRemoteAuthorityResolver("distrobox", new DistroboxResolver())
	)
}

class DistroboxLister implements vscode.TreeDataProvider<string> {
	getTreeItem(element: string): vscode.TreeItem | Thenable<vscode.TreeItem> {
		const item = new vscode.TreeItem(element);
		item.contextValue = "distrobox.guest";
		// full list of icons: https://code.visualstudio.com/api/references/icons-in-labels
		// `terminal-linux` is Tux
		item.iconPath = new vscode.ThemeIcon("terminal-linux");
		return item;
	}
	async getChildren(element?: string | undefined): Promise<string[]> {
		if (element) {
			return []
		} else {
			const cmd = dbx.MainCommandBuilder.flatpak_spawn_host();
			const list = await cmd.list().run();
			return list.map(distro => distro["name"])
		}
	}
}

async function connect_command(name?: string) {
	if (!name) {
		const cmd = dbx.MainCommandBuilder.flatpak_spawn_host();
		const selected = await vscode.window.showQuickPick(
			cmd.list().run().then(distros => distros.map(distro => distro["name"])),
			{
				canPickMany: false
			}
		);
		if (!selected) {
			return;
		}
		name = selected;
	}
	vscode.commands.executeCommand("vscode.newWindow", {
		reuseWindow: true,
		remoteAuthority: "distrobox+" + encodeURIComponent(name)
	})
}

class DistroboxResolver implements vscode.RemoteAuthorityResolver {
	async resolve(authority: string, context: vscode.RemoteAuthorityResolverContext): Promise<vscode.ResolvedAuthority> {
		console.log(`resolving ${authority}`);
		const [_remote, guest_name_encoded] = authority.split('+', 2);
		const guest_name = decodeURIComponent(guest_name_encoded);
		const cmd = dbx.MainCommandBuilder.flatpak_spawn_host();
		const output: string = await find_running_server_port(cmd, guest_name);
		const running_port = parseInt(output, 10);
		if (!isNaN(running_port)) {
			return new vscode.ResolvedAuthority("localhost", running_port)
		}

		const output2: string = await try_start_new_server(cmd, guest_name);
		const running_port2 = parseInt(output2, 10);
		if (!isNaN(running_port2)) {
			return new vscode.ResolvedAuthority("localhost", running_port2)
		}

		let buffer: Uint8Array[] = await download_server_tarball();

		// I use `--no-workdir` and relative path for this.
		// alternative is to spawn a shell and use $HOME
		await cmd.enter(
			guest_name,
			"mkdir",
			"-p",
			`${server_extract_path('linux', 'x64')}`
		)
			.no_workdir()
			.exec();
		const tar = cmd.enter(
			guest_name,
			"tar",
			"-xz",
			"-C",
			`${server_extract_path('linux', 'x64')}`
		)
			.no_tty()
			.no_workdir()
			.spawn({
				stdio: ['pipe', 'inherit', 'inherit']
			});
		for (const chunk of buffer) {
			await new Promise<void>((resolve, reject) => {
				tar.stdin?.write(chunk, (err) => {
					if (err) {
						reject(err);
					} else {
						resolve();
					}
				})
			});
			console.log(".");
		}
		throw ("todo: download and extract server")
	}
}

async function download_server_tarball() {
	const downloader = await fetch(server_download_url('linux', 'x64'));
	// TODO: what if server didn't send `Content-Length` header?
	const total_size = parseInt((downloader.headers.get('Content-Length')!), 10);
	let buffer: Uint8Array[] = [];
	vscode.window.withProgress({
		location: vscode.ProgressLocation.Notification,
		title: "downloading vscodium-reh",
	}, async (progress, candel) => {
		for await (const chunk of downloader.body!) {
			const bytes = chunk as Uint8Array;
			progress.report({
				increment: bytes.length * 100 / total_size
			});
			buffer.push(bytes);
		}
	});
	console.log("download successful");
	return buffer;
}

async function try_start_new_server(cmd: dbx.MainCommandBuilder, guest_name: string) {
	const shell2 = cmd.enter(guest_name, "bash").spawn({ stdio: ['pipe', 'pipe', 'inherit'] });
	// TODO: PLACEHOLDER:
	// probe os and architecture properly
	shell2.stdin?.write(
		`
			RUN_DIR=$XDG_RUNTIME_DIR/vscodium-reh-${system_identifier('linux', 'x64')}
			LOG_FILE=$RUN_DIR/log
			PID_FILE=$RUN_DIR/pid
			PORT_FILE=$RUN_DIR/port
			SERVER_FILE=$HOME/${server_binary_path('linux', 'x64')}
			if [[ -f $SERVER_FILE ]]; then
				nohup $SERVER_FILE --accept-server-license-terms --telemetry-level off --host localhost --port 0 --without-connection-token > $LOG_FILE &
				echo $! > $PID_FILE

				for i in {1..5}; do
					LISTENING_ON="$(grep -oP '(?<=Extension host agent listening on )\\d+' $LOG_FILE)"
					if [[ -n $LISTENING_ON ]]; then
						break
					fi
					sleep 0.5
				done

				if [[ -n $LISTENING_ON ]]; then
					echo $LISTENING_ON | tee $PORT_FILE
				else
					echo ERROR
				fi
			else
				echo NOT INSTALLED
			fi
			`
	);
	shell2.stdin?.end();
	const output2: string = await new Promise((resolve, reject) => {
		shell2.stdout?.on('error', reject);
		let buffer = "";
		shell2.stdout?.on('data', (chunk) => buffer += new TextDecoder("utf8").decode(chunk));
		shell2.stdout?.on('end', () => resolve(buffer));
	});
	return output2;
}

async function find_running_server_port(cmd: dbx.MainCommandBuilder, guest_name: string) {
	const shell = cmd.enter(guest_name, "bash").spawn({ stdio: ['pipe', 'pipe', 'inherit'] });
	// TODO: PLACEHOLDER:
	// probe os and architecture properly
	shell.stdin?.write(
		`
			PORT_FILE=\${XDG_RUNTIME_DIR}/vscodium-reh-${system_identifier('linux', 'x64')}/port
			if [ -f \$PORT_FILE ]; then
				cat \$PORT_FILE;
			else
				echo NOT RUNNING;
			fi
			`
	);
	shell.stdin?.end();
	const output: string = await new Promise((resolve, reject) => {
		shell.stdout?.on('error', reject);
		let buffer = "";
		shell.stdout?.on('data', (chunk) => buffer += new TextDecoder("utf8").decode(chunk));
		shell.stdout?.on('end', () => resolve(buffer));
	});
	return output;
}
