# Runs the STEVE Bambu connector in the background whenever you log in to Windows, restarting it if it stops.
#
#   powershell -ExecutionPolicy Bypass -File service\windows\install.ps1 [-Config config.json] [-Data data] [-Name "STEVE Bambu Connector"]
#
# It is a scheduled task in your own session (not a Windows service), because "Open in Bambu Studio" and
# Bambu Connect open windows on your desktop, which a Windows service can't do.
# Remove it with service\windows\uninstall.ps1.
param(
  [string]$Config = 'config.json',
  [string]$Data = 'data',
  [string]$Name = 'STEVE Bambu Connector'
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$node = (Get-Command node -ErrorAction Stop).Source
if (-not (Test-Path (Join-Path $root $Config))) { throw "No $Config in $root. Run 'node setup.js' first." }
if (-not (Test-Path (Join-Path $root "$Data\state.json"))) { throw "Not paired yet. Run 'node connector.js --pair <CODE>' once first." }

# start-connector.cmd restarts the connector if it exits; conhost --headless keeps it out of sight.
$cmdArgs = "/c `"`"$root\start-connector.cmd`" --config `"$Config`" --data `"$Data`"`""
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\conhost.exe" `
  -Argument "--headless $env:SystemRoot\System32\cmd.exe $cmdArgs" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $Name -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
  -Description "STEVE connector for a Bambu Lab printer ($root)" -Force | Out-Null
Start-ScheduledTask -TaskName $Name
Write-Host "Installed and started '$Name'. It starts when you log in. Log: $root\$Data\connector.log"
Write-Host "Stop:   Stop-ScheduledTask -TaskName '$Name'   (then end node.exe if needed)"
Write-Host "Remove: powershell -ExecutionPolicy Bypass -File service\windows\uninstall.ps1"
