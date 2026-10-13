# 词穹 WordVault —— 一键数据管线
# 用法: powershell -ExecutionPolicy Bypass -File scripts\run_pipeline.ps1
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host '=== [1/5] 准备 Python 环境 ===' -ForegroundColor Cyan
if (-not (Test-Path '.venv\Scripts\python.exe')) {
  uv venv --python 3.12 .venv
}
uv pip install --python .venv\Scripts\python.exe pandas numpy scikit-learn umap-learn nltk tqdm pypdf gensim

Write-Host '=== [2/5] 下载原始数据 ===' -ForegroundColor Cyan
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'download_data.ps1')

Write-Host '=== [3/5] 拉取真题语料（稀疏检出，仅文本） ===' -ForegroundColor Cyan
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'fetch_exam_corpus.ps1')

Write-Host '=== [4/5] 生成关系、坐标与数据库 ===' -ForegroundColor Cyan
& .venv\Scripts\python.exe scripts\pipeline\run_all.py

Write-Host '=== [5/5] 生成主观维度（需要模型 key，可跳过） ===' -ForegroundColor Cyan
try { & .venv\Scripts\python.exe scripts\pipeline\gen_dims.py } catch { Write-Warning '主观维度生成失败，可稍后单独重跑' }

Write-Host ''
Write-Host '数据管线完成。数据库: data\wordvault.db' -ForegroundColor Green
