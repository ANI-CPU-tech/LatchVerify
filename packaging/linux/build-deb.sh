#!/bin/sh
# Build the LatchVerify .deb from a staged tree (packaging/stage.ts plus fetch-node.sh):
#
#   /usr/lib/latchverify/{app,node,latch,latchverify-review,link-user}
#   /usr/bin/latch, /usr/bin/latchverify-review         symlinks into /usr/lib/latchverify
#   /usr/share/applications/io.github.vinayakkam.LatchVerify.desktop
#   /usr/share/icons/hicolor/scalable/apps/io.github.vinayakkam.LatchVerify.svg
#   /usr/share/doc/latchverify/copyright
#
# Usage: build-deb.sh <stage-dir> <out-dir> <deb-version> [amd64|arm64]
# LATCH_PACKAGER="Name <email>" sets the Maintainer field.
set -eu

stage=$(readlink -f "${1:?usage: build-deb.sh <stage-dir> <out-dir> <deb-version> [arch]}")
out=${2:?missing <out-dir>}
version=${3:?missing <deb-version>}
arch=${4:-amd64}
repo=$(readlink -f "$(dirname "$0")/../..")
maintainer=${LATCH_PACKAGER:-LatchVerify maintainers <latchverify@users.noreply.github.com>}

for required in "$stage/app/dist/cli.js" "$stage/node/bin/node"; do
  [ -e "$required" ] || { echo "build-deb: $required is missing; stage the app and fetch Node.js first" >&2; exit 1; }
done

root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT
lib="$root/usr/lib/latchverify"
mkdir -p "$lib" "$root/usr/bin" "$root/DEBIAN"
cp -a "$stage/app" "$stage/node" "$lib/"
# How `latch update` and the app install updates (src/update): this is the deb.
printf 'deb\n' > "$lib/install-kind"
install -m 755 "$repo/packaging/linux/latch" "$repo/packaging/linux/latchverify-review" "$repo/packaging/linux/link-user" "$lib/"
ln -s ../lib/latchverify/latch "$root/usr/bin/latch"
ln -s ../lib/latchverify/latchverify-review "$root/usr/bin/latchverify-review"
install -Dm 644 "$repo/packaging/linux/io.github.vinayakkam.LatchVerify.desktop" "$root/usr/share/applications/io.github.vinayakkam.LatchVerify.desktop"
install -Dm 644 "$repo/web/public/favicon.svg" "$root/usr/share/icons/hicolor/scalable/apps/io.github.vinayakkam.LatchVerify.svg"
install -Dm 644 "$repo/LICENSE" "$root/usr/share/doc/latchverify/copyright"
# Files must not be group- or world-writable, whatever the build machine's umask, and the tree's
# root (mktemp makes it 0700) must not carry odd permissions into the package's "./".
chmod -R go-w "$root"
chmod 755 "$root"

size=$(du -sk --exclude=DEBIAN "$root" | cut -f1)
sed -e "s|@VERSION@|$version|" -e "s|@ARCH@|$arch|" -e "s|@INSTALLED_SIZE@|$size|" -e "s|@MAINTAINER@|$maintainer|" \
  "$repo/packaging/debian/control.in" > "$root/DEBIAN/control"
install -m 755 "$repo/packaging/debian/postinst" "$repo/packaging/debian/prerm" "$root/DEBIAN/"

mkdir -p "$out"
deb="$out/latchverify_${version}_${arch}.deb"
dpkg-deb --root-owner-group --build "$root" "$deb"
echo "build-deb: $deb"
