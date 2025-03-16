// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: (C) 2025 nerditation <nerditation@users.noreply.github.com>
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.


/**
 * @module extras
 *
 * the commands to create and to delete distrbox guest container is not strictly
 * necessary for a `vscode-remote` authority resolver provider extension
 *
 * however, since we have a view for the list of guests, and an abstraction
 * layer to generate command line for the `distrobox` command, we might just
 * provide management commands of `create` and `delete` for convenience.
 *
 * but other uncommon commands will not be implemented.
 */

import * as vscode from "vscode";

import { DistroManager } from "./agent";
import { CreateCommandBuilder, CreateOptions, RmCommandBuilder, RmOptions } from "./distrobox";
import { ExtensionGlobals } from "./extension";

// TODO:
// better to show a user friendly wizard dialog, but I don't know how
// maybe take a look at https://github.com/robstryker/vscode-wizard-example-extension
function create_command(g: ExtensionGlobals) {
	return async () => {
		const manager = g.container_manager;

		const opts: CreateOptions = CreateCommandBuilder.default_options();
		opts.name = await vscode.window.showInputBox({
			ignoreFocusOut: true,
			title: "name",
			placeHolder: "type the name of the distrobox container. empty input will cancel",
		});
		if (!opts.name || opts.name == "") {
			return;
		}

		opts.image = await vscode.window.showQuickPick(manager.compatibility(), {
			ignoreFocusOut: true,
			title: "compatible image",
			placeHolder: "select a compatible image, or press Escape for custom image",
		});
		if (!opts.image) {
			opts.image = await vscode.window.showInputBox({
				ignoreFocusOut: true,
				title: "custom image",
				placeHolder: "type the image you want to use, empty input will cancel"
			});
			if (!opts.image || opts.image == "") {
				return;
			}
		}

		const advanced = await vscode.window.showQuickPick(
			[
				"No",
				"Yes",
			],
			{
				ignoreFocusOut: true,
				title: "advanced",
				placeHolder: "show advanced options? (they all have good default values)"
			}
		);
		if (advanced == "Yes") {
			opts.hostname = await vscode.window.showInputBox({
				ignoreFocusOut: true,
				title: "hostname",
				placeHolder: "the hostname of the guest system. default: localhost.localdomain",
			});
			opts.home = await vscode.window.showInputBox({
				ignoreFocusOut: true,
				title: "home",
				placeHolder: "the home directory. default: same as host",
			});
			opts.volume = await vscode.window.showInputBox({
				ignoreFocusOut: true,
				title: "volume",
				placeHolder: "additional volumes to add to the container",
			});
			opts.additional_flags = await vscode.window.showInputBox({
				ignoreFocusOut: true,
				title: "additional flags",
				placeHolder: "additional flags to pass to the container manager command"
			});
			opts.additional_packages = await vscode.window.showInputBox({
				ignoreFocusOut: true,
				title: "addtional packages",
				placeHolder: "additional packages to install during initial container setup"
			});
			opts.init_hooks = await vscode.window.showInputBox({
				ignoreFocusOut: true,
				title: "init hooks",
				placeHolder: "additional commands to execute at the END of container initialization",
			});
			opts.pre_init_hooks = await vscode.window.showInputBox({
				ignoreFocusOut: true,
				title: "pre-init hooks",
				placeHolder: "additional commands to execute at the START of container initialization",
			});


			const pick = (label: string, detail: string): vscode.QuickPickItem => {
				return {
					label,
					detail,
					alwaysShow: true,
				};
			};

			const separator = (label: string): vscode.QuickPickItem => {
				return {
					label,
					kind: vscode.QuickPickItemKind.Separator
				};
			};
			const flag_picks = await vscode.window.showQuickPick(
				[
					pick("no_entry", "do not generate a container entry in the application list"),
					pick("verbose", "show more verbosity"),
					pick("dry_run", "only print the container manager command generated"),
					pick("pull", "pull the image even if it exsists locally"),
					pick("init", "use init system (like systemd) inside the container. this will make host's process not visible from within the container. (assumes --unshare-process)"),
					pick("nvidia", "try to integrate host's nVidia drivers in the guest"),
					separator("container namespaces"),
					pick("unshare_all", "activate all the unshare flags below"),
					pick("unshare_devsys", "do not share host devices and sysfs dirs from host"),
					pick("unshare_groups", "do not forward user's additional groups into the container"),
					pick("unshare_ipc", "do not share ipc namespace with host"),
					pick("unshare_netns", "do not share the net namespace with host"),
					pick("unshare_process", "do not share process namespace with host"),
				],
				{
					ignoreFocusOut: true,
					canPickMany: true,
					title: "flags",
					placeHolder: "select the flags you want to set",
				}
			) ?? [];
			for (const flag of flag_picks) {
				(opts as any)[flag.label] = true;
			}
		}
		if ("Continue" != await vscode.window.showWarningMessage(
			"FINAL CONFIRMAIION",
			{
				modal: true,
				detail: "this is your last to cancel!\n\ncontinue to create the distrobox?",
			},
			"Continue"
		)) {
			return;
		}

		const { stdout, stderr, exit_code } = await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				cancellable: false,
			},
			async (progress) => {
				progress.report({
					message: "this may take a while if the image needs to be pulled from servers..."
				});
				const result = await manager.create(opts);
				return result;
			}
		);
		let show_detail;
		if (exit_code) {
			show_detail = await vscode.window.showErrorMessage(
				"error running command `distrobox create`",
				"show detail"
			);
		} else {
			show_detail = await vscode.window.showInformationMessage(
				"command `distrobox create` run successfully",
				"show detail"
			);
		}
		if (show_detail) {
			const detail = `
exit code: ${exit_code ?? 0}

stdout:

\`\`\`console
${stdout}
\`\`\`

stderr:

\`\`\`console
${stderr}
\`\`\`
`;

			const doc = await vscode.workspace.openTextDocument({
				language: "markdown",
				content: detail,
			});
			await vscode.window.showTextDocument(doc);
		}

		// TODO: use agent instead of command line builder
		if (exit_code == undefined) {
			const guest = await manager.get(opts.name);
			guest.create_terminal("distrobox initial setup").show(true);
		}
	};
}

function delete_command(g: ExtensionGlobals) {
	return async (name?: string) => {
		if (!name) {
			const manager = g.container_manager;
			name = await vscode.window.showQuickPick(
				manager.refresh_guest_list().then(list => list.map(guest => guest.name))
			);
		}
		if (!name) {
			return;
		}
		if ("Yes" != await vscode.window.showQuickPick(
			[
				"No",
				"Yes",
			],
			{
				title: "WARNING",
				placeHolder: `are you sure you want to delete the distrobox guest "${name}"?`,
			}
		)) {
			return;
		}
		const confirmation = await vscode.window.showInputBox({
			title: "manual confirmation",
			placeHolder: "any typo will cancel",
			prompt: `please type verbatim: I want to delete "${name}"`,
		});
		if (confirmation != `I want to delete "${name}"`) {
			vscode.window.showInformationMessage("delete operation cancelled");
			return;
		}

		const pick = (label: string, detail: string): vscode.QuickPickItem => {
			return {
				label,
				detail,
				alwaysShow: true,
			};
		};

		const flag_picks = await vscode.window.showQuickPick(
			[
				pick("force", "force deletion"),
				pick("rm_home", "remove the mounted hoe if it differs from the host user's one"),
				pick("verbose", "show more verbosity"),
			],
			{
				canPickMany: true,
				title: "flags",
				placeHolder: "select the flags you want to set",
			}
		);
		if (!flag_picks) {
			return;
		}
		const flags: RmOptions = RmCommandBuilder.default_options();
		for (const flag of flag_picks) {
			(flags as any)[flag.label] = true;
		}
		if ("Yes, Please Delete It" != await vscode.window.showWarningMessage(
			"FINAL CONFIRMAIION",
			{
				modal: true,
				detail: "this is your LAST CHANCE to cancel!\n\nare you really sure you want to delete it?",
			},
			"Yes, Please Delete It"
		)) {
			return;
		}

		const manager = g.container_manager;
		const { stdout, stderr, exit_code } = await manager.delete(name, flags);

		let show_detail;
		if (exit_code) {
			show_detail = await vscode.window.showErrorMessage(
				"error running command `distrobox rm`",
				"show detail"
			);
		} else {
			show_detail = await vscode.window.showInformationMessage(
				"command `distrobox rm` run successfully",
				"show detail"
			);
		}
		if (show_detail) {
			const detail = `
exit code: ${exit_code ?? 0}

stdout:

\`\`\`console
${stdout}
\`\`\`

stderr:

\`\`\`console
${stderr}
\`\`\`
`;

			const doc = await vscode.workspace.openTextDocument({
				language: "markdown",
				content: detail,
			});
			await vscode.window.showTextDocument(doc);
		}
	};
}

export function register_extra_commands(g: ExtensionGlobals) {

	g.context.subscriptions.push(
		vscode.commands.registerCommand("open-remote-distrobox.create", create_command(g)),
		vscode.commands.registerCommand("open-remote-distrobox.delete", delete_command(g)),
	);
}
