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


## supported setups

I try to support these use cases:

- vscodium is installed locally on the host
- vscodium is installed via flatpak
  - will use `flatpak-spawn --host` to run the `distrobox` command
- vscodium is installed inside a guest distrobox
  - will use `distrobox-host-exec` to run the `distrobox` command

I didn't test the extension for all these scenarios, any feedbacks are welcome.


## some notes

this extension neither depends on, nor conflicts with [vscode-remote-oss].

I wrote and tested this extension for [vscodium], it probably won't work with
other `vscode` distributions.

just like [vscode-remote-oss], this extension needs proposed apis to activate.
you can run the `Preferences: Configure Runtime Arguments ` command and add:

```jsonc
{
	//..
	"enable-proposed-api": [
		//...,
		"nerditation.open-remote-distrobox"
	],
	//...
}
```

this extension registered the remote authority `distrobox`, so it will be
automatically activated when a url like this is opened:

```text
vscode-remote://distrobox+${guest_distro_name}/${path}
```

here's a modified version of the example [vscode-distrobox] script presented
in the [integrate-vscode-distrobox] blog post.

```bash
#!/bin/sh

container_name="$(printf '{"containerName":"%s"}' "$1" | od -A n -t x1 | tr -d "\n\t ")"

if command -v codium 2> /dev/null > /dev/null; then
	code_command="codium"
elif flatpak list | grep -q com.vscodium.codium; then
	code_command="flatpak run com.vscodium.codium"
else
	echo "vscodium not installed"
	exit 127
fi

${code_command} --folder-uri="vscode-remote://distrobox+${container_name}/$(realpath "${2}")"
```


## license

this extension is released under Mozilla Public License Version 2.0.

SPDX-License-Identifier: MPL-2.0  
SPDX-PackageCopyrightText: Copyright nerditation <nerditation@users.noreply.github.com>


--------

[vscodium]: https://github.com/VSCodium
[open-remote-wsl]: https://github.com/jeanp413/open-remote-wsl
[distrobox]: https://github.com/89luca89/distrobox
[vscode-remote-oss]: https://github.com/xaberus/vscode-remote-oss
[vscode-distrobox]: https://github.com/89luca89/distrobox/blob/3b9f0e8d3d8bd102e1636a22afffafe00777d30b/extras/vscode-distrobox
[integrate-vscode-distrobox]: https://distrobox.it/posts/integrate_vscode_distrobox/
