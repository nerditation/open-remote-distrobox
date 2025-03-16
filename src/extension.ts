// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: (C) 2024, 2025 nerditation <nerditation@users.noreply.github.com>
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.


import * as vscode from 'vscode';
import * as os from 'os';

import { register_distrobox_remote_authority_resolver, } from './resolver';
import { DistroManager, GuestDistro } from './agent';
import { register_remote_explorer_view, TargetsView } from './view';
import { register_extra_commands } from './extras';


/**
 * the memto `ExtensionContext.globalState` can only store serailizable data,
 * I want to proper encapsulation of the "global" state for the entire exension
 */
export interface ExtensionGlobals {
	context: vscode.ExtensionContext,
	container_manager: DistroManager,
	logger: vscode.LogOutputChannel,
}

export async function activate(context: vscode.ExtensionContext) {

	const logger = vscode.window.createOutputChannel("Distrobox", { log: true });

	const g: ExtensionGlobals = {
		context,
		logger,
		container_manager: await DistroManager.which(logger),
	};

	register_remote_explorer_view(g);

	register_distrobox_remote_authority_resolver(g);

	context.subscriptions.push(
		vscode.commands.registerCommand("open-remote-distrobox.connect", connect_command(g, "current"))
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("open-remote-distrobox.connect-new-window", connect_command(g, "new"))
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("open-remote-distrobox.reopen-workspace-in-guest", reopen_command(g))
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("open-remote-distrobox.settings", () => vscode.commands.executeCommand("workbench.action.openSettings", "@ext:nerditation.open-remote-distrobox"))
	);

	register_extra_commands(g);
}


function connect_command(g: ExtensionGlobals, window: 'current' | 'new') {
	return async (guest?: string | GuestDistro) => {
		let name;
		if (guest instanceof GuestDistro) {
			name = guest.name;
		} else if (guest) {
			name = guest;
		} else {
			const selected = await vscode.window.showQuickPick(
				await list_guest_distros(g),
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

function reopen_command(g: ExtensionGlobals) {
	return async (guest: string | GuestDistro) => {
		let name;
		if (guest instanceof GuestDistro) {
			name = guest.name;
		} else if (guest) {
			name = guest;
		} else {
			const selected = await vscode.window.showQuickPick(
				await list_guest_distros(g),
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
	};
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

async function list_guest_distros(g: ExtensionGlobals): Promise<string[]> {
	const manager = g.container_manager;
	const list = await manager.refresh_guest_list();
	let current_distro = '';
	if (process.env.CONTAINER_ID) {
		current_distro = process.env.CONTAINER_ID;
	}
	return list.map(guest => guest.name).filter(name => name != current_distro);
}

function strip_prefix(subject: string, prefix: string): string {
	console.assert(subject.startsWith(prefix));
	return subject.slice(prefix.length);
}
