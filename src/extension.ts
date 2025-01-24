// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: (C) 2024 nerditation <nerditation@users.noreply.github.com>
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.


import { exec } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';

import * as dbx from './distrobox';

export function activate(context: vscode.ExtensionContext) {
	console.log('Congratulations, your extension "proposed-api-sample" is now active!');

	context.subscriptions.push(
		vscode.window.registerTreeDataProvider("distrobox.guests", new DistroboxLister)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("open-remote-distrobox.connect", connect_command)
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
			const list = await cmd.list().exec();
			return list.map(distro => distro["name"])
		}
	}
}

async function connect_command(name?: string) {
	if (!name) {
		const cmd = dbx.MainCommandBuilder.flatpak_spawn_host();
		const selected = await vscode.window.showQuickPick(
			cmd.list().exec().then(distros => distros.map(distro => distro["name"])),
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
