# open-remote-distrobox

[vscodium] remote development for [distrobox]


## overview

this extension serves similar purpose to [open-remote-wsl], except it is for
[distrobox] on Linux hosts instead of wsl on Windows.

for an explanation of vscodium remote development mechanism, please read the
documentation of [vscode-remote-oss]. `vscode-remote-oss` requires the user
to manually run the remote extension host and configure the tcp port. if you
only use `vscode-remote-oss` for distrobox, this extension just automate the
boring work for you.


## supported setups

I try to support these use cases:

- vscodium is installed locally on the host
- vscodium is installed via flatpak
  - will use `host-spawn` to run the `distrobox` command
- vscodium is installed inside a guest distrobox
  - will use `host-spawn` to run the `distrobox` command

I didn't test the extension for all these scenarios, any feedbacks are welcome.

> [!IMPORTANT]
>
> if you created your guest containers using the default `distrobox` options,
> everything should work. some non-default options might not be supported.
>
> first of all, this extension assumes the guest containers are sharing the
> host network namespace. it does **NOT** support guest containers which were
> created with the `--unshare-netns` option of the `distrobox create` command.
>
> also, the "reopen in distrobox guest" command assumes the guest system shares
> the user home directory with the host system. if your guest sytem had a
> custom home directory, this command would fail to map a host path into a
> guest path.


## getting started

if you have not installed [vscodium] and [distrobox] already, install them first.
distrobox is installed out of the box on `opensuse` [MicroOS] based immutable
systems, including the desktop variants `Aeon` and `Kalpa`, but if you are using
other distributions, it should be installable using the official package manager.
if it is not available, you can download from the [distrobox] github repository
or website.

if you don't have `vscodium`, I recommend the `flatpak` version.

this extension is published to `open-vsx.org`, so just search `distrobox` in
vscodium's extension panel (press `Ctrl + Shift + X` to open it), you should
be able to install it. you can also download the `.vsix` package from
`open-vsx.org` or from the [releases] page of this github repository.

after installation, you need to enable proposed api for this extension, this can
be done by running the command `Preferences: Configure Runtime Arguments`, and
add the following content to the opened `argv.json` file:

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

save the file an restart vscodium, now you should be able to open the remote
explorer view in the side bar. if you have other extensions that also contribute
to the remote explorer, such as [vscode-remote-oss], you might need to switch
the remote provider in the dropdown list on top of the remote explorer view.

you should see the list of the guest containers managed by `distrobox`. you can
connect the current window to the container, or open a new window and connect
to it. if you have a workspace open, you can reopen it inside the container.

these commands are also available if you click the "remote indicator" in the
bottom left corner of the window, on the status bar.

all commands are registered in the `Distrobox` category, you can open the
command palette (`Ctrl + Shift + P`) and type `Distrobox:` to view all available
commands.

I also created a simple UI for as wrapper for the `distrobox create|rm` commands,
but these are not related to remote server setup and autority resolution. it
just felt incomplet to me that I have a list of guests, but I cannot add to it
or remove from it. the UI is very primitive and I have no plan to improve it.

also, the UI support many, but NOT ALL of the command line options. running
`distrobox create|rm` from command line is still my preferred way to manage
guest containers with distrobox.


## about the implementation

after some back and forth, I came to realize this extension could potentially
be extended to non-`distrobox` containers as well. I believe the core
functionality can be implemented with `podman` directly, thus it might possibly
serve as (at least partially) a replacement for the `attached-container`
authority, one of many authorities registered by the microsoft `devcontainers`
extension.

however, I don't plan to implement this, simply because I don't have the need,
but if someone want to implement it, I'm happy to discuss the implementation
details with you.

because I want to this extension to work on the host as well as inside a
container such as the `flatpak` sandbox, I can only control the guest
container using the `distrobox enter` command, and rely on the guest system to
have some programs installed. this works for all `distrobox` managed container,
but not necessarily available out of the box for all containers. specifically,
busybox based distros like alpine linux needs some additional packages to
be installed. check the source code for details.

if the `distrobox` command is run indirectly through `host-spawn` (or
`flatpak-spawn --host`) from a container, it will not inherit the environment
block of the vscodium process, so I inject the configured environment variables
into the bash script that launches the vscodium remote server.

this is not ideal, but it is easier to implement. alternative should be to inject
them into the `host-spawn` command, such as `foo=123 bar=456 host-spawn --env foo,bar`

however, this has the drawback that if you changed the host environment variables,
the change will not be applied to the remote server. in such cases, you need to
run the command `open-remote-distrobox.cleanup-session-files` manually, which
will delete the existing control script so a new script will be generated
next time you connect to the guest.


## some notes

this extension neither depends on, nor conflicts with [vscode-remote-oss].

I wrote and tested this extension for [vscodium], it probably won't work with
other `vscode` distributions.

starting from version 0.3, it should also support cursor, but I haven't tested
it throughly as I don't use cursor personally, but PRs are welcome. it seems
to be working just fine based on user feedback in issue #2 though.

the main difference between cursor and vscodium seems to be how they created
their server packages. but since cursor's source code is not publicly available,
this is all based on guess work.

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

here's anther wrapper script I use to open `vscodium`. this script tries to
use the `CONTAINER_ID` environment variable to detect if it is invoked inside
a container or on the host system.

```bash
#!/bin/sh

# change this if you are not using flatpak
codium_command="flatpak run com.vscodium.codium"

if [ -n "${CONTAINER_ID}" ]; then
	codium_command="distrobox-host-exec ${codium_command}"
	if [ -f "$1" ]; then
		exec $codium_command --file-uri="vscode-remote://distrobox+${CONTAINER_ID}$(realpath "$1")"
	elif [ -d "$1" ]; then
		exec $codium_command --folder-uri="vscode-remote://distrobox+${CONTAINER_ID}$(realpath "$1")"
	else
		exec $codium_command --remote "distrobox+${CONTAINER_ID}" "$@"
	fi
else
	exec $codium_command "$@"
fi
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
[releases]: https://github.com/nerditation/open-remote-distrobox/releases
[MicroOS]: https://microos.opensuse.org/
