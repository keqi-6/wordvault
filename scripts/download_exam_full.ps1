$ErrorActionPreference='Continue'
$proxy='http://127.0.0.1:7892'
$dest='D:\AI\AI_program\英语六级\wordvault\data\raw\cet6-resources-full.tar.gz'
$log='D:\AI\AI_program\英语六级\wordvault\data\download2.log'
function Log([string]$m){ $l=(Get-Date -Format 'HH:mm:ss')+'  '+$m; Add-Content -LiteralPath $log -Value $l -Encoding UTF8; Write-Output $l }
Remove-Item -Force $dest -ErrorAction SilentlyContinue
Log '真题整库重新下载（codeload 不支持续传）'
$sw=[Diagnostics.Stopwatch]::StartNew()
for ($i=1; $i -le 30; $i++) {
  curl.exe -sSL -x $proxy --retry 10 --retry-delay 5 --connect-timeout 25 -o $dest 'https://codeload.github.com/YinsinSirius/CET6-Resources/tar.gz/refs/heads/master' 2>$null
  $sw.Stop(); $size=(Get-Item $dest -ErrorAction SilentlyContinue).Length
  Log ("第 $i 次结束： " + [math]::Round($size/1MB,1) + ' MB，用时 ' + [math]::Round($sw.Elapsed.TotalSeconds) + 's')
  if ($size -ge 1000000000) { Log 'DONE 完整'; break }
  if ($size -gt 0 -and $i -ge 3) { break }
}
Log '===== 真题整库下载结束 ====='
