# Removes the scheduled task made by install.ps1 and stops the connector it started.
param([string]$Name = 'STEVE Bambu Connector')
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $Name -Confirm:$false
  Write-Host "Removed '$Name'."
} else {
  Write-Host "No task named '$Name'."
}
# The task's cmd loop and node process are ours if they run from this folder.
Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='cmd.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine.Contains($root) -and ($_.CommandLine -match 'connector\.js|start-connector\.cmd') } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Write-Host "Stopped process $($_.ProcessId)." }
