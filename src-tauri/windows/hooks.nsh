; Liquid Hub — Custom Windows Install & Uninstall Setup Hooks (NSIS MUI2)
; Gracefully stops running instances, preserves user library/backups on upgrade,
; registers liquidhub:// deep links immediately, and offers clean data choice on uninstall.

!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Liquid Hub: Verificando instâncias em execução..."
  ExecWait 'cmd.exe /C taskkill /F /IM liquid-hub.exe >NUL 2>&1'

  DetailPrint "Liquid Hub: Protegendo biblioteca local antes da instalação..."
  IfFileExists "$APPDATA\com.nlzwrld.liquidhub\library.sqlite" 0 +3
    CreateDirectory "$APPDATA\com.nlzwrld.liquidhub\backups"
    CopyFiles /SILENT "$APPDATA\com.nlzwrld.liquidhub\library.sqlite" "$APPDATA\com.nlzwrld.liquidhub\backups\library-preinstall-backup.sqlite"

  IfFileExists "$LOCALAPPDATA\Liquid Hub\library.sqlite" 0 +3
    CreateDirectory "$LOCALAPPDATA\Liquid Hub\backups"
    CopyFiles /SILENT "$LOCALAPPDATA\Liquid Hub\library.sqlite" "$LOCALAPPDATA\Liquid Hub\backups\library-preinstall-backup.sqlite"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Liquid Hub: Registrando protocolo liquidhub://..."
  WriteRegStr HKCU "Software\Classes\liquidhub" "" "URL:Liquid Hub Protocol"
  WriteRegStr HKCU "Software\Classes\liquidhub" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\liquidhub\DefaultIcon" "" "$INSTDIR\liquid-hub.exe,0"
  WriteRegStr HKCU "Software\Classes\liquidhub\shell\open\command" "" '"$INSTDIR\liquid-hub.exe" "%1"'

  DetailPrint "Liquid Hub: Gravando manifesto de integridade da instalação..."
  FileOpen $0 "$INSTDIR\install-integrity.json" w
  FileWrite $0 '{"product":"Liquid Hub","version":"${VERSION}","channel":"stable","integrity":"Minisign-Ed25519+SHA-256","repairSupported":true,"protocol":"liquidhub"}'
  FileClose $0
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "Liquid Hub: Encerrando aplicativo antes da desinstalação..."
  ExecWait 'cmd.exe /C taskkill /F /IM liquid-hub.exe >NUL 2>&1'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DetailPrint "Liquid Hub: Removendo associações de protocolo e inicialização..."
  DeleteRegKey HKCU "Software\Classes\liquidhub"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Liquid Hub"

  ; During silent auto-updates (/S), always preserve user library, playlists and vault
  IfSilent 0 +2
    Goto lh_keep_data

  MessageBox MB_YESNO|MB_ICONQUESTION "Deseja manter sua biblioteca local, playlists, downloads offline e configurações do Liquid Hub para uma futura instalação?" IDYES lh_keep_data

  DetailPrint "Liquid Hub: Removendo dados locais e cache do usuário..."
  RMDir /r "$APPDATA\com.nlzwrld.liquidhub"
  RMDir /r "$LOCALAPPDATA\com.nlzwrld.liquidhub"
  RMDir /r "$LOCALAPPDATA\Liquid Hub"
  Goto lh_done_uninstall

  lh_keep_data:
  DetailPrint "Liquid Hub: Biblioteca local e backups preservados com segurança."

  lh_done_uninstall:
!macroend
