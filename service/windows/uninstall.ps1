# Removes the scheduled task made by install.ps1 and stops the connector it started.
#   powershell -ExecutionPolicy Bypass -File service\windows\uninstall.ps1 [-Name "STEVE Bambu Connector"]
param([string]$Name = 'STEVE Bambu Connector')
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $Name -Confirm:$false
  Write-Host "Removed '$Name'."
} else {
  Write-Host "No task named '$Name'."
}
# The task's cmd loop and its node process run from this folder; stop both (and any child of the loop).
$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='cmd.exe'"
$ours = $procs | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($root) -and ($_.CommandLine -match 'connector\.js|start-connector\.cmd') }
$ids = @($ours.ProcessId) + @($procs | Where-Object { $ours.ProcessId -contains $_.ParentProcessId } | ForEach-Object { $_.ProcessId })
$ids | Select-Object -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue; Write-Host "Stopped process $_." }
