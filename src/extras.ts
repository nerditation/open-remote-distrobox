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
import { ContainerManager, GuestContainer } from "./agent";
import { normalize_command_argument as normalize_guest_name_argument } from "./utils";

async function double_confirm(name: string) {
	if ("Yes" != await vscode.window.showQuickPick(
		["No", "Yes",],
		{
			title: "WARNING",
			placeHolder: `are you sure you want to delete the distrobox guest "${name}"?`,
		}
	)) {
		return false;
	}
	const manual_confirmation = `I want to delete "${name}"`;
	return manual_confirmation == await vscode.window.showInputBox({
		title: "manual confirmation",
		placeHolder: "any typo will cancel",
		prompt: `please type verbatim: ${manual_confirmation}`,
	});
}

async function input_rm_options() {
	const option = (label: string, detail: string): vscode.QuickPickItem => {
		return {
			label,
			detail,
			alwaysShow: true,
		};
	};
	const picks = await vscode.window.showQuickPick(
		[
			option("force", "force deletion"),
			option("rm_home", "remove the mounted hoe if it differs from the host user's one"),
			option("verbose", "show more verbosity"),
		],
		{
			canPickMany: true,
			title: "flags",
		}
	);
	if (!picks) {
		return;
	}
	const options: RmOptions = RmCommandBuilder.default_options();
	for (const flag of picks) {
		(options as any)[flag.label] = true;
	}
	return options;
}

async function final_confirm(name: string) {
	return "ABSOLUTELY DELETE IT NOW" == await vscode.window.showWarningMessage(
		"FINAL CONFIRMAIION",
		{
			modal: true,
			detail: "this is your LAST CHANCE to cancel!\n\nare you really sure you want to delete it?",
		},
		"I Changed My Mind, DO NOT DELETE",
		"ABSOLUTELY DELETE IT NOW",
	);
}


export function register_extra_commands(g: ExtensionGlobals) {

	// can only run the command once
	let create_command_in_progress = false;

	g.context.subscriptions.push(
		vscode.commands.registerCommand("open-remote-distrobox.create", async () => {
			if (create_command_in_progress) {
				vscode.window.showInformationMessage("another create command didn't finish");
				return;
			}
			create_command_in_progress = true;

			const options: CreateOptions = await open_distrbox_create_view(g);

			// these extra commands is distrobox specific, use the builders directly
			const create_argv = g.container_manager.cmd.create().with_options(options).build();
			const create_argv0 = create_argv.shift()!;
			await run_as_task("distrobox create", create_argv0, create_argv);

			vscode.window.showInformationMessage("running initial setup, this may take a while");

			const enter_argv = g.container_manager.cmd.enter(options.name, "echo", "initial setup finished").build();
			const enter_argv0 = enter_argv.shift()!;
			await run_as_task("distrobox initial setup", enter_argv0, enter_argv);

			await vscode.commands.executeCommand("open-remote-distrobox.refresh");
			create_command_in_progress = false;
		}),
		vscode.commands.registerCommand("open-remote-distrobox.delete", async (guest?: string | GuestContainer) => {
			const name = await normalize_guest_name_argument(g.container_manager, guest);
			if (!name) {
				return;
			}
			if (!await double_confirm(name)) {
				return;
			}
			const options = await input_rm_options();
			if (!options) {
				return;
			}
			if (!await final_confirm(name)) {
				return;
			}
			const argv = g.container_manager.cmd.rm().with_options(options).names(name).build();
			const argv0 = argv.shift()!;
			await run_as_task("distrobox rm", argv0, argv);
			await vscode.commands.executeCommand("open-remote-distrobox.refresh");
		}),
	);
}

function open_distrbox_create_view(g: ExtensionGlobals): Promise<CreateOptions> {
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
					webviewView.webview.html = await get_html(g.context);
					webviewView.webview.onDidReceiveMessage(async (message: "loaded" | CreateOptions) => {
						if (message == "loaded") {
							webviewView.webview.postMessage(await get_compatible_images(g.container_manager));
							return;
						}
						const options = message;
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

/**
 * a wrapper for `distrobox create --compatibility` command
 */
async function get_compatible_images(manager: ContainerManager): Promise<string[]> {
	const { stdout } = await manager.cmd.create().compatibility().exec();
	return stdout.split('\n').map(s => s.trim()).filter(s => s != "");
}

async function get_html(context: vscode.ExtensionContext) {
	const src_path = context.asAbsolutePath('media/distrobox-create-view.html');
	return await readFile(src_path, { encoding: "utf8" });
}

async function run_as_task(task_name: string, command: string, args: string[]) {
	const task_id = `distrobox-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
	// the doc says global tasks are not supported, but it seems to be working,
	// if I set `cwd` manually. if `cwd` is missing, it will try to expand the
	// `${workspaceFoler}` variable, which can throw if not in a workspace
	// here it doesn't really matter what `cwd` is, as long it's valid directory.
	const task = new vscode.Task(
		{
			type: "distrobox",
			id: task_id,
		},
		vscode.TaskScope.Global,
		task_name,
		"open-remote-distrobox",
		new vscode.ProcessExecution(command, args, { cwd: process.cwd() }),
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
