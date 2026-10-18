# Build an installable APK using only the bare Android SDK tools (no Gradle, no network).
# ASCII only: Windows PowerShell 5.1 reads .ps1 as ANSI and would mangle UTF-8 text.
# NOTE: ErrorActionPreference stays Continue because PS 5.1 turns native-command stderr
# (e.g. javac's deprecation note) into a terminating error; every step checks $LASTEXITCODE.
# Usage: powershell -ExecutionPolicy Bypass -File tools\build-apk.ps1
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$sdk  = Join-Path $root '.android-sdk'
$app  = Join-Path $root 'android'
$work = Join-Path $root '.build'
$dist = Join-Path $root 'dist'

function Find-One([string]$name) {
  $f = Get-ChildItem -Path $sdk -Recurse -Filter $name -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $f) { throw "not found in SDK: $name" }
  return $f.FullName
}

function Step([string]$msg) { Write-Host ("[build] " + $msg) -ForegroundColor Cyan }

# Run a native tool, capture both streams, fail loudly with its output.
function Run([string]$exe, [string[]]$cmdArgs, [string]$what) {
  $out = & $exe @cmdArgs 2>&1
  $code = $LASTEXITCODE
  $text = ($out | Out-String)
  if ($code -ne 0) {
    Write-Host $text
    throw ("$what failed (exit $code)")
  }
  return $text
}

# ---------------------------------------------------------------- tools
Step 'locating toolchain'
$androidJar = Find-One 'android.jar'
$aapt2      = Find-One 'aapt2.exe'
$d8jar      = Find-One 'd8.jar'
$zipAlign   = Find-One 'zipalign.exe'
$signerJar  = Find-One 'apksigner.jar'
$javaExe    = (Get-Command java).Source
$jdkBin     = Split-Path $javaExe
$javac      = Join-Path $jdkBin 'javac.exe'
$keytool    = Join-Path $jdkBin 'keytool.exe'
foreach ($p in @($javac, $keytool)) { if (-not (Test-Path $p)) { throw "missing $p" } }
Write-Host ("  java      : " + $javaExe)
Write-Host ("  android   : " + $androidJar)
Write-Host ("  aapt2     : " + $aapt2)

# ---------------------------------------------------------------- workspace
Step 'preparing workspace'
if (Test-Path $work) { Remove-Item -Recurse -Force $work }
New-Item -ItemType Directory -Force -Path (Join-Path $work 'classes'), (Join-Path $work 'dex'), (Join-Path $work 'assets') | Out-Null

# web app -> assets
$webFiles = @('index.html', 'styles.css', 'audio.js', 'app.js', 'sw.js', 'manifest.webmanifest')
foreach ($f in $webFiles) {
  $src = Join-Path $root $f
  if (Test-Path $src) { Copy-Item $src (Join-Path $work 'assets') -Force }
}

# Keep assets FLAT (no sub-directories): aapt2 on Windows stores nested asset paths with
# backslashes ("assets/icons\x.png") and Android's AssetManager cannot resolve those.
Get-ChildItem (Join-Path $root 'icons') -Filter '*.png' | ForEach-Object {
  Copy-Item $_.FullName (Join-Path $work 'assets') -Force
}
# ...so the HTML/manifest copies shipped in the APK reference the icons without the prefix
# (Join-Path in PS 5.1 takes only two positional arguments, hence the nested calls)
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$assetsDir = Join-Path $work 'assets'
foreach ($f in @('index.html', 'manifest.webmanifest')) {
  $p = Join-Path $assetsDir $f
  if (Test-Path $p) {
    $text = [System.IO.File]::ReadAllText($p) -replace 'icons/', ''
    [System.IO.File]::WriteAllText($p, $text, $utf8NoBom)
  }
}
$idxCopy = Join-Path $assetsDir 'index.html'
if ([System.IO.File]::ReadAllText($idxCopy) -match 'icons/') {
  throw 'failed to flatten icon paths in the shipped index.html'
}
$assetCount = (Get-ChildItem $assetsDir -Recurse -File).Count
$subDirs = @(Get-ChildItem (Join-Path $work 'assets') -Recurse -Directory).Count
if ($subDirs -ne 0) { throw "assets must stay flat, found $subDirs sub-directory(ies)" }
Write-Host ("  assets    : " + $assetCount + " files (flat)")

# ---------------------------------------------------------------- resources
Step 'aapt2 compile'
Run $aapt2 @('compile', '--dir', (Join-Path $app 'res'), '-o', (Join-Path $work 'res.zip')) 'aapt2 compile' | Out-Null

Step 'aapt2 link'
# The compiled resources must be a POSITIONAL argument (primary resource set).
# -R is only for overlay packages and makes aapt2 complain "does not override an existing resource".
Run $aapt2 @(
  'link', '-o', (Join-Path $work 'base.apk'),
  '-I', $androidJar,
  '--manifest', (Join-Path $app 'AndroidManifest.xml'),
  '-A', (Join-Path $work 'assets'),
  '--min-sdk-version', '23', '--target-sdk-version', '34', '--no-version-vectors',
  (Join-Path $work 'res.zip')
) 'aapt2 link' | Out-Null

# ---------------------------------------------------------------- java
Step 'javac'
# glob instead of a hard-coded package path, so renaming the package never breaks the build
$javaFiles = @(Get-ChildItem (Join-Path $app 'java') -Recurse -Filter '*.java' | ForEach-Object { $_.FullName })
if ($javaFiles.Count -eq 0) { throw 'no .java sources found' }
Write-Host ("  sources   : " + $javaFiles.Count)
$classesDir = Join-Path $work 'classes'
try {
  Run $javac (@('-nowarn', '-encoding', 'UTF-8', '-source', '8', '-target', '8',
    '-bootclasspath', $androidJar, '-classpath', $androidJar, '-d', $classesDir) + $javaFiles) 'javac' | Out-Null
} catch {
  Write-Host '  retrying javac with --release 8'
  Run $javac (@('-nowarn', '-encoding', 'UTF-8', '--release', '8',
    '-classpath', $androidJar, '-d', $classesDir) + $javaFiles) 'javac' | Out-Null
}

Step 'd8 (classes -> dex)'
$classFiles = @(Get-ChildItem $classesDir -Recurse -Filter '*.class' | ForEach-Object { $_.FullName })
if ($classFiles.Count -eq 0) { throw 'no .class produced' }
Write-Host ("  classes   : " + $classFiles.Count)
Run $javaExe (@('-cp', $d8jar, 'com.android.tools.r8.D8', '--release', '--lib', $androidJar, '--min-api', '23',
  '--output', (Join-Path $work 'dex')) + $classFiles) 'd8' | Out-Null
$dexFile = Join-Path $work 'dex\classes.dex'
if (-not (Test-Path $dexFile)) { throw 'classes.dex missing' }
Write-Host ("  dex       : " + [math]::Round((Get-Item $dexFile).Length / 1KB, 1) + " KB")

# ---------------------------------------------------------------- package
Step 'packing classes.dex into apk'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$baseApk = Join-Path $work 'base.apk'
$zip = [System.IO.Compression.ZipFile]::Open($baseApk, 'Update')
[void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
  $zip, $dexFile, 'classes.dex', [System.IO.Compression.CompressionLevel]::Optimal)
$zip.Dispose()

Step 'zipalign'
$aligned = Join-Path $work 'aligned.apk'
Run $zipAlign @('-p', '-f', '4', $baseApk, $aligned) 'zipalign' | Out-Null

Step 'signing'
$ksDir = Join-Path $root 'keystore'
$ks = Join-Path $ksDir 'piano.keystore'
if (-not (Test-Path $ks)) {
  New-Item -ItemType Directory -Force -Path $ksDir | Out-Null
  Run $keytool @('-genkeypair', '-keystore', $ks, '-alias', 'piano', '-keyalg', 'RSA', '-keysize', '2048',
    '-validity', '10950', '-storepass', 'android', '-keypass', 'android',
    '-dname', 'CN=PIANO, OU=Dev, O=PIANO, C=CN') 'keytool' | Out-Null
}
New-Item -ItemType Directory -Force -Path $dist | Out-Null
$finalApk = Join-Path $dist 'PIANO-1.0.apk'
if (Test-Path $finalApk) { Remove-Item $finalApk -Force }
Run $javaExe @('-jar', $signerJar, 'sign', '--ks', $ks, '--ks-pass', 'pass:android', '--key-pass', 'pass:android',
  '--min-sdk-version', '23', '--v1-signing-enabled', 'true', '--v2-signing-enabled', 'true',
  '--out', $finalApk, $aligned) 'apksigner sign' | Out-Null

# ---------------------------------------------------------------- verify
Step 'verifying'
$cert = Run $javaExe @('-jar', $signerJar, 'verify', '--print-certs', $finalApk) 'apksigner verify'
$cert -split "`n" | Where-Object { $_.Trim() } | ForEach-Object { Write-Host ("  " + $_.Trim()) }
$badging = Run $aapt2 @('dump', 'badging', $finalApk) 'aapt2 dump badging'
$badging -split "`n" | Where-Object { $_ -match 'package:|launchable-activity:|application-label|sdkVersion|uses-permission' } | ForEach-Object { Write-Host ("  " + $_.Trim()) }

$size = [math]::Round((Get-Item $finalApk).Length / 1KB, 1)
Write-Host ''

# ---------------------------------------------------------------- self check
Step 'structure self-check'
$check = & node (Join-Path $PSScriptRoot 'inspect-apk.mjs') $finalApk 2>&1
$check -split "`n" | Where-Object { $_.Trim() } | ForEach-Object { Write-Host ("  " + $_.Trim()) }
if ($LASTEXITCODE -ne 0) { throw 'APK structure check failed' }

Write-Host ''
Write-Host ("APK READY: " + $finalApk + "  (" + $size + " KB)") -ForegroundColor Green
