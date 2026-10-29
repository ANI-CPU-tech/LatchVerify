#!/bin/sh
# Install LatchVerify for the current user, without root: the app in ~/.local/lib/latchverify,
# `latch` and `latchverify-desktop` in ~/.local/bin, a menu entry, then `latch setup`, which asks
# which MCP clients to connect, and the app in the tray when a desktop session is running (the app
# then starts at login). LATCH_SKIP_SETUP=1 skips both: updates use it, and the app restarts itself.
# Run it again from a newer archive to update.
# PREFIX=/some/dir installs somewhere other than ~/.local.
set -eu

if [ "$(id -u)" -eq 0 ]; then
  echo "install.sh installs LatchVerify for one user and links that user's MCP clients; run it without sudo." >&2
  exit 1
fi

src=$(dirname "$(readlink -f "$0")")
prefix=${PREFIX:-$HOME/.local}
lib="$prefix/lib/latchverify"
bin="$prefix/bin"
data=${XDG_DATA_HOME:-$HOME/.local/share}

# Copy next to the old install, then swap, so a failed copy leaves the old one working.
rm -rf "$lib.new"
mkdir -p "$lib.new" "$bin"
cp -a "$src/app" "$src/node" "$src/desktop" "$src/latch" "$src/install-kind" "$lib.new/"
rm -rf "$lib"
mv "$lib.new" "$lib"
ln -sfn "$lib/latch" "$bin/latch"
ln -sfn "$lib/desktop/latchverify-desktop" "$bin/latchverify-desktop"
# Versions before the desktop app had a latchverify-review launcher.
if [ -L "$bin/latchverify-review" ] && [ "$(readlink "$bin/latchverify-review")" = "$lib/latchverify-review" ]; then rm -f "$bin/latchverify-review"; fi

# The menu entry runs the app by absolute path: desktop sessions may not have ~/.local/bin on PATH.
mkdir -p "$data/applications" "$data/icons/hicolor/scalable/apps"
sed "s|^Exec=.*|Exec=\"$lib/desktop/latchverify-desktop\"|" "$src/io.github.vinayakkam.LatchVerify.desktop" > "$data/applications/io.github.vinayakkam.LatchVerify.desktop"
cp "$src/io.github.vinayakkam.LatchVerify.svg" "$data/icons/hicolor/scalable/apps/"

echo "Installed LatchVerify $("$lib/latch" --version) in $lib"
if [ "${LATCH_SKIP_SETUP:-}" = 1 ]; then
  echo "LATCH_SKIP_SETUP=1: your MCP clients were left alone. Run 'latch setup' to choose which to connect."
else
  "$lib/latch" setup || echo "Connecting your MCP clients did not finish; run 'latch setup' again at any time."
  if [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
    nohup "$lib/desktop/latchverify-desktop" --hidden >/dev/null 2>&1 &
    echo "LatchVerify is running in your tray."
  else
    echo "Start LatchVerify from your app menu; it then starts at login."
  fi
fi

case ":$PATH:" in
  *":$bin:"*) ;;
  *) echo "Note: $bin is not on your PATH. Add it to use 'latch' in a terminal." ;;
esac
