# 补齐还没下到本地的资料（长跑，可随时中断续传）
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$proxy = 'http://127.0.0.1:7892'
$root  = 'D:\AI\AI_program\英语六级\wordvault'
$raw   = Join-Path $root 'data\raw'
$log   = Join-Path $root 'data\download2.log'

function Log([string]$m) {
  $line = (Get-Date -Format 'HH:mm:ss') + '  ' + $m
  Add-Content -LiteralPath $log -Value $line -Encoding UTF8
  Write-Output $line
}

function Fetch([string]$url, [string]$dest, [long]$expect = 1, [switch]$NoProxy) {
  $leaf = Split-Path $dest -Leaf
  if ((Test-Path $dest) -and ((Get-Item $dest).Length -ge $expect)) {
    Log ("SKIP  $leaf  (" + [math]::Round((Get-Item $dest).Length/1MB,2) + " MB)")
    return $true
  }
  Log ("START $leaf")
  $sw = [Diagnostics.Stopwatch]::StartNew()
  if ($NoProxy) { curl.exe -sSL --retry 8 --retry-delay 5 --connect-timeout 25 -C - -o $dest $url 2>$null }
  else          { curl.exe -sSL -x $proxy --retry 8 --retry-delay 5 --connect-timeout 25 -C - -o $dest $url 2>$null }
  $sw.Stop()
  $size = 0
  if (Test-Path $dest) { $size = (Get-Item $dest).Length }
  if ($size -ge $expect -and $expect -gt 1) {
    Log ("DONE  $leaf  " + [math]::Round($size/1MB,2) + " MB in " + [math]::Round($sw.Elapsed.TotalSeconds) + "s")
    return $true
  }
  Log ("PART  $leaf  " + [math]::Round($size/1MB,2) + " MB（未达预期，稍后可重跑续传）")
  return $false
}

New-Item -ItemType Directory -Force -Path (Join-Path $raw 'tatoeba') | Out-Null
Log '===== 资料补齐开始 ====='

# 1) Tatoeba 例句（中英对照）
Fetch 'https://downloads.tatoeba.org/exports/per_language/cmn/cmn_sentences.tsv.bz2' (Join-Path $raw 'tatoeba\cmn_sentences.tsv.bz2') 1200000
Fetch 'https://downloads.tatoeba.org/exports/per_language/eng/eng_sentences.tsv.bz2' (Join-Path $raw 'tatoeba\eng_sentences.tsv.bz2') 24000000
Fetch 'https://downloads.tatoeba.org/exports/links.tar.bz2' (Join-Path $raw 'tatoeba\links.tar.bz2') 140000000

# 2) 六级真题整库（含扫描件，用于 OCR 取真题文本与真题词频）
Fetch 'https://codeload.github.com/YinsinSirius/CET6-Resources/tar.gz/refs/heads/master' (Join-Path $raw 'cet6-resources-full.tar.gz') 1000000000

Log '===== 资料补齐结束 ====='
