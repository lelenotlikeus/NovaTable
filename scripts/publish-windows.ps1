$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$config = Get-Content (Join-Path $projectRoot "src-tauri\tauri.conf.json") | ConvertFrom-Json
$version = $config.version
$signingKey = Join-Path $env:USERPROFILE ".tauri\novatable.key"
$signingPassword = Join-Path $env:USERPROFILE ".tauri\novatable.password"
if (-not (Test-Path $signingKey)) { throw "Missing updater signing key: $signingKey" }
if (-not (Test-Path $signingPassword)) { throw "Missing updater signing password: $signingPassword" }

$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content $signingKey -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = Get-Content $signingPassword -Raw
npm --prefix $projectRoot run tauri -- build --bundles nsis

$bundle = Join-Path $projectRoot "src-tauri\target\release\bundle\nsis\NovaTable_${version}_x64-setup.exe"
$signatureFile = "$bundle.sig"
if (-not (Test-Path $bundle) -or -not (Test-Path $signatureFile)) { throw "Tauri did not create the signed Windows updater artifacts." }

$release = Join-Path $projectRoot ".release-site"
$downloads = Join-Path $release "downloads"
$updates = Join-Path $release "updates"
New-Item -ItemType Directory -Force -Path $release, $downloads, $updates | Out-Null
Copy-Item (Join-Path $projectRoot "site\*") $release -Recurse -Force
Copy-Item (Join-Path $projectRoot "public\novatable-logo.svg") $release -Force
Copy-Item (Join-Path $projectRoot "public\magic-card-back.png") $release -Force
Copy-Item (Join-Path $projectRoot "docs\assets\commander-gameplay.png") $release -Force
Copy-Item $bundle (Join-Path $downloads "NovaTable_${version}_x64-setup.exe") -Force
Copy-Item $bundle (Join-Path $downloads "NovaTable-latest_x64-setup.exe") -Force

$manifest = @{
  version = $version
  notes = "NovaTable $version beta update"
  pub_date = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  platforms = @{
    "windows-x86_64" = @{
      signature = (Get-Content $signatureFile -Raw).Trim()
      url = "https://novatable.162.243.65.125.sslip.io/downloads/NovaTable_${version}_x64-setup.exe"
    }
  }
}
$manifestJson = $manifest | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText((Join-Path $updates "latest.json"), $manifestJson, [System.Text.UTF8Encoding]::new($false))

ssh -i (Join-Path $env:USERPROFILE ".ssh\novatable_deploy") root@162.243.65.125 "mkdir -p /opt/novatable/public/downloads /opt/novatable/public/updates"
scp -i (Join-Path $env:USERPROFILE ".ssh\novatable_deploy") -r "$release\*" "root@162.243.65.125:/opt/novatable/public/"
ssh -i (Join-Path $env:USERPROFILE ".ssh\novatable_deploy") root@162.243.65.125 "chmod -R a+rX /opt/novatable/public"
Write-Output "Published NovaTable $version to https://novatable.162.243.65.125.sslip.io"
