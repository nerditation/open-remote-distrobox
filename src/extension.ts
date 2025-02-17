// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: (C) 2024, 2025 nerditation <nerditation@users.noreply.github.com>
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.


import * as vscode from 'vscode';
import * as os from 'os';

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
		vscode.commands.registerCommand("open-remote-distrobox.reopen-workspace-in-guest", reopen_command)
	)

	context.subscriptions.push(
		vscode.workspace.registerRemoteAuthorityResolver("distrobox", {
			async resolve(authority, _context) {
				console.log(`resolving ${authority}`);

				const [_remote, guest_name_encoded] = authority.split('+', 2);
				const guest_name = decodeURIComponent(guest_name_encoded);
				const cmd = await dbx.MainCommandBuilder.auto();

				const resolver = await DistroboxResolver.for_guest_distro(cmd, guest_name);

				const port = await resolver.resolve_server_port();
				if (port) {
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
					return new vscode.ResolvedAuthority("localhost", port)
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
			return list_guest_distros()
		}
	}
}

async function connect_command(name?: string) {
	if (!name) {
		const selected = await vscode.window.showQuickPick(
			await list_guest_distros(),
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

async function reopen_command(name: string) {
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
	let dest;
	// common case: single root workspace
	if (vscode.workspace.workspaceFolders?.length == 1) {
		dest = vscode.workspace.workspaceFolders[0].uri;
	} else if (vscode.workspace.workspaceFile) {
		if (vscode.workspace.workspaceFile.scheme == 'untitled') {
			await vscode.window.showErrorMessage(`untitled multiroot workspace is not supported`);
			return;
		}
		dest = vscode.workspace.workspaceFile;
	} else {
		await vscode.window.showErrorMessage("workspace is not a single folder, but there's no workspace file");
		return;
	}
	if (dest.scheme == 'file'
		|| dest.scheme == 'vscode-remote' && dest.authority.startsWith('distrobox+')) {
		const path = dest.fsPath;
		const uri = vscode.Uri.parse(`vscode-remote://distrobox+${encodeURI(name)}${path}`);
		console.log(`opening ${uri}`)
		vscode.commands.executeCommand("vscode.openFolder", uri);
	} else {
		await vscode.window.showErrorMessage(`don't know how to map to path: ${dest}`);
	}
}

function map_path(path: string): string {
	console.log(`mapping ${path}`)
	// if it's within $HOME or it's already mapped to `/run/host`
	if (path.startsWith(os.homedir()) || path.startsWith('/run/host/')) {
		return path;
	} else {
		return `/run/host${path}`
	}

}

async function list_guest_distros(): Promise<string[]> {
	const cmd = await dbx.MainCommandBuilder.auto();
	const list = await cmd.list().run();
	let current_distro = '';
	if (process.env.CONTAINER_ID) {
		current_distro = process.env.CONTAINER_ID;
	} else if (vscode.env.remoteAuthority?.startsWith('distrobox+')) {
		current_distro = decodeURIComponent(strip_prefix(vscode.env.remoteAuthority, 'distrobox+'))
	}
	return list.map(distro => distro["name"]).filter(name => name != current_distro)
}

function strip_prefix(subject: string, prefix: string): string {
	console.assert(subject.startsWith(prefix));
	return subject.slice(prefix.length)
}
