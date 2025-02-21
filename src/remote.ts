// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: (C) 2025 nerditation <nerditation@users.noreply.github.com>
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

/**
 * @module remote
 *
 * this module contains vscodium specific information, these information are
 * used to download and install the remote server, a.k.a. reh (remote extension host)
 */

import * as vscode from 'vscode';

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

export function system_identifier(os: string, arch: string): string {
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

/// return the path where the server binary is extracted
export function server_extract_path(os: string, arch: string): string {
	return _VSCODE_PRODUCT_JSON.serverDataFolderName + '/bin/vscodium-reh-' + system_identifier(os, arch);
}

export function server_binary_path(os: string, arch: string): string {
	return server_extract_path(os, arch) + '/bin/' + _VSCODE_PRODUCT_JSON.serverApplicationName;
}
