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
const resolved: DistroboxResolver[] = [];

export async function activate(context: vscode.ExtensionContext) {
	const refresh_requested = new vscode.EventEmitter<void>;

	context.subscriptions.push(refresh_requested);

	context.subscriptions.push(
		vscode.window.registerTreeDataProvider("distrobox.guests", new DistroboxLister(refresh_requested.event))
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("open-remote-distrobox.connect", connect_command("current"))
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("open-remote-distrobox.connect-new-window", connect_command("new"))
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("open-remote-distrobox.reopen-workspace-in-guest", reopen_command)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("open-remote-distrobox.refresh", () => refresh_requested.fire())
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("open-remote-distrobox.settings", () => vscode.commands.executeCommand("workbench.action.openSettings", "@ext:nerditation.open-remote-distrobox"))
	);

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
					resolved.push(resolver);
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
					);
					return new vscode.ResolvedAuthority("localhost", port);
				}
				throw vscode.RemoteAuthorityResolverError.TemporarilyNotAvailable("failed to launch server in guest distro");
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
					console.log(`forwarding port for ${host}`);
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
					});
				});
			},
		})
	);

}

export async function deactivate() {
	console.log("deactivation");
	for (const resolver of resolved) {
		await resolver.shutdown_server();
	}
}

class DistroboxLister implements vscode.TreeDataProvider<string> {

	constructor(public onDidChangeTreeData: vscode.Event<void>) { }

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
			return [];
		} else {
			return list_guest_distros();
		}
	}
}

function connect_command(window: 'current' | 'new') {
	return async (name?: string) => {
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
		if (window == 'current' && vscode.env.remoteAuthority?.startsWith('distrobox+')) {
			const current = decodeURIComponent(strip_prefix(vscode.env.remoteAuthority, 'distrobox+'));
			if (name == current) {
				vscode.window.showInformationMessage(`current window already connected to ${name}`);
				return;
			}
		}
		vscode.commands.executeCommand("vscode.newWindow", {
			reuseWindow: window == 'current',
			remoteAuthority: "distrobox+" + encodeURIComponent(name)
		});
	};
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
		dest = vscode.window.activeTextEditor?.document.uri;
		if (!dest) {
			await vscode.window.showErrorMessage("nothing to re-open");
			return;
		}
		const path = dest.fsPath;
		if (!path.endsWith(".code-workspace")) {
			if (dest.scheme == "vscode-remote" && dest.authority.startsWith(name)) {
				return;
			}
			const choice = await vscode.window.showInformationMessage(
				"you have not opened a folder or workspace, do you want to re-open a single file in the guest distro? NOTE: re-using current window is not supported for single file",
				"yes",
				"no"
			);
			if (choice != "yes") {
				return;
			}
			const fileUri = vscode.Uri.from({
				scheme: "vscode-remote",
				authority: `distrobox+${encodeURIComponent(name)}`,
				path,
			});
			// NOT WORKING:
			// this command is internal to vscode and undocumented
			// I found it in the source code:
			// https://github.com/microsoft/vscode/blob/dfeb7b06f6095655ab0212ca1662e88ac6d0d045/src/vs/workbench/contrib/files/browser/fileActions.contribution.ts#L46
			// unfortunately, the `forceReuseWindow` option does NOT work.
			await vscode.commands.executeCommand(
				"_files.windowOpen",
				[{
					fileUri,
				}],
				{ forceReuseWindow: true }
			);
			return;
		}
	}
	if (dest.scheme == 'file'
		|| dest.scheme == 'vscode-remote' && dest.authority.startsWith('distrobox+')) {
		const path = dest.fsPath;
		const uri = vscode.Uri.parse(`vscode-remote://distrobox+${encodeURI(name)}${path}`);
		console.log(`opening ${uri}`);
		vscode.commands.executeCommand("vscode.openFolder", uri);
	} else {
		await vscode.window.showErrorMessage(`don't know how to map to path: ${dest}`);
	}
}

function map_path(path: string): string {
	console.log(`mapping ${path}`);
	// if it's within $HOME or it's already mapped to `/run/host`
	if (path.startsWith(os.homedir()) || path.startsWith('/run/host/')) {
		return path;
	} else {
		return `/run/host${path}`;
	}

}

async function list_guest_distros(): Promise<string[]> {
	const cmd = await dbx.MainCommandBuilder.auto();
	const list = await cmd.list().run();
	let current_distro = '';
	if (process.env.CONTAINER_ID) {
		current_distro = process.env.CONTAINER_ID;
	}
	return list.map(distro => distro["name"]).filter(name => name != current_distro);
}

function strip_prefix(subject: string, prefix: string): string {
	console.assert(subject.startsWith(prefix));
	return subject.slice(prefix.length);
}
