// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: (C) 2025 nerditation <nerditation@users.noreply.github.com>
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import { ChildProcessWithoutNullStreams } from "child_process";
import { once } from "events";

export const utf8 = new TextDecoder("utf8");

export function delay_millis(millis: number): Promise<void> {
	return new Promise((resolve, reject) => {
		setTimeout(resolve, millis);
	});
}
