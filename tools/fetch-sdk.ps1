# Download the minimal Android SDK (build-tools + platform) needed to build the APK.
# ASCII only on purpose: Windows PowerShell 5.1 reads .ps1 as ANSI and mangles UTF-8 comments.
# Usage: powershell -ExecutionPolicy Bypass -File tools\fetch-sdk.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$sdk  = Join-Path $root '.android-sdk'
$dl   = Join-Path $sdk 'download'
New-Item -ItemType Directory -Force -Path $dl | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $sdk 'build-tools') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $sdk 'platform') | Out-Null

function Fetch([string]$url, [string]$out) {
  if (Test-Path $out) { Write-Host "[skip] $out"; return }
  Write-Host "[get ] $url"
  & curl.exe -L --fail --retry 3 --connect-timeout 25 -s -S -o $out $url
  if ($LASTEXITCODE -ne 0) { throw "download failed: $url" }
}

function Resolve-FromRepo([string]$pkgPath, [string]$hostOs) {
  $tmp = Join-Path $dl 'repository2-3.xml'
  if (-not (Test-Path $tmp)) {
    Write-Host '[get ] repository2-3.xml'
    & curl.exe -s -L --fail --connect-timeout 25 -o $tmp 'https://dl.google.com/android/repository/repository2-3.xml'
    if ($LASTEXITCODE -ne 0) { throw 'cannot fetch sdk repository manifest' }
  }
  [xml]$x = Get-Content -Raw -Path $tmp
  # the manifest uses a namespace (root sdk:sdk-repository), so match by local-name
  $nodes = $x.DocumentElement.SelectNodes('//*[local-name()="remotePackage"]')
  $pkg = $null
  foreach ($n in $nodes) {
    if ($n.GetAttribute('path') -ne $pkgPath) { continue }
    if ($n.GetAttribute('obsolete') -eq 'true') { continue }
    $pkg = $n
    break
  }
  if (-not $pkg) { throw "package not in repo: $pkgPath" }
  foreach ($a in $pkg.SelectNodes('.//*[local-name()="archive"]')) {
    $ho = $a.SelectSingleNode('./*[local-name()="host-os"]')
    if ($hostOs -and $ho -and $ho.InnerText -ne $hostOs) { continue }
    $u = $a.SelectSingleNode('.//*[local-name()="complete"]/*[local-name()="url"]')
    if ($u -and $u.InnerText) { return [string]$u.InnerText }
  }
  throw "no download url for $pkgPath"
}

$jobs = @(
  @{ name = 'build-tools'; hint = 'build-tools_r34-windows.zip'; pkg = 'build-tools;34.0.0';   os = 'windows'; dir = 'build-tools' },
  @{ name = 'platform';    hint = 'platform-34-ext7_r03.zip';   pkg = 'platforms;android-34'; os = '';        dir = 'platform' }
)

foreach ($j in $jobs) {
  $zip = Join-Path $dl ($j.name + '.zip')
  if (-not (Test-Path $zip)) {
    $url = 'https://dl.google.com/android/repository/' + $j.hint
    try { Fetch $url $zip }
    catch {
      Write-Host ("[warn] direct url failed, resolving " + $j.pkg + " from repo")
      $rel = Resolve-FromRepo $j.pkg $j.os
      Fetch ('https://dl.google.com/android/repository/' + $rel) $zip
    }
  }
  $dest = Join-Path $sdk $j.dir
  Write-Host ("[unzip] " + $j.name + " -> " + $dest)
  Expand-Archive -Path $zip -DestinationPath $dest -Force
}

Write-Host ''
Write-Host '=== result ==='
$jar = Get-ChildItem -Path $sdk -Recurse -Filter 'android.jar' -ErrorAction SilentlyContinue | Select-Object -First 1
$aapt2 = Get-ChildItem -Path $sdk -Recurse -Filter 'aapt2.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
$d8 = Get-ChildItem -Path $sdk -Recurse -Filter 'd8.bat' -ErrorAction SilentlyContinue | Select-Object -First 1
$za = Get-ChildItem -Path $sdk -Recurse -Filter 'zipalign.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
$as = Get-ChildItem -Path $sdk -Recurse -Filter 'apksigner.bat' -ErrorAction SilentlyContinue | Select-Object -First 1
Write-Host ("android.jar : " + $jar.FullName)
Write-Host ("aapt2       : " + $aapt2.FullName)
Write-Host ("d8          : " + $d8.FullName)
Write-Host ("zipalign    : " + $za.FullName)
Write-Host ("apksigner   : " + $as.FullName)
if (-not ($jar -and $aapt2 -and $d8 -and $za -and $as)) { throw 'SDK components incomplete' }
Write-Host 'SDK READY'
