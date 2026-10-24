# Download Node.js 22 for Windows from nodejs.org, check its SHA-256 against the SHASUMS256.txt
# published next to it, and unpack the runtime to <Destination>\node (node.exe and its LICENSE).
#
# Usage: pwsh packaging/windows/fetch-node.ps1 -Destination build\stage [-Arch x64|arm64]
# $env:NODE_VERSION = "v22.x.y" pins a release; the default is the newest Node.js 22.
param(
  [Parameter(Mandatory = $true)] [string] $Destination,
  [ValidateSet("x64", "arm64")] [string] $Arch = "x64"
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$release = if ($env:NODE_VERSION) { $env:NODE_VERSION } else { "latest-v22.x" }
$base = "https://nodejs.org/dist/$release"
$work = Join-Path ([IO.Path]::GetTempPath()) ("fetch-node-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $work | Out-Null
try {
  $sumsFile = Join-Path $work "SHASUMS256.txt"
  Invoke-WebRequest -Uri "$base/SHASUMS256.txt" -OutFile $sumsFile -MaximumRetryCount 3
  $pattern = "^(?<hash>[0-9a-f]{64})\s+(?<file>node-v22\.\d+\.\d+-win-$Arch\.zip)$"
  $entry = Get-Content $sumsFile | ForEach-Object { $_.Trim() } | Where-Object { $_ -match $pattern } | Select-Object -First 1
  if (-not $entry) { throw "No Node.js 22 win-$Arch zip is listed in $base/SHASUMS256.txt" }
  $null = $entry -match $pattern
  $expected = $Matches.hash
  $file = $Matches.file

  $zip = Join-Path $work $file
  Invoke-WebRequest -Uri "$base/$file" -OutFile $zip -MaximumRetryCount 3
  $actual = (Get-FileHash -Path $zip -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $expected) { throw "SHA-256 mismatch for ${file}: expected $expected, got $actual" }
  Write-Host "${file}: OK"

  Expand-Archive -Path $zip -DestinationPath $work
  $unpacked = Join-Path $work ($file -replace "\.zip$", "")
  $nodeDir = Join-Path $Destination "node"
  New-Item -ItemType Directory -Force -Path $nodeDir | Out-Null
  Copy-Item -Path (Join-Path $unpacked "node.exe"), (Join-Path $unpacked "LICENSE") -Destination $nodeDir -Force
  $version = & (Join-Path $nodeDir "node.exe") --version
  if ($LASTEXITCODE -ne 0) { throw "The downloaded node.exe does not run" }
  Write-Host "fetch-node: $version for win-$Arch in $nodeDir"
}
finally {
  Remove-Item -Recurse -Force -Path $work -ErrorAction SilentlyContinue
}
