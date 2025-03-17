// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: (C) 2024, 2025 nerditation <nerditation@users.noreply.github.com>
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.


import * as vscode from 'vscode';

import { register_distrobox_remote_authority_resolver, } from './resolver';
import { DistroManager } from './agent';
import { register_remote_explorer_view } from './view';
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

	register_distrobox_remote_authority_resolver(g);

	register_remote_explorer_view(g);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			"open-remote-distrobox.settings",
			() => {
				vscode.commands.executeCommand(
					"workbench.action.openSettings",
					"@ext:nerditation.open-remote-distrobox"
				);
			}
		)
	);

	register_extra_commands(g);
}
