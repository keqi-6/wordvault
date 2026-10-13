# Tatoeba 例句下载（实测直连 200+ KB/s，不要走代理）
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$raw = 'D:\AI\AI_program\英语六级\wordvault\data\raw\tatoeba'
$log = 'D:\AI\AI_program\英语六级\wordvault\data\download2.log'
New-Item -ItemType Directory -Force -Path $raw | Out-Null

function Log([string]$m) {
  $line = (Get-Date -Format 'HH:mm:ss') + '  ' + $m
  Add-Content -LiteralPath $log -Value $line -Encoding UTF8
  Write-Output $line
}

function Fetch([string]$url, [string]$dest, [long]$expect) {
  $leaf = Split-Path $dest -Leaf
  if ((Test-Path $dest) -and ((Get-Item $dest).Length -ge $expect)) { Log ("SKIP  $leaf"); return }
  Log ("START $leaf")
  $sw = [Diagnostics.Stopwatch]::StartNew()
  curl.exe -sSL --retry 8 --retry-delay 5 --connect-timeout 25 -C - -o $dest $url 2>$null
  $sw.Stop()
  $size = (Get-Item $dest -ErrorAction SilentlyContinue).Length
  Log ("DONE  $leaf  " + [math]::Round($size/1MB,2) + " MB in " + [math]::Round($sw.Elapsed.TotalSeconds) + "s")
}

Log '===== Tatoeba 下载开始 ====='
Fetch 'https://downloads.tatoeba.org/exports/per_language/cmn/cmn_sentences.tsv.bz2' (Join-Path $raw 'cmn_sentences.tsv.bz2') 1200000
Fetch 'https://downloads.tatoeba.org/exports/per_language/eng/eng_sentences.tsv.bz2' (Join-Path $raw 'eng_sentences.tsv.bz2') 24000000
Fetch 'https://downloads.tatoeba.org/exports/links.tar.bz2' (Join-Path $raw 'links.tar.bz2') 140000000
Log '===== Tatoeba 下载结束 ====='
