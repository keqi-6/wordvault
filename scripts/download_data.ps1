# 词穹 WordVault —— 数据下载（可重复运行，已存在的文件会跳过）
# 本机网络事实：
#   - raw.githubusercontent.com 的 DNS 被指向 127.0.0.1，必须经系统代理（curl -x）访问
#   - downloads.tatoeba.org 实测 ~13 KB/s，未纳入本脚本
#   - HuggingFace 镜像 hf-mirror.com 实测 ~600-800 KB/s，是词向量与 ECDICT 的首选通道
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$proxy = 'http://127.0.0.1:7892'
$root  = 'D:\AI\AI_program\英语六级\wordvault'
$raw   = Join-Path $root 'data\raw'
$nltk  = Join-Path $root 'data\nltk_data\corpora'
$log   = Join-Path $root 'data\download.log'

foreach ($d in @($raw, $nltk, (Join-Path $raw 'kylebing'))) {
  New-Item -ItemType Directory -Force -Path $d | Out-Null
}

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
  if ($NoProxy) {
    curl.exe -sSL --retry 5 --retry-delay 3 --connect-timeout 25 -C - -o $dest $url 2>$null
  } else {
    curl.exe -sSL -x $proxy --retry 5 --retry-delay 3 --connect-timeout 25 -C - -o $dest $url 2>$null
  }
  $sw.Stop()
  $size = 0
  if (Test-Path $dest) { $size = (Get-Item $dest).Length }
  if ($size -ge $expect) {
    Log ("DONE  $leaf  " + [math]::Round($size/1MB,2) + " MB in " + [math]::Round($sw.Elapsed.TotalSeconds) + "s")
    return $true
  }
  Log ("FAIL  $leaf  size=" + [math]::Round($size/1MB,2) + " MB")
  return $false
}

Log '===== 数据下载开始 ====='

# 1. ECDICT（HuggingFace 镜像上的离线 SQLite 包，770,611 条）
$ecdictZip = Join-Path $raw 'ecdict-hf.zip'
if (Fetch 'https://hf-mirror.com/datasets/iamzhangship/fluency-ecdict-offline/resolve/main/ecdict-ecdict-bc015ed2-v1.zip' $ecdictZip 40000000 -NoProxy) {
  $out = Join-Path $raw 'ecdict-hf'
  if (-not (Test-Path (Join-Path $out 'ecdict.sqlite'))) {
    New-Item -ItemType Directory -Force -Path $out | Out-Null
    Expand-Archive -LiteralPath $ecdictZip -DestinationPath $out -Force
    Log 'UNZIP ecdict-hf ok'
  }
}

# 2. 词向量（gensim KeyedVectors 格式，400,000 词 x 50 维）
$gloveBase = 'https://hf-mirror.com/fse/glove-wiki-gigaword-50/resolve/main/'
Fetch ($gloveBase + 'glove-wiki-gigaword-50.model') (Join-Path $raw 'glove-wiki-gigaword-50.model') 20000000 -NoProxy
Fetch ($gloveBase + 'glove-wiki-gigaword-50.model.vectors.npy') (Join-Path $raw 'glove-wiki-gigaword-50.model.vectors.npy') 70000000 -NoProxy

# 3. KyleBing 词表
$kb = 'https://raw.githubusercontent.com/KyleBing/english-vocabulary/master/json/'
$sx = [System.Uri]::EscapeDataString([string][char]0x987A + [string][char]0x5E8F)
$ky = [System.Uri]::EscapeDataString([string][char]0x8003 + [string][char]0x7814)
Fetch ($kb + '4-CET6-' + $sx + '.json') (Join-Path $raw 'kylebing\4-CET6.json') 2500000
Fetch ($kb + '3-CET4-' + $sx + '.json') (Join-Path $raw 'kylebing\3-CET4.json') 4000000
Fetch ($kb + '5-' + $ky + '-' + $sx + '.json') (Join-Path $raw 'kylebing\5-kaoyan.json') 5000000

# 4. WordNet + OMW + CMUdict
$nltkbase = 'https://raw.githubusercontent.com/nltk/nltk_data/gh-pages/packages/corpora/'
Fetch ($nltkbase + 'cmudict.zip') (Join-Path $nltk 'cmudict.zip') 800000
Fetch ($nltkbase + 'wordnet.zip') (Join-Path $nltk 'wordnet.zip') 10000000
Fetch ($nltkbase + 'omw-1.4.zip') (Join-Path $nltk 'omw-1.4.zip') 25000000

foreach ($z in @('cmudict.zip','wordnet.zip','omw-1.4.zip')) {
  $zp = Join-Path $nltk $z
  $target = Join-Path $nltk ($z -replace '\.zip$','')
  if ((Test-Path $zp) -and (-not (Test-Path $target))) {
    try { Expand-Archive -LiteralPath $zp -DestinationPath $nltk -Force; Log "UNZIP $z ok" }
    catch { Log "UNZIP $z failed: $($_.Exception.Message)" }
  }
}

# 5. MorphoLex（构词分解，xlsx）
$mx = Join-Path $raw 'MorphoLex-en'
if (-not (Test-Path (Join-Path $mx 'MorphoLEX_en.xlsx'))) {
  Log 'GITCLONE MorphoLex-en'
  git -c http.proxy=$proxy -c https.proxy=$proxy clone --depth 1 https://github.com/hugomailhot/MorphoLex-en.git $mx 2>&1 | ForEach-Object { Log ("  " + $_) }
}

# 6. 真题语料（只取文本，整库扫描件约 1 GB 不下载）
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'fetch_exam_corpus.ps1')

Log '===== 数据下载结束 ====='
