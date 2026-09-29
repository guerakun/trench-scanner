# Deploys the Trench Scanner Worker and uploads secrets from ..\.env
# Run from PowerShell inside C:\Projects\trench-scanner\worker :
#   powershell -ExecutionPolicy Bypass -File .\deploy.ps1
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$envFile = Join-Path $PSScriptRoot "..\.env"
if (-not (Test-Path $envFile)) { throw "No .env found at $envFile" }

$vars = @{}
Get-Content $envFile | ForEach-Object {
  $line = $_.Trim()
  if ($line -and -not $line.StartsWith("#") -and $line.Contains("=")) {
    $i = $line.IndexOf("=")
    $vars[$line.Substring(0, $i).Trim()] = $line.Substring($i + 1).Trim().Trim('"')
  }
}
if (-not $vars["TYPESAFE_API_KEY"]) { throw "TYPESAFE_API_KEY is empty in .env" }

Write-Host "Installing wrangler (first run only)..."
npm install --no-fund --no-audit | Out-Null

Write-Host "Checking Cloudflare login (a browser window may open)..."
npx wrangler whoami 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { npx wrangler login }

Write-Host "Deploying Worker..."
npx wrangler deploy

Write-Host "Uploading TYPESAFE_API_KEY as a Worker secret..."
$vars["TYPESAFE_API_KEY"] | npx wrangler secret put TYPESAFE_API_KEY

if ($vars["TWITTERAPI_IO_KEY"]) {
  Write-Host "Uploading TWITTERAPI_IO_KEY as a Worker secret..."
  $vars["TWITTERAPI_IO_KEY"] | npx wrangler secret put TWITTERAPI_IO_KEY
} else {
  Write-Host "TWITTERAPI_IO_KEY is empty, so the X layer stays off (that's fine)."
}

Write-Host ""
Write-Host "Done. Copy the https://trench-scanner-proxy.<you>.workers.dev URL printed above"
Write-Host "and paste it into the screener's Settings > Worker URL."
