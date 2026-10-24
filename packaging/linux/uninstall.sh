#!/bin/sh
# Remove a LatchVerify installed by install.sh: first give Claude Code its original server
# commands back (`latch setup --remove`), then delete what install.sh created. The per-user
# latch.lock stays, so reinstalling keeps your approvals.
set -eu

prefix=${PREFIX:-$HOME/.local}
lib="$prefix/lib/latchverify"
bin="$prefix/bin"
data=${XDG_DATA_HOME:-$HOME/.local/share}

if [ -x "$lib/latch" ]; then
  "$lib/latch" setup --remove || echo "Could not restore Claude Code's config; it may still start servers through latch."
fi
# Only links that point into this install: never another latch on PATH.
for name in latch latchverify-review; do
  if [ -L "$bin/$name" ] && [ "$(readlink "$bin/$name")" = "$lib/$name" ]; then rm -f "$bin/$name"; fi
done
rm -rf "$lib"
rm -f "$data/applications/io.github.vinayakkam.LatchVerify.desktop" "$data/icons/hicolor/scalable/apps/io.github.vinayakkam.LatchVerify.svg"
echo "LatchVerify removed. Your latch.lock was kept."
