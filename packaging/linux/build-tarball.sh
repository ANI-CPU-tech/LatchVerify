#!/bin/sh
# Build the portable Linux archive from a staged tree: latchverify-<version>-linux-<arch>.tar.gz,
# holding the app, its Node.js, the launchers, a menu entry and install.sh / uninstall.sh.
#
# Usage: build-tarball.sh <stage-dir> <out-dir> <version> [x64|arm64]
set -eu

stage=$(readlink -f "${1:?usage: build-tarball.sh <stage-dir> <out-dir> <version> [arch]}")
out=${2:?missing <out-dir>}
version=${3:?missing <version>}
arch=${4:-x64}
repo=$(readlink -f "$(dirname "$0")/../..")
name="latchverify-$version-linux-$arch"

for required in "$stage/app/dist/cli.js" "$stage/node/bin/node"; do
  [ -e "$required" ] || { echo "build-tarball: $required is missing; stage the app and fetch Node.js first" >&2; exit 1; }
done

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
dir="$tmp/$name"
mkdir -p "$dir"
cp -a "$stage/app" "$stage/node" "$dir/"
# How `latch update` and the app install updates (src/update): this is the portable archive.
printf 'tarball\n' > "$dir/install-kind"
install -m 755 "$repo/packaging/linux/latch" "$repo/packaging/linux/latchverify-review" "$repo/packaging/linux/install.sh" "$repo/packaging/linux/uninstall.sh" "$dir/"
install -m 644 "$repo/packaging/linux/io.github.vinayakkam.LatchVerify.desktop" "$repo/LICENSE" "$dir/"
install -m 644 "$repo/web/public/favicon.svg" "$dir/io.github.vinayakkam.LatchVerify.svg"
chmod -R go-w "$dir"

mkdir -p "$out"
archive="$(readlink -f "$out")/$name.tar.gz"
tar -C "$tmp" --owner=0 --group=0 -czf "$archive" "$name"
echo "build-tarball: $archive"
