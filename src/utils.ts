// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: (C) 2025 nerditation <nerditation@users.noreply.github.com>
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import * as vscode from "vscode";

import { ContainerManager, GuestContainer } from "./agent";

export const utf8 = new TextDecoder("utf8");

export function delay_millis(millis: number): Promise<void> {
	return new Promise((resolve, reject) => {
		setTimeout(resolve, millis);
	});
}

export async function normalize_command_argument(manager: ContainerManager, guest?: string | GuestContainer): Promise<string | undefined> {
	if (guest instanceof GuestContainer) {
		return guest.name;
	} else if (guest) {
		return guest;
	} else {
		const interactive = await vscode.window.showQuickPick(
			manager.refresh_guest_list().then(guests => guests.map(guest => guest.name)),
			{
				title: "select a guest container",
				canPickMany: false
			}
		);
		if (!interactive) {
			return;
		}
		return interactive;
	}
}
