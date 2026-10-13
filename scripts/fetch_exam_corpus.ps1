$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$raw = 'D:\AI\AI_program\英语六级\wordvault\data\raw'
$log = 'D:\AI\AI_program\英语六级\wordvault\data\exam_fetch.log'
function Log([string]$m) {
  $line = (Get-Date -Format 'HH:mm:ss') + '  ' + $m
  Add-Content -LiteralPath $log -Value $line -Encoding UTF8
  Write-Output $line
}
Log '===== exam corpus sparse fetch start ====='
$dest = Join-Path $raw 'CET6-Resources'
if (Test-Path $dest) { Log 'already exists'; exit }
git clone --filter=blob:none --no-checkout --depth 1 https://github.com/YinsinSirius/CET6-Resources.git $dest 2>&1 | ForEach-Object { Log ("  " + $_) }
if (Test-Path $dest) {
  Push-Location $dest
  git sparse-checkout init --no-cone 2>&1 | ForEach-Object { Log ("  " + $_) }
  git sparse-checkout set '/*.md' '/CET6_*/*.md' '/CET6_*/*.txt' '/Resources/*' 2>&1 | ForEach-Object { Log ("  " + $_) }
  git checkout 2>&1 | ForEach-Object { Log ("  " + $_) }
  Pop-Location
  $files = Get-ChildItem -LiteralPath $dest -Recurse -File -ErrorAction SilentlyContinue
  Log ("checked out files: " + $files.Count + " total " + [math]::Round(($files | Measure-Object Length -Sum).Sum/1MB,2) + " MB")
}
Log '===== exam corpus sparse fetch end ====='
