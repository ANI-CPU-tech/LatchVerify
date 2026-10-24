#!/bin/sh
# Download Node.js 22 for Linux from nodejs.org, check its SHA-256 against the SHASUMS256.txt
# published next to it, and unpack the runtime to <dest>/node (bin/node and its LICENSE).
#
# Usage: fetch-node.sh <dest> [x64|arm64]
# NODE_VERSION=v22.x.y pins a release; the default is the newest Node.js 22.
set -eu

dest=${1:?usage: fetch-node.sh <dest> [x64|arm64]}
arch=${2:-x64}
release=${NODE_VERSION:-latest-v22.x}
base="https://nodejs.org/dist/$release"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

curl -fsSL --retry 3 -o "$tmp/SHASUMS256.txt" "$base/SHASUMS256.txt"
file=$(awk -v suffix="-linux-$arch.tar.xz" '$2 ~ /^node-v22\.[0-9]+\.[0-9]+-/ && substr($2, length($2) - length(suffix) + 1) == suffix { print $2 }' "$tmp/SHASUMS256.txt")
if [ -z "$file" ]; then
  echo "fetch-node: no Node.js 22 linux-$arch build listed in $base/SHASUMS256.txt" >&2
  exit 1
fi

curl -fsSL --retry 3 -o "$tmp/$file" "$base/$file"
# Only this file's line, so sha256sum checks exactly what was downloaded.
grep "  $file\$" "$tmp/SHASUMS256.txt" > "$tmp/expected"
(cd "$tmp" && sha256sum -c expected)

tar -xJf "$tmp/$file" -C "$tmp"
unpacked="$tmp/${file%.tar.xz}"
mkdir -p "$dest/node/bin"
install -m 755 "$unpacked/bin/node" "$dest/node/bin/node"
install -m 644 "$unpacked/LICENSE" "$dest/node/LICENSE"
echo "fetch-node: $("$dest/node/bin/node" --version) for linux-$arch in $dest/node"
