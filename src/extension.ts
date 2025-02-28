// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: (C) 2024, 2025 nerditation <nerditation@users.noreply.github.com>
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.


import * as vscode from 'vscode';
import * as os from 'os';

import * as dbx from './distrobox';
import { DistroboxResolver, ServerInformation } from './resolver';

// `context.subscriptions` does NOT await async operations
// have to use the `deactivate()` hook
const resolved: DistroboxResolver[] = [];

export async function activate(context: vscode.ExtensionContext) {
	const refresh_requested = new vscode.EventEmitter<void>;

	context.subscriptions.push(refresh_requested);

	context.subscriptions.push(
		vscode.window.registerTreeDataProvider("distrobox.guests", new DistroboxLister(refresh_requested.event))
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("open-remote-distrobox.connect", connect_command("current"))
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("open-remote-distrobox.connect-new-window", connect_command("new"))
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("open-remote-distrobox.reopen-workspace-in-guest", reopen_command)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("open-remote-distrobox.refresh", () => refresh_requested.fire())
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("open-remote-distrobox.settings", () => vscode.commands.executeCommand("workbench.action.openSettings", "@ext:nerditation.open-remote-distrobox"))
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("open-remote-distrobox.create", create_command)
	);

	context.subscriptions.push(
		vscode.workspace.registerRemoteAuthorityResolver("distrobox", {
			async resolve(authority, _context) {
				console.log(`resolving ${authority}`);

				const [_remote, guest_name_encoded] = authority.split('+', 2);
				const guest_name = decodeURIComponent(guest_name_encoded);
				const cmd = await dbx.MainCommandBuilder.auto();

				const resolver = await DistroboxResolver.for_guest_distro(cmd, guest_name);

				const port = await resolver.resolve_server_port();
				if (port) {
					resolved.push(resolver);
					context.subscriptions.push(
						vscode.workspace.registerResourceLabelFormatter({
							scheme: 'vscode-remote',
							authority: 'distrobox+*',
							formatting: {
								label: "${path}",
								separator: "/",
								tildify: true,
								normalizeDriveLetter: false,
								workspaceSuffix: `distrobox: ${guest_name}`,
								workspaceTooltip: `Connected to ${guest_name}`
							}
						})
					);
					context.subscriptions.push(
						vscode.window.registerTreeDataProvider("distrobox.server-info", await ServerInformation.from(resolver))
					);
					return new vscode.ResolvedAuthority("localhost", port);
				}
				throw vscode.RemoteAuthorityResolverError.TemporarilyNotAvailable("failed to launch server in guest distro");
			},

			// distrobox guests share the host network, so port forwarding is just nop
			tunnelFactory(tunnelOptions, tunnelCreationOptions): Thenable<vscode.Tunnel> | undefined {
				const host = tunnelOptions.remoteAddress.host;
				// this should be unnecessary, I'm just paranoid, just in case.
				if (host != "localhost"
					&& host != "127.0.0.1"
					&& host != "::1"
					&& host != "*"
					&& host != "0.0.0.0"
					&& host != "::") {
					console.log(`forwarding port for ${host}`);
					return undefined;
				}
				return new Promise((resolve, reject) => {
					const dispose_event = new vscode.EventEmitter<void>();
					resolve({
						remoteAddress: tunnelOptions.remoteAddress,
						protocol: tunnelOptions.protocol,
						localAddress: tunnelOptions.remoteAddress,
						onDidDispose: dispose_event.event,
						dispose() {
							dispose_event.fire();
							dispose_event.dispose;
						}
					});
				});
			},
		})
	);

}

export async function deactivate() {
	console.log("deactivation");
	for (const resolver of resolved) {
		await resolver.shutdown_server();
	}
}

class DistroboxLister implements vscode.TreeDataProvider<string> {

	constructor(public onDidChangeTreeData: vscode.Event<void>) { }

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
			return [];
		} else {
			return list_guest_distros();
		}
	}
}

function connect_command(window: 'current' | 'new') {
	return async (name?: string) => {
		if (!name) {
			const selected = await vscode.window.showQuickPick(
				await list_guest_distros(),
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

async function reopen_command(name: string) {
	if (!name) {
		const current_distro = process.env.CONTAINER_ID ?? "";
		const cmd = await dbx.MainCommandBuilder.auto();
		const selected = await vscode.window.showQuickPick(
			cmd.list().run().then(distros => distros.map(distro => distro["name"]).filter(name => name != current_distro)),
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

async function list_guest_distros(): Promise<string[]> {
	const cmd = await dbx.MainCommandBuilder.auto();
	const list = await cmd.list().run();
	let current_distro = '';
	if (process.env.CONTAINER_ID) {
		current_distro = process.env.CONTAINER_ID;
	}
	return list.map(distro => distro["name"]).filter(name => name != current_distro);
}

function strip_prefix(subject: string, prefix: string): string {
	console.assert(subject.startsWith(prefix));
	return subject.slice(prefix.length);
}

// TODO:
// better to show a user friendly wizard dialog, but I don't know how
// maybe take a look at https://github.com/robstryker/vscode-wizard-example-extension
async function create_command() {
	const cmd = await dbx.MainCommandBuilder.auto();

	const name = await vscode.window.showInputBox({
		ignoreFocusOut: true,
		title: "name",
		placeHolder: "type the name of the distrobox container. empty input will cancel",
	});
	if (!name || name == "") {
		return;
	}

	const list_compatibile_images = async (cmd: dbx.MainCommandBuilder): Promise<string[]> => {
		const { stdout } = await cmd.create().compatibility().exec();
		return stdout.split('\n').map(s => s.trim()).filter(s => s != "");
	}
	let image = await vscode.window.showQuickPick(list_compatibile_images(cmd), {
		ignoreFocusOut: true,
		title: "compatible image",
		placeHolder: "select a compatible image, or press Escape for custom image",
	});
	if (!image) {
		image = await vscode.window.showInputBox({
			ignoreFocusOut: true,
			title: "custom image",
			placeHolder: "type the image you want to use, empty input will cancel"
		});
		if (!image || image == "") {
			return;
		}
	}

	const builder = cmd.create()
		.yes()
		.name(name)
		.image(image);

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
		const hostname = await vscode.window.showInputBox({
			ignoreFocusOut: true,
			title: "hostname",
			placeHolder: "the hostname of the guest system. default: localhost.localdomain",
		});
		if (hostname && hostname != "") {
			builder.hostname(hostname);
		}
		const home = await vscode.window.showInputBox({
			ignoreFocusOut: true,
			title: "home",
			placeHolder: "the home directory. default: same as host",
		});
		if (home && home != "") {
			builder.home(home);
		}
		const volume = await vscode.window.showInputBox({
			ignoreFocusOut: true,
			title: "volume",
			placeHolder: "additional volumes to add to the container",
		});
		if (volume && volume != "") {
			builder.volume(volume);
		}
		const af = await vscode.window.showInputBox({
			ignoreFocusOut: true,
			title: "additional flags",
			placeHolder: "additional flags to pass to the container manager command"
		});
		if (af && af != "") {
			builder.additional_flags(af);
		}
		const ap = await vscode.window.showInputBox({
			ignoreFocusOut: true,
			title: "addtional packages",
			placeHolder: "additional packages to install during initial container setup"
		});
		if (ap && ap != "") {
			builder.additional_packages(ap);
		}
		const init_hooks = await vscode.window.showInputBox({
			ignoreFocusOut: true,
			title: "init hooks",
			placeHolder: "additional commands to execute at the END of container initialization",
		});
		if (init_hooks && init_hooks != "") {
			builder.init_hooks(init_hooks);
		}
		const pre_init_hooks = await vscode.window.showInputBox({
			ignoreFocusOut: true,
			title: "pre-init hooks",
			placeHolder: "additional commands to execute at the START of container initialization",
		});
		if (pre_init_hooks && pre_init_hooks != "") {
			builder.pre_init_hooks(pre_init_hooks);
		}

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
				pick("no entry", "do not generate a container entry in the application list"),
				pick("verbose", "show more verbosity"),
				pick("dry run", "only print the container manager command generated"),
				pick("pull", "pull the image even if it exsists locally"),
				pick("init", "use init system (like systemd) inside the container. this will make host's process not visible from within the container. (assumes --unshare-process)"),
				pick("nvidia", "try to integrate host's nVidia drivers in the guest"),
				separator("container namespaces"),
				pick("unshare all", "activate all the unshare flags below"),
				pick("unshare devsys", "do not share host devices and sysfs dirs from host"),
				pick("unshare groups", "do not forward user's additional groups into the container"),
				pick("unshare ipc", "do not share ipc namespace with host"),
				pick("unshare netns", "do not share the net namespace with host"),
				pick("unshare process", "do not share process namespace with host"),
			],
			{
				ignoreFocusOut: true,
				canPickMany: true,
				title: "flags",
				placeHolder: "select the flags you want to set",
			}
		) ?? [];
		const flags = new Set(flag_picks.map(item => item.label));
		if (flags.has("no entry")) {
			builder.no_entry();
		}
		if (flags.has("verbose")) {
			builder.verbose();
		}
		if (flags.has("dry run")) {
			builder.dry_run();
		}
		if (flags.has("pull")) {
			builder.pull();
		}
		if (flags.has("init")) {
			builder.init();
		}
		if (flags.has("nvidia")) {
			builder.nvidia();
		}
		if (flags.has("unshare all")) {
			builder.unshare_all();
		}
		if (flags.has("unshare devsys")) {
			builder.unshare_devsys();
		}
		if (flags.has("unshare groups")) {
			builder.unshare_groups();
		}
		if (flags.has("unshare ipc")) {
			builder.unshare_ipc();
		}
		if (flags.has("unshare netns")) {
			builder.unshare_netns();
		}
		if (flags.has("unshare process")) {
			builder.unshare_process();
		}
	}
	if ("Yes" != await vscode.window.showQuickPick(
		[
			"No",
			"Yes",
		],
		{
			ignoreFocusOut: true,
			title: "final confirmation",
			placeHolder: "last chance to cancel! do you want to continue?"
		}
	)) {
		return;
	}
	const { stdout, stderr, exit_code } = await builder.exec();
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
command:

\`\`\`
${builder.build().join(' ')}
\`\`\`

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
}
