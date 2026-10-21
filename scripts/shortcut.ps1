# Creates a Start Menu shortcut for the widget (relaunch it after quitting).
$root = Split-Path -Parent $PSScriptRoot
$lnk = Join-Path ([Environment]::GetFolderPath('Programs')) 'Send to Phone.lnk'
$s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
$s.TargetPath = Join-Path $root 'node_modules\electron\dist\electron.exe'
$s.Arguments = '"' + $root + '"'
$s.WorkingDirectory = $root
$s.IconLocation = Join-Path $root 'assets\icon.ico'
$s.Description = 'Drop files to send them to your phone'
$s.Save()
Write-Output "Created $lnk"
