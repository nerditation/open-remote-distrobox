// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: (C) 2024, 2025 nerditation <nerditation@users.noreply.github.com>
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.


import * as vscode from 'vscode';

import * as dbx from './distrobox';
import { DistroboxResolver } from './resolver';

// `context.subscriptions` does NOT await async operations
// have to use the `deactivate()` hook
let resolved: DistroboxResolver | undefined;

export async function activate(context: vscode.ExtensionContext) {
	console.log('Congratulations, your extension "proposed-api-sample" is now active!');

	context.subscriptions.push(
		vscode.window.registerTreeDataProvider("distrobox.guests", new DistroboxLister)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("open-remote-distrobox.connect", connect_command)
	)

	context.subscriptions.push(
		vscode.workspace.registerRemoteAuthorityResolver("distrobox", {
			async resolve(authority, _context) {
				console.log(`resolving ${authority}`);

				const [_remote, guest_name_encoded] = authority.split('+', 2);
				const guest_name = decodeURIComponent(guest_name_encoded);
				const cmd = await dbx.MainCommandBuilder.auto();

				const resolver = await DistroboxResolver.for_guest_distro(cmd, guest_name);

				const running_port = parseInt((await resolver.find_running_server_port()), 10);
				if (!isNaN(running_port)) {
					console.log(`running server listening at ${running_port}`);
					resolved = resolver;
					context.subscriptions.push(
						vscode.workspace.registerResourceLabelFormatter({
							scheme: 'vscode-remote',
							authority: 'distrobox+*',
							formatting: {
								label: "${path}",
								separator: "/",
								tildify: true,
								normalizeDriveLetter: false,
								workspaceSuffix: `distrobox: ${guest_name}`,
								workspaceTooltip: `Connected to ${guest_name}`
							}
						})
					)
					return new vscode.ResolvedAuthority("localhost", running_port)
				}

				if (!await resolver.is_server_installed()) {
					let buffer: Uint8Array[] = await resolver.download_server_tarball();
					await resolver.extract_server_tarball(buffer);
				}

				const new_port = parseInt((await resolver.try_start_new_server()), 10);
				if (!isNaN(new_port)) {
					console.log(`new server started at ${new_port}`);
					resolved = resolver;
					context.subscriptions.push(
						vscode.workspace.registerResourceLabelFormatter({
							scheme: 'vscode-remote',
							authority: 'distrobox+*',
							formatting: {
								label: "${path}",
								separator: "/",
								tildify: true,
								normalizeDriveLetter: false,
								workspaceSuffix: `distrobox: ${guest_name}`,
								workspaceTooltip: `Connected to ${guest_name}`
							}
						})
					)
					return new vscode.ResolvedAuthority("localhost", new_port)
				}
				throw vscode.RemoteAuthorityResolverError.TemporarilyNotAvailable("failed to launch server in guest distro")
			},

			// distrobox guests share the host network, so port forwarding is just nop
			tunnelFactory(tunnelOptions, tunnelCreationOptions): Thenable<vscode.Tunnel> | undefined {
				const host = tunnelOptions.remoteAddress.host;
				// this should be unnecessary, I'm just paranoid, just in case.
				if (host != "localhost"
					&& host != "127.0.0.1"
					&& host != "::1"
					&& host != "*"
					&& host != "0.0.0.0"
					&& host != "::") {
					console.log(`forwarding port for ${host}`)
					return undefined;
				}
				return new Promise((resolve, reject) => {
					const dispose_event = new vscode.EventEmitter<void>();
					resolve({
						remoteAddress: tunnelOptions.remoteAddress,
						protocol: tunnelOptions.protocol,
						localAddress: tunnelOptions.remoteAddress,
						onDidDispose: dispose_event.event,
						dispose() {
							dispose_event.fire();
							dispose_event.dispose;
						}
					})
				})
			},
		})
	)

}

export async function deactivate() {
	console.log("deactivation")
	if (resolved) {
		await resolved.shutdown_server();
	}
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
			const cmd = await dbx.MainCommandBuilder.auto();
			const list = await cmd.list().run();
			const current_distro = process.env.CONTAINER_ID ?? "";
			return list.map(distro => distro["name"]).filter(name => name != current_distro)
		}
	}
}

async function connect_command(name?: string) {
	if (!name) {
		const current_distro = process.env.CONTAINER_ID ?? "";
		const cmd = await dbx.MainCommandBuilder.auto();
		const selected = await vscode.window.showQuickPick(
			cmd.list().run().then(distros => distros.map(distro => distro["name"]).filter(name => name != current_distro)),
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
