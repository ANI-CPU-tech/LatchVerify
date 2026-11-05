#!/bin/sh
# Remove a LatchVerify installed by install.sh: first give every MCP client its original server
# commands back (`latch setup --remove --all`), then delete what install.sh created. The per-user
# latch.lock stays, so reinstalling keeps your approvals.
set -eu

# Run from the install itself (<prefix>/lib/latchverify/uninstall.sh: the app's Uninstall and
# `latch uninstall` do that), the prefix is where it lives; from the unpacked archive, ~/.local.
here=$(dirname "$(readlink -f "$0")")
case "$here" in
  */lib/latchverify) prefix=${PREFIX:-$(dirname "$(dirname "$here")")} ;;
  *) prefix=${PREFIX:-$HOME/.local} ;;
esac
lib="$prefix/lib/latchverify"
bin="$prefix/bin"
data=${XDG_DATA_HOME:-$HOME/.local/share}

autostart="${XDG_CONFIG_HOME:-$HOME/.config}/autostart/latchverify.desktop"

# The app first, so it does not link the clients again.
pkill -f "^$lib/desktop/latchverify-desktop" 2>/dev/null || true
if [ -x "$lib/latch" ]; then
  "$lib/latch" setup --remove --all || echo "Could not restore every MCP client config; some may still start servers through latch."
fi
# Only links that point into this install: never another latch on PATH.
for link in latch:latch latchverify-desktop:desktop/latchverify-desktop latchverify-review:latchverify-review; do
  name=${link%%:*}
  if [ -L "$bin/$name" ] && [ "$(readlink "$bin/$name")" = "$lib/${link#*:}" ]; then rm -f "$bin/$name"; fi
done
# The login start the app wrote, only when it starts this install.
if [ -f "$autostart" ] && grep -q "$lib/desktop/" "$autostart"; then rm -f "$autostart"; fi
rm -rf "$lib"
rm -f "$data/applications/io.github.ANI-CPU-tech.LatchVerify.desktop" "$data/icons/hicolor/scalable/apps/io.github.ANI-CPU-tech.LatchVerify.svg"
# The menu entry of versions before 0.2.0 (app id io.github.vinayakkam.LatchVerify), if it starts this install.
old="$data/applications/io.github.vinayakkam.LatchVerify.desktop"
if [ -f "$old" ] && grep -q "$lib/" "$old"; then rm -f "$old" "$data/icons/hicolor/scalable/apps/io.github.vinayakkam.LatchVerify.svg"; fi
echo "LatchVerify removed. Your latch.lock was kept."
