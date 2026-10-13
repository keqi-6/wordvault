# 词穹 WordVault —— 一次性安装
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
Set-Location $root

Write-Host '=== 后端依赖 ===' -ForegroundColor Cyan
Set-Location (Join-Path $root 'server')
npm install --registry https://registry.npmmirror.com

Write-Host '=== 前端依赖与构建 ===' -ForegroundColor Cyan
Set-Location (Join-Path $root 'web')
if (Test-Path 'package.json') {
  npm install --registry https://registry.npmmirror.com
  npm run build
} else {
  Write-Warning 'web/package.json 不存在，跳过前端构建'
}

Write-Host ''
Write-Host '安装完成。下一步：运行 scripts\run_pipeline.ps1 生成数据，再运行 start.ps1 启动。' -ForegroundColor Green
