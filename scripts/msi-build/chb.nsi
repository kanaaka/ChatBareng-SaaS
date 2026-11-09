; ChatBareng — NSIS installer (Windows x64, per-user, no admin)
; Build di Linux: makensis chb.nsi  (hasil: ChatBareng-Install.exe)
Unicode true
; Build di Linux: makensis -DROOT=/path/payload -DOUTFILE=/path/ChatBareng-Install.exe chb.nsi
; Payload = repo-tree mirror + node portable win-x64 + data/wa-cs-hub.db (pre-migrated kosong) + start.bat + PANDUAN
!include "MUI2.nsh"

!define APPNAME "ChatBareng"
!define APPVER "4.6.13"
!define PUBLISHER "kanaaka"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\ChatBareng"

Name "${APPNAME} (${APPVER})"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\ChatBareng"
InstallDirRegKey HKCU "${UNINSTKEY}" "InstallLocation"
RequestExecutionLevel user
SetCompressor /SOLID lzma

!define MUI_TEXTWELCOME_INFO "Instalasi ChatBareng (WhatsApp CS Hub) - file server lengkap + Node.js portabel akan dicopy ke folder instalasi (tidak perlu admin, tidak perlu install Node)."
!define MUI_TEXTDIRECTORY_TITLE "Folder instalasi"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\start.bat"
!define MUI_FINISHPAGE_SHOWREADME "$INSTDIR\PANDUAN-INSTALL-WINDOWS.txt"
!define MUI_FINISHPAGE_SHOWREADME_TEXT "Buka panduan pemakaian"
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Section "Install"
  SetOutPath "$INSTDIR"
  File /r "${ROOT}\*.*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  ; Start Menu (per-user)
  CreateDirectory "$SMPROGRAMS\ChatBareng"
  CreateShortcut "$SMPROGRAMS\ChatBareng\ChatBareng.lnk" "$WINDIR\System32\cmd.exe" '/c "$INSTDIR\start.bat"' "$INSTDIR"
  CreateShortcut "$SMPROGRAMS\ChatBareng\Panduan ChatBareng.lnk" "$INSTDIR\PANDUAN-INSTALL-WINDOWS.txt"

  ; Entry Add/Remove (HKCU - muncul di Settings > Apps)
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayName" "ChatBareng (WhatsApp CS Hub)"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayVersion" "${APPVER}"
  WriteRegStr HKCU "${UNINSTKEY}" "Publisher" "${PUBLISHER}"
  WriteRegStr HKCU "${UNINSTKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayIcon" "$INSTDIR\node\node.exe"
  WriteRegStr HKCU "${UNINSTKEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "${UNINSTKEY}" "EstimatedSize" 460000
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  MessageBox MB_YESNO|MB_ICONQUESTION "Hapus juga DATA ChatBareng?$\n(DB chat, media, sesi WA, kredensial $\u2014 di folder data)$\n$\nNO = data tetap disimpan (bisa dipakai lagi nanti)." IDYES deldata IDNO keep
  deldata:
    RMDir /r "$INSTDIR\data"
    goto done
  keep:
    goto done
  done:
    RMDir /r "$INSTDIR\node"
    RMDir /r "$INSTDIR\node_modules"
    RMDir /r "$INSTDIR\src"
    RMDir /r "$INSTDIR\public"
    RMDir /r "$INSTDIR\prisma"
    RMDir /r "$INSTDIR\scripts"
    Delete "$INSTDIR\start.bat"
    Delete "$INSTDIR\package.json"
    Delete "$INSTDIR\version.json"
    Delete "$INSTDIR\PANDUAN-INSTALL-WINDOWS.txt"
    Delete "$INSTDIR\README.md"
    Delete "$INSTDIR\.env"
    Delete "$INSTDIR\Uninstall.exe"
    Delete "$SMPROGRAMS\ChatBareng\*.*"
    RMDir "$SMPROGRAMS\ChatBareng"
    DeleteRegKey HKCU "${UNINSTKEY}"
SectionEnd
