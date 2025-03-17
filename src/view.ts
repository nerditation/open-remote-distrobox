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
import { ContainerManager, GuestContainer } from './agent';
import { ExtensionGlobals } from './extension';


/**
 * the `Targets` section of the remote explorer view
 *
 * https://github.com/microsoft/vscode-remote-release/wiki/Remote-Explorer#sections-targets-details-and-help
 *
 * it just calls `distrobox list` to populate the list of guest distros
 */
export class TargetsView implements vscode.TreeDataProvider<GuestContainer>, vscode.Disposable {

	refresh_request: vscode.EventEmitter<void> = new vscode.EventEmitter();
	onDidChangeTreeData: vscode.Event<void> = this.refresh_request.event;

	constructor(
		public manager: ContainerManager,
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
	public async getChildren(element?: GuestContainer): Promise<GuestContainer[]> {
		if (element) {
			return [];
		} else {
			return this.manager.refresh_guest_list();
		}
	}

	public getTreeItem(element: GuestContainer): vscode.TreeItem {
		const item = new vscode.TreeItem(element.name);
		item.contextValue = "distrobox.guest";
		// full list of icons: https://code.visualstudio.com/api/references/icons-in-labels
		// `terminal-linux` is Tux
		item.iconPath = new vscode.ThemeIcon("terminal-linux");
		item.tooltip = element.image;
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
 *
 * this is just a placeholder so I can understand how to use the API.
 *
 * I don't really know what information is useful to the user, for reference,
 * microsoft's devcontainers extension would show the output of `podman inspect`
 */
export class DetailsView implements vscode.TreeDataProvider<string> {

	constructor(
		public guest: GuestContainer,
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
