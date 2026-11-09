; ChatBareng SAAS — NSIS installer v2 (portable-launcher engine ala build teruji 2026-09-23)
Unicode true
!define MUI_ICON "${ROOT}\branding\chatbareng.ico"
!define MUI_UNICON "${ROOT}\branding\chatbareng.ico"
Icon "${ROOT}\branding\chatbareng.ico"
UninstallIcon "${ROOT}\branding\chatbareng.ico"
!include "MUI2.nsh"

!define APPNAME "ChatBareng"
!define APPVER "4.6.13"
!define PUBLISHER "kanaaka"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\ChatBareng"
; Build di Linux: makensis -DROOT=... -DOUTFILE=... chb-saas.nsi

Name "${APPNAME} (${APPVER})"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\ChatBareng"
InstallDirRegKey HKCU "${UNINSTKEY}" "InstallLocation"
RequestExecutionLevel user
SetCompressor /SOLID lzma

!define MUI_TEXTWELCOME_INFO "Instalasi ChatBareng (WhatsApp CS Hub - SaaS). File server lengkap: Node.js portabel + Cloudflare tunnel + launcher otomatis (database pertama, URL tunnel, browser) - tidak perlu admin, tidak perlu install Node."
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\Mulai-ChatBareng.exe"
!define MUI_FINISHPAGE_SHOWREADME "$INSTDIR\CARA-PAKAI.txt"
!define MUI_FINISHPAGE_SHOWREADME_TEXT "Buka CARA PAKAI"
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Section "Install"
  SetOutPath "$INSTDIR"
  File /r "${ROOT}\app"
  File "${ROOT}\Mulai-ChatBareng.exe"
  File "${ROOT}\cloudflared.exe"
  File "${ROOT}\CARA-PAKAI.txt"
  File "${ROOT}\branding\chatbareng.ico"
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  CreateDirectory "$SMPROGRAMS\ChatBareng"
  CreateShortcut "$SMPROGRAMS\ChatBareng\ChatBareng.lnk" "$INSTDIR\Mulai-ChatBareng.exe" "" "$INSTDIR\chatbareng.ico" 0 SW_SHOWNORMAL "" "Jalankan ChatBareng"
  CreateShortcut "$SMPROGRAMS\ChatBareng\CARA PAKAI.lnk" "$INSTDIR\CARA-PAKAI.txt"

  WriteRegStr HKCU "${UNINSTKEY}" "DisplayName" "ChatBareng (WhatsApp CS Hub)"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayVersion" "${APPVER}"
  WriteRegStr HKCU "${UNINSTKEY}" "Publisher" "${PUBLISHER}"
  WriteRegStr HKCU "${UNINSTKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayIcon" "$INSTDIR\Mulai-ChatBareng.exe"
  WriteRegStr HKCU "${UNINSTKEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "${UNINSTKEY}" "EstimatedSize" 470000
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  MessageBox MB_YESNO|MB_ICONQUESTION "Hapus juga DATA ChatBareng?$\n(DB chat, media, sesi WA, kredensial)$\n$\nNO = data tetap disimpan (bisa dipakai lagi nanti)." IDYES deldata IDNO keep
  deldata:
    RMDir /r "$INSTDIR\data"
    goto done
  keep:
    goto done
  done:
    RMDir /r "$INSTDIR\app"
    Delete "$INSTDIR\Mulai-ChatBareng.exe"
    Delete "$INSTDIR\cloudflared.exe"
    Delete "$INSTDIR\CARA-PAKAI.txt"
    Delete "$INSTDIR\chatbareng.ico"
    Delete "$INSTDIR\Uninstall.exe"
    Delete "$SMPROGRAMS\ChatBareng\*.*"
    RMDir "$SMPROGRAMS\ChatBareng"
    DeleteRegKey HKCU "${UNINSTKEY}"
SectionEnd
