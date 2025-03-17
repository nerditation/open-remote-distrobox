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


import * as vscode from 'vscode';
import { server_binary_path, server_download_url, system_identifier } from './remote';
import { ExtensionGlobals } from "./extension";
import { DetailsView } from './view';
import { detect_platform, download_server_tarball, get_control_script } from './setup';


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
		const [os, arch] = await detect_platform(guest);
		logger.appendLine(`guest container: ${os}-${arch}`);

		// prepare the script
		const xdg_runtime_dir = (await guest.exec("bash", "-c", 'echo "$XDG_RUNTIME_DIR"')).stdout.trim();
		const server_session_dir = `${xdg_runtime_dir}/vscodium-reh-${system_identifier(os, arch)}-${guest.name}`;
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

		const server_command_path = `$HOME/${server_binary_path(os, arch)}`;
		const server_tarball_url = server_download_url(os, arch);

		// do it properly
		if (isNaN(port)) {
			logger.appendLine("preparing server control script");

			await guest.exec("mkdir", "-p", server_session_dir);
			await guest.write_to_file(
				control_script_path,
				get_control_script(server_command_path)
			);
			await guest.exec("chmod", "+x", control_script_path);

			logger.appendLine(`control script written to ${control_script_path}`);

			if (!guest.is_file(server_command_path)) {
				logger.appendLine("server not installed, start downloading");
				const buffer = await download_server_tarball(server_tarball_url);
				logger.appendLine("server downloaded, extracting");
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
						server_command_path,
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
		// this should be unnecessary, I'm just paranoid, just in case.
		if (host != "localhost"
			&& host != "127.0.0.1"
			&& host != "::1"
			&& host != "*"
			&& host != "0.0.0.0"
			&& host != "::") {
			this.g.logger.appendLine(`forwarding port for ${host}`);
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
		vscode.workspace.registerRemoteAuthorityResolver("distrobox", new RemoteAuthorityResolver(g))
	);

}
