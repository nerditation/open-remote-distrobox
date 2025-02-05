// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: (C) 2024, 2025 nerditation <nerditation@users.noreply.github.com>
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.


import * as vscode from 'vscode';

import * as dbx from './distrobox';
import { server_binary_path, system_identifier } from './remote';

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
			shell.stdout?.on('end', () => resolve(buffer))
		});
		const running_port = parseInt(output, 10);
		if (!isNaN(running_port)) {
			return new vscode.ResolvedAuthority("localhost", running_port)
		}

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
			shell2.stdout?.on('end', () => resolve(buffer))
		});
		const running_port2 = parseInt(output2, 10);
		if (!isNaN(running_port2)) {
			return new vscode.ResolvedAuthority("localhost", running_port2)
		}
		throw ("todo: download and extract server")
	}
}
