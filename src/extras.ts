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

import { CreateOptions, RmCommandBuilder, RmOptions } from "./distrobox";
import { ExtensionGlobals } from "./extension";
import { readFile } from "fs/promises";

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

let create_command_in_progress = false;

export function register_extra_commands(g: ExtensionGlobals) {

	g.context.subscriptions.push(
		vscode.commands.registerCommand("open-remote-distrobox.create", async () => {
			if (create_command_in_progress) {
				return;
			}
			if (!vscode.workspace.workspaceFolders) {
				vscode.window.showErrorMessage("due to API limitation, cannot execute tasks withou an open workspace");
				return;
			}
			create_command_in_progress = true;

			const options: CreateOptions = await open_distrbox_create_view(g.context);

			// these extra commands is distrobox specific, use the builders directly
			const create_argv = g.container_manager.cmd.create().with_options(options).build();
			const create_argv0 = create_argv.shift()!;
			await run_as_task("distrobox create", create_argv0, create_argv);

			const enter_argv = g.container_manager.cmd.enter(options.name, "echo", "initial setup finished").build();
			const enter_argv0 = enter_argv.shift()!;
			await run_as_task("distrobox initial setup", enter_argv0, enter_argv);

			await vscode.commands.executeCommand("open-remote-distrobox.refresh");
			create_command_in_progress = false;
		}),
		vscode.commands.registerCommand("open-remote-distrobox.delete", delete_command(g)),
	);
}

function open_distrbox_create_view(context: vscode.ExtensionContext): Promise<CreateOptions> {
	vscode.commands.executeCommand("setContext", "distrobox.showCreateView", true);
	return new Promise((resolve, reject) => {
		const disposable = vscode.window.registerWebviewViewProvider(
			"distrobox.create",
			{
				async resolveWebviewView(webviewView, _context, token) {
					webviewView.webview.options = {
						enableScripts: true,
						enableForms: true,
					};
					webviewView.webview.html = await get_html(context);
					// TODO: send compatible image list to webview
					webviewView.webview.onDidReceiveMessage(async (options: CreateOptions) => {
						if (!options.name || !options.image) {
							vscode.window.showErrorMessage("required fields not filled");
						} else {
							await vscode.commands.executeCommand("setContext", "distrobox.showCreateView", false);
							disposable.dispose();
							resolve(options);
						}
					});
				},
			},
			{
				webviewOptions: { retainContextWhenHidden: true }
			}
		);
	});
}

async function get_html(context: vscode.ExtensionContext) {
	const src_path = context.asAbsolutePath('media/distrobox-create-view.html');
	return await readFile(src_path, { encoding: "utf8" });
}

async function run_as_task(task_name: string, command: string, args: string[]) {
	const task_id = `distrobox-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
	const task = new vscode.Task(
		{
			type: "distrobox",
			id: task_id,
		},
		vscode.TaskScope.Workspace,
		task_name,
		"open-remote-distrobox",
		new vscode.ProcessExecution(command, args),
	);
	task.presentationOptions.echo = true;
	task.presentationOptions.focus = false;
	task.presentationOptions.panel = vscode.TaskPanelKind.New;
	await vscode.tasks.executeTask(task);
	await new Promise<void>((resolve, reject) => {
		vscode.tasks.onDidEndTask(e => {
			if (e.execution.task.definition.id == task_id) {
				resolve();
			}
		});
	});
}
