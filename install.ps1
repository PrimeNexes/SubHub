# SubHub installer for Windows (PowerShell):
#   irm https://raw.githubusercontent.com/PrimeNexes/SubHub/main/install.ps1 | iex
# Gets the repo (or uses this checkout), installs `subhub`, and connects every AI agent installed here.
$ErrorActionPreference = 'Stop'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Error 'SubHub needs Node.js 18 or newer: https://nodejs.org (winget install OpenJS.NodeJS.LTS)'; exit 1 }
$here = if ($PSCommandPath) { Split-Path -Parent $PSCommandPath } else { $null }
if ($here -and (Test-Path (Join-Path $here 'plugins/subhub/bin/subhub.mjs'))) { $src = $here }
else {
  $src = Join-Path $HOME '.subhub/src'
  if ((Test-Path (Join-Path $src '.git')) -and (Get-Command git -ErrorAction SilentlyContinue)) { git -C $src pull -q --ff-only }
  elseif (Get-Command git -ErrorAction SilentlyContinue) { if (Test-Path $src) { Remove-Item -Recurse -Force $src }; git clone -q --depth 1 https://github.com/PrimeNexes/SubHub.git $src }
  else {
    $zip = Join-Path $env:TEMP 'subhub.zip'; $tmp = Join-Path $env:TEMP 'subhub-src'
    Invoke-WebRequest https://codeload.github.com/PrimeNexes/SubHub/zip/refs/heads/main -OutFile $zip
    if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }; Expand-Archive $zip $tmp
    if (Test-Path $src) { Remove-Item -Recurse -Force $src }; Move-Item (Join-Path $tmp 'SubHub-main') $src
  }
  # Downloaded: agents install the plugin from GitHub, so they get updates from there.
  if (-not $env:SUBHUB_MARKET) { $env:SUBHUB_MARKET = 'https://github.com/PrimeNexes/SubHub' }
}
$env:SUBHUB_REPO = $src
node (Join-Path $src 'plugins/subhub/bin/subhub.mjs') install
