!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro customUnInstall
  IfFileExists "$INSTDIR\config.json" config_file_exists
  Goto config_backup_done
config_file_exists:
  CreateDirectory "$APPDATA\UniShell"
  IfFileExists "$APPDATA\UniShell\config.json.install-backup" config_backup_done
  CopyFiles /SILENT "$INSTDIR\config.json" "$APPDATA\UniShell\config.json.install-backup"
config_backup_done:
!macroend

!macro customInstall
  IfFileExists "$APPDATA\UniShell\config.json.install-backup" config_backup_exists
  Goto config_restore_done
config_backup_exists:
  IfFileExists "$INSTDIR\config.json" config_restore_done
  CopyFiles /SILENT "$APPDATA\UniShell\config.json.install-backup" "$INSTDIR\config.json"
  Delete "$APPDATA\UniShell\config.json.install-backup"
config_restore_done:
!macroend
