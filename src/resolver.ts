// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: (C) 2025 nerditation <nerditation@users.noreply.github.com>
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

/**
 * @module resolver
 *
 * implement the full process to download, install, launch the remote server,
 * and to extract the port number the server is listening at.
 *
 * this module uses the `distrobox` module to run commands in the guest distro.
 * most of the commands are executed through `bash` scripts that is piped to
 * the `stdin` of the bash process.
 *
 * distrobox will always install bash for the guest, even for distros with
 * different default shell, such as `alpine` linux
 */


import { homedir } from 'os';
import * as vscode from 'vscode';
import * as config from './config';
import * as setup from './setup';
import { ExtensionGlobals } from "./extension";
import { DetailsView } from './view';
import { GuestContainer } from './agent';
import { normalize_command_argument } from './utils';


/**
 * the above class is stateful and slow to setup, I want the extension
 * activation be fast.
 */
class RemoteAuthorityResolver implements vscode.RemoteAuthorityResolver {

	constructor(
		public g: ExtensionGlobals,
	) {
	}

	async resolve(authority: string, _context: vscode.RemoteAuthorityResolverContext) {
		const logger = this.g.logger;
		logger.appendLine(`resolving ${authority}`);

		const [remote, guest_name_encoded] = authority.split('+', 2);
		console.assert(remote == "distrobox");
		const guest_name = decodeURIComponent(guest_name_encoded);
		const manager = this.g.container_manager;
		const guest = await manager.get(guest_name);
		const [os, arch] = await setup.detect_platform(guest);
		logger.appendLine(`guest container: ${os}-${arch}`);

		// prepare the script
		const xdg_runtime_dir = (await guest.exec("bash", "-c", 'echo "$XDG_RUNTIME_DIR"')).stdout.trim();
		const server_session_dir = `${xdg_runtime_dir}/distrobox-vscodium-server-${config.session_identifier(os, arch, guest_name)}`;
		const control_script_path = `${server_session_dir}/control-${this.g.context.extension.packageJSON.version}.sh`;

		// first try it optimistically, to reduce startup latency
		let port = NaN;
		try {
			const output = await guest.exec(control_script_path, "synchronized-start");
			logger.appendLine(`first attempt output: ${output.stdout}`);
			port = parseInt(output.stdout);
		} catch (e) {
			logger.appendLine(`first attemp failed: ${e}`);
		}

		let server_install_path = config.server_install_path(os, arch);
		if (!server_install_path.startsWith('/')) {
			server_install_path = `$HOME/${server_install_path}`;
		}
		const server_tarball_url = config.server_download_url(os, arch);

		let server_command_full_path = "unknown";
		// do it properly
		if (isNaN(port)) {
			logger.appendLine("preparing server control script");

			const server_application_name = config.server_application_name();
			await guest.write_executable_file(
				control_script_path,
				setup.get_control_script(server_install_path, server_application_name)
			);

			logger.appendLine(`control script written to ${control_script_path}`);
			server_command_full_path = await guest.find_file_by_name(server_install_path, server_application_name);
			if (!await guest.is_file(server_command_full_path)) {
				logger.appendLine(`server not installed, start downloading from: ${server_tarball_url}`);
				const buffer = await setup.download_server_tarball(server_tarball_url);
				logger.appendLine(`server downloaded, extracting into: ${server_install_path}`);
				await guest.exec_with_input(buffer, control_script_path, "install");
				logger.appendLine("server installed");
			}

			const output = await guest.exec(control_script_path, "synchronized-start");
			port = parseInt(output.stdout);

			logger.appendLine(`second attempt output: ${output.stdout}`);
		}

		if (!isNaN(port)) {
			this.g.context.subscriptions.push(
				{
					dispose() {
						logger.appendLine(`disconnecting from remote server`);
						guest.exec(control_script_path, "synchronized-disconnect").child.unref();
					},
				},
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
				}),
				vscode.window.registerTreeDataProvider(
					"distrobox.server-info",
					new DetailsView(
						guest,
						os,
						arch,
						control_script_path,
						server_command_full_path,
						server_tarball_url,
						server_session_dir,
						port
					),
				)
			);
			return new vscode.ResolvedAuthority("localhost", port);
		}
		throw vscode.RemoteAuthorityResolverError.TemporarilyNotAvailable("failed to launch server in guest distro");
	}

	// distrobox guests share the host network, so port forwarding is just nop
	tunnelFactory(tunnelOptions: vscode.TunnelOptions, tunnelCreationOptions: vscode.TunnelCreationOptions): Thenable<vscode.Tunnel> | undefined {
		const host = tunnelOptions.remoteAddress.host;
		this.g.logger.appendLine(`forwarding port for ${host}`);
		// this should be unnecessary, I'm just paranoid, just in case.
		if (host != "localhost"
			&& host != "127.0.0.1"
			&& host != "::1"
			&& host != "*"
			&& host != "0.0.0.0"
			&& host != "::") {
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
	}
}

export function register_distrobox_remote_authority_resolver(g: ExtensionGlobals) {

	g.context.subscriptions.push(
		vscode.workspace.registerRemoteAuthorityResolver("distrobox", new RemoteAuthorityResolver(g)),
		vscode.commands.registerCommand("open-remote-distrobox.connect", async (guest?: string | GuestContainer) => {
			const guest_name = await normalize_command_argument(g.container_manager, guest);
			if (guest_name) {
				if (vscode.env.remoteAuthority == `distrobox+${encodeURIComponent(guest_name)}`) {
					vscode.window.showInformationMessage("already connected to the same guest container");
					return;
				}
				connect_to_container(guest_name, "current");
			}
		}),
		vscode.commands.registerCommand("open-remote-distrobox.connect-new-window", async (guest?: string | GuestContainer) => {
			const guest_name = await normalize_command_argument(g.container_manager, guest);
			if (guest_name) {
				connect_to_container(guest_name, "new");
			}
		}),
		vscode.commands.registerCommand("open-remote-distrobox.reopen-workspace-in-guest", async (guest?: string | GuestContainer) => {
			const guest_name = await normalize_command_argument(g.container_manager, guest);
			if (guest_name) {
				await reopen_in_container(guest_name);
			}
		}),
		vscode.commands.registerCommand("open-remote-distrobox.cleanup-session-files", async (guest?: string | GuestContainer) => {
			const guest_name = await normalize_command_argument(g.container_manager, guest);
			if (guest_name) {
				if (vscode.env.remoteAuthority == `distrobox+${encodeURIComponent(guest_name)}`) {
					vscode.window.showInformationMessage("to run this command, please close remote connection first");
					return;
				}
				const guest = await g.container_manager.get(guest_name);
				const [os, arch] = await setup.detect_platform(guest);
				const server_session_dir_name = `distrobox-vscodium-server-${config.session_identifier(os, arch, guest_name)}`;
				const full_path = `$XDG_RUNTIME_DIR/${server_session_dir_name}`;
				await guest.exec("bash", "-c", `rm -rf "${full_path}"`);
				vscode.window.showInformationMessage(`session directory ${full_path} has been deleted, if your previous remote session crashed, the server might be still running, it is recommended to manually kill the server processes or stop and restart the guest container ${guest_name}`);
			}
		})
	);
}

// implement the "connect" and "connect-new-window" commands
function connect_to_container(name: string, window: "current" | "new") {
	vscode.commands.executeCommand("vscode.newWindow", {
		reuseWindow: window == 'current',
		remoteAuthority: "distrobox+" + encodeURIComponent(name)
	});
}

// implement the "reopen-workspace-in-guest" command
async function reopen_in_container(name: string) {
	const current = get_current_workspace();
	if (current?.scheme == 'file'
		|| current?.scheme == 'vscode-remote' && current.authority.startsWith('distrobox+')) {
		const uri = vscode.Uri.parse(`vscode-remote://distrobox+${encodeURI(name)}${map_to_guest_path(current.fsPath)}`);
		vscode.commands.executeCommand("vscode.openFolder", uri);
	} else {
		await vscode.window.showErrorMessage(`don't know how to map to path: ${current}`);
	}
}

function get_current_workspace(): vscode.Uri | undefined {
	if (vscode.workspace.workspaceFolders?.length == 1) {
		// single root workspace
		return vscode.workspace.workspaceFolders[0].uri;
	} else if (vscode.workspace.workspaceFile) {
		// multi-root workspace, need saved `.code-workspace` file
		if (vscode.workspace.workspaceFile.scheme == 'untitled') {
			vscode.window.showInformationMessage(`please save workspace file first`);
			return;
		}
		return vscode.workspace.workspaceFile;
	} else {
		// finally, if no workspace is open but a `.code-workspace` file is open
		const file = vscode.window.activeTextEditor?.document.uri;
		if (file?.fsPath.endsWith(".code-workspace")) {
			return file;
		}
		vscode.window.showErrorMessage("no current workspace");
		return;
		/*
		const fileUri = vscode.Uri.from({
			scheme: "vscode-remote",
			authority: `distrobox+${encodeURIComponent(name)}`,
			path: current.fsPath,
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
		*/
	}

}

function map_to_guest_path(path: string): string {
	// if it's within $HOME or it's already mapped to `/run/host`
	if (path.startsWith(homedir()) || path.startsWith('/run/host/')) {
		return path;
	} else {
		return `/run/host${path}`;
	}
}
