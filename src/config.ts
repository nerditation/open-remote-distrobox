// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: (C) 2025 nerditation <nerditation@users.noreply.github.com>
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

/**
 * @module config
 *
 * this module contains vscodium specific information, these information are
 * used to download and install the remote server, a.k.a. reh (remote extension host)
 */

// this is marked as deprecated, but the supposed replacement `IProductService`
// isn't publicly available to extensions anyway
// see https://github.com/microsoft/vscode/blob/d65fd5ba2e7202cac14316c2935680222e1af9cb/src/typings/vscode-globals-product.d.ts#L13
declare global {
	const _VSCODE_PRODUCT_JSON: VSCodiumProductInfo;
}

// this is just the minimum required to calculate the server download url
interface VSCodiumProductInfo {
	quality: "insider" | "stable";
	commit: string;
	version: string;
	release: string;
	serverApplicationName: string,
	serverDataFolderName: string,
	// only available in insider builds, but not in stable releases
	serverDownloadUrlTemplate?: string
}

/// substitute variables in the template string
function fill_template(template: string, env: Record<string, string>): string {
	return template.replace(/\${(.*?)}/g, (_, v) => env[v]);
}

const INSIDER_SYSTEM_ID_TEMPLATE = "${os}-${arch}-${version}.${release}-insider";
const STABLE_SYSTEM_ID_TEMPLATE = "${os}-${arch}-${version}.${release}";

/**
 * return a unique identifier based on the version, os, arch
 *
 * the microsoft remote extensions uses the git commit to make sure the client
 * and server use the same protocol. but I chose a different approach.
 *
 * first, vscodium added a release number in addition to the usual version
 * number, which is based on the release day of the year, see:
 *
 * - https://github.com/VSCodium/vscodium/discussions/788
 * - https://github.com/VSCodium/vscodium/pull/1192
 *
 * and this release number is unique and is easier to compare for human than
 * a long and meaningless sha1 git commit hash.
 *
 * second, containers created by distrobox usually share the same home directory
 * with each other and with the host, so we must also take into account the os
 * and arch, for example, you canno run a `reh-linux-$arch-$ver` server on a
 * alpine linux distribution, which uses the musl libc instead of the gnu libc.
 */
export function server_identifier(os: string, arch: string): string {
	const info = {
		version: _VSCODE_PRODUCT_JSON.version.replace('-insider', ''),
		release: _VSCODE_PRODUCT_JSON.release,
		os,
		arch,
	};
	switch (_VSCODE_PRODUCT_JSON.quality) {
		case 'insider': return fill_template(INSIDER_SYSTEM_ID_TEMPLATE, info);
		case 'stable': return fill_template(STABLE_SYSTEM_ID_TEMPLATE, info);
	}
}

/**
 * this is similar to `server_identifier`, except it take into account the name
 * of the guest container, this is needed because distrobox also bind mounts the
 * `$XDG_RUNTIME_DIR` from the host to the guest. if we only use the server
 * identifier, we cannot run the same version of servers inside multiple
 * guests, say ubuntu and opensuse, at the same time.
 */
export function session_identifier(os: string, arch: string, container_name: string): string {
	return `${server_identifier(os, arch)}-${container_name}`;
}

// this is hardcoded for now
const DEFAULT_SERVER_DOWNLOAD_URL_TEMPLATE = 'https://github.com/VSCodium/vscodium/releases/download/${version}.${release}/vscodium-reh-${os}-${arch}-${version}.${release}.tar.gz';

/// return the server download url for the given os and arch
export function server_download_url(os: string, arch: string): string {
	const info = {
		version: _VSCODE_PRODUCT_JSON.version.replace('-insider', ''),
		release: _VSCODE_PRODUCT_JSON.release,
		os,
		arch,

	};
	const template = _VSCODE_PRODUCT_JSON.serverDownloadUrlTemplate ?? DEFAULT_SERVER_DOWNLOAD_URL_TEMPLATE;
	return fill_template(template, info);
}

// NOTE:
// this is different from other extensions, e.g. `open-remote-ssh` use the path
// `~/.vscodium-server/bin/${commit_hash}`, which I believe follows the
// convention of the microsoft extensions.
// I use different path for several reasons:
// - I'm only interested in `VSCodium`, which has a `release` number to uniquely
//   identify the exact release version.
// - distrobox guests typically share the `$HOME` directory, between each other,
//   and also with the host.
//   - this might cause conflicts between different guests, e.g. gnu vs musl

/**
 * return the path to the server executable
 */
export function server_command_path(os: string, arch: string): string {
	return `${_VSCODE_PRODUCT_JSON.serverDataFolderName}/bin/vscodium-reh-${server_identifier(os, arch)}/bin/${_VSCODE_PRODUCT_JSON.serverApplicationName}`;
}
