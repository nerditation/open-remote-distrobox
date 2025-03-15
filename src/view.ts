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


/**
 * the `Details` section of the remote explorer view
 */
export class DetailsView implements vscode.TreeDataProvider<string> {

	constructor(
		public guest: GuestDistro,
		public guest_os: string,
		public guest_arch: string,
		public control_script_path: string,
		public server_command_path: string,
		public server_download_url: string,
		public server_session_dir: string,
		public server_port: number,
	) {
	}

	async getChildren(element?: string | undefined): Promise<string[]> {
		if (element) {
			return [];
		} else {
			return [
				`guest name: ${this.guest.name}`,
				`guest os: ${this.guest_os}`,
				`guest architecture: ${this.guest_arch}`,
				"----------------",
				`server session directory: ${this.server_session_dir}`,
				`server path: ${this.server_command_path}`,
				`server port: ${this.server_port}`,
				`server pid (wrapper): ${(await this.guest.read_text_file(`${this.server_session_dir}/pid1`)).trim()}`,
				`server pid (node): ${(await this.guest.read_text_file(`${this.server_session_dir}/pid2`)).trim()}`,
				``
			];
		}
	}

	getTreeItem(element: string): vscode.TreeItem {
		return new vscode.TreeItem(element);
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
