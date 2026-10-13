# 词穹 WordVault —— 一键启动
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
Set-Location $root

$db = Join-Path $root 'data\wordvault.db'
if (-not (Test-Path $db)) {
  Write-Host '还没有数据库，先跑数据管线...' -ForegroundColor Yellow
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'scripts\run_pipeline.ps1')
}

Set-Location (Join-Path $root 'server')
if (-not (Test-Path 'node_modules')) {
  npm install --registry https://registry.npmmirror.com
}

$port = if ($env:PORT) { $env:PORT } else { 8787 }
Write-Host ("词穹 WordVault 启动中: http://127.0.0.1:" + $port) -ForegroundColor Green
Start-Job -ScriptBlock ([scriptblock]::Create('Start-Sleep -Seconds 2; Start-Process "http://127.0.0.1:' + $port + '"')) | Out-Null
node src/index.js
