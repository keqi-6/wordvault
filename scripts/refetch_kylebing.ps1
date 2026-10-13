$ErrorActionPreference = 'Continue'
$proxy = 'http://127.0.0.1:7892'
$raw = 'D:\AI\AI_program\英语六级\wordvault\data\raw\kylebing'
$log = 'D:\AI\AI_program\英语六级\wordvault\data\download.log'
function Log([string]$m) {
  $line = (Get-Date -Format 'HH:mm:ss') + '  ' + $m
  Add-Content -LiteralPath $log -Value $line -Encoding UTF8
  Write-Output $line
}
$base = 'https://raw.githubusercontent.com/KyleBing/english-vocabulary/master/json/'
$sx = [System.Uri]::EscapeDataString([string][char]0x987A + [string][char]0x5E8F)
$ky = [System.Uri]::EscapeDataString([string][char]0x8003 + [string][char]0x7814)
$map = @{
  '4-CET6.json'   = $base + '4-CET6-' + $sx + '.json'
  '3-CET4.json'   = $base + '3-CET4-' + $sx + '.json'
  '5-kaoyan.json' = $base + '5-' + $ky + '-' + $sx + '.json'
}
Log '===== kylebing re-download start ====='
foreach ($name in $map.Keys) {
  $dest = Join-Path $raw $name
  $tmp = $dest + '.part'
  curl.exe -sSL -x $proxy --retry 6 --retry-delay 3 --connect-timeout 25 -o $tmp $map[$name] 2>$null
  $code = $LASTEXITCODE
  if ((Test-Path $tmp) -and (Get-Item $tmp).Length -gt 1000) {
    Move-Item -LiteralPath $tmp -Destination $dest -Force
    Log ("OK    $name  " + [math]::Round((Get-Item $dest).Length/1KB,0) + " KB (exit=$code)")
  } else {
    Log ("FAIL  $name  exit=$code")
  }
}
Log '===== kylebing re-download end ====='
