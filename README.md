# open-remote-distrobox

[vscodium] remote development for distrobox


## overview

this extension serves similar purpose to [open-remote-wsl], except it is for
[distrobox] on Linux hosts instead of wsl on Windows.

for an explanation of vscodium remote development mechanism, please read the
documentation of [vscode-remote-oss]. [vscode-remote-oss] requires the user
to manually run the remote extension host and configure the tcp port. if you
only use [vscode-remote-oss] for distrobox, this extension just automate the
boring work for you.

## some notes

this extension neither depends on, nor conflicts with [vscode-remote-oss].

I wrote and tested this extension for [vscodium], it probably won't work with
other `vscode` distributions.


## license

this extension is released under Mozilla Public License Version 2.0.

SPDX-License-Identifier: MPL-2.0
SPDX-PackageCopyrightText: Copyright nerditation <nerditation@users.noreply.github.com>


--------

[vscodium]: https://github.com/VSCodium
[open-remote-wsl]: https://github.com/jeanp413/open-remote-wsl
[distrobox]: https://github.com/89luca89/distrobox
[vscode-remote-oss]: https://github.com/xaberus/vscode-remote-oss
