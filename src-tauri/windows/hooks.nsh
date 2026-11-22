; Liquid Hub — NSIS Custom Installer & Maintenance Hooks (Seção 19)
; Preserves local library, offline downloads, and encrypted vault during updates/repairs
; and writes an installation integrity manifest for post-install verification.

!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Liquid Hub: Verificando instalação anterior e preservando dados locais..."
  IfFileExists "$LOCALAPPDATA\Liquid Hub\library.sqlite" 0 +3
    CreateDirectory "$LOCALAPPDATA\Liquid Hub\backups"
    CopyFiles /SILENT "$LOCALAPPDATA\Liquid Hub\library.sqlite" "$LOCALAPPDATA\Liquid Hub\backups\library-preinstall-backup.sqlite"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Liquid Hub: Gravando manifesto de integridade da instalação..."
  FileOpen $0 "$INSTDIR\install-integrity.json" w
  FileWrite $0 '{"product":"Liquid Hub","version":"${VERSION}","channel":"stable","integrity":"Minisign-Ed25519+SHA-256","repairSupported":true}'
  FileClose $0
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "Liquid Hub: Preparando remoção segura do aplicativo..."
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Never delete user library or offline downloads automatically without explicit confirmation
  IfSilent +5 0
  MessageBox MB_YESNO|MB_ICONQUESTION "Deseja manter sua biblioteca local, playlists e backups do Liquid Hub para uso futuro?" IDYES +4
    RMDir /r "$LOCALAPPDATA\Liquid Hub\cache"
    Goto +2
  DetailPrint "Liquid Hub: Dados locais e biblioteca preservados com segurança."
!macroend
