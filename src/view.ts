// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: (C) 2025 nerditation <nerditation@users.noreply.github.com>
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

/**
 * @module view
 *
 * the remote explorer view, i.e. `contributes.view.remote` in `package.json`
 */

import * as vscode from 'vscode';
import { DistroManager, GuestDistro } from './agent';
import { ExtensionGlobals } from './extension';


/**
 * the `Targets` section of the remote explorer view
 *
 * https://github.com/microsoft/vscode-remote-release/wiki/Remote-Explorer#sections-targets-details-and-help
 *
 * it just calls `distrobox list` to populate the list of guest distros
 */
export class TargetsView implements vscode.TreeDataProvider<GuestDistro>, vscode.Disposable {

	refresh_request: vscode.EventEmitter<void> = new vscode.EventEmitter();
	onDidChangeTreeData: vscode.Event<void> = this.refresh_request.event;

	constructor(
		public manager: DistroManager,
	) {
	}

	//-------------------------------------------------------------------
	// implementation of interface `vscode.TreeDataProvider`
	//-------------------------------------------------------------------


	/**
	 * only top level elements for the guest distros, no children element.
	 *
	 * in the future, maybe save recently opened workspaces
	 */
	public async getChildren(element?: GuestDistro): Promise<GuestDistro[]> {
		if (element) {
			return [];
		} else {
			return this.manager.refresh_guest_list();
		}
	}

	public getTreeItem(element: GuestDistro): vscode.TreeItem {
		const item = new vscode.TreeItem(element.name);
		item.contextValue = "distrobox.guest";
		// full list of icons: https://code.visualstudio.com/api/references/icons-in-labels
		// `terminal-linux` is Tux
		item.iconPath = new vscode.ThemeIcon("terminal-linux");
		return item;
	}

	//-------------------------------------------------------------------
	// implementation of interface `vscode.Disposable`
	//-------------------------------------------------------------------

	public dispose() {
		this.refresh_request.dispose();
	}

	public refresh() {
		this.refresh_request.fire();
	}
}

export function register_remote_explorer_view(g: ExtensionGlobals) {
	const targets_view = new TargetsView(g.container_manager);
	g.context.subscriptions.push(
		targets_view,
		vscode.window.registerTreeDataProvider("distrobox.guests", targets_view),
		vscode.commands.registerCommand("open-remote-distrobox.refresh", () => targets_view.refresh())
	);
}
