!macro customHeader
  ; Declare DPI awareness: without it Windows renders the installer at
  ; 96 dpi and bitmap-stretches the result, so the whole Setup UI is
  ; pixelated on HiDPI screens.
  ManifestDPIAware true
!macroend

; Paper Trail is never force-closed by the installer. The stock
; electron-builder check ends in `taskkill /F` after a grace period,
; which silently destroys unsaved reading sessions. This replacement
; only ever REQUESTS a close - the request runs through the app's
; normal close path, including the unsaved-session prompt - and if the
; app is still open afterwards (the user chose Save or Cancel, or the
; app is simply busy), the installer errors out with exit code 4
; instead of killing it.

!macro customCheckAppRunning
  !define PT_UID "PT${__LINE__}"

  nsExec::Exec `"$SYSDIR\cmd.exe" /C tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${APP_EXECUTABLE_FILENAME}\""`
  Pop $R0
  StrCmp $R0 "0" 0 notRunning_${PT_UID}

  IfSilent close_${PT_UID}
  MessageBox MB_OKCANCEL|MB_ICONINFORMATION `${PRODUCT_NAME} is running. Click OK to close it.` /SD IDOK IDOK close_${PT_UID}
  SetErrorLevel 4
  Quit

close_${PT_UID}:
  DetailPrint `Asking ${PRODUCT_NAME} to close...`
  ; a graceful close request only - never /F
  nsExec::Exec `"$SYSDIR\cmd.exe" /C taskkill /IM "${APP_EXECUTABLE_FILENAME}"`
  StrCpy $R1 0

wait_${PT_UID}:
  Sleep 1000
  nsExec::Exec `"$SYSDIR\cmd.exe" /C tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${APP_EXECUTABLE_FILENAME}\""`
  Pop $R0
  StrCmp $R0 "0" 0 notRunning_${PT_UID}
  IntOp $R1 $R1 + 1
  IntCmp $R1 20 giveUp_${PT_UID} wait_${PT_UID} giveUp_${PT_UID}

giveUp_${PT_UID}:
  ; still running: the app (or its user) declined to close
  IfSilent abort_${PT_UID}
  MessageBox MB_OK|MB_ICONEXCLAMATION `${PRODUCT_NAME} is still running - please close it and run the installer again.`

abort_${PT_UID}:
  SetErrorLevel 4
  Quit

notRunning_${PT_UID}:
  !undef PT_UID
!macroend

; The assisted installer offers a Shortcuts page after the directory
; page: two checkboxes, desktop and Start Menu, both preselected.
; Silent installs (/S - including every auto-update) never run page
; callbacks, so both choice variables stay empty there and the stock
; behavior - both shortcuts created on install, kept on update - is
; untouched. The choices are honored in customInstall below.
; (Installer compile only: the uninstaller pass never inserts the page,
; and declaring vars it can't reference is a makensis warning, which
; electron-builder's default -WX turns into a build failure.)
!ifndef BUILD_UNINSTALLER
Var /GLOBAL ptDesktopShortcutBox
Var /GLOBAL ptStartMenuShortcutBox
Var /GLOBAL ptDesktopShortcutChoice
Var /GLOBAL ptStartMenuShortcutChoice
!endif

!macro customPageAfterChangeDir
  !ifndef NSD_Check
    !include nsDialogs.nsh
  !endif

  Page custom ptShortcutsPageShow ptShortcutsPageLeave

  Function ptShortcutsPageShow
    ; a re-run for an update skips this page, like the directory page
    ${if} ${isUpdated}
      Abort
    ${endif}

    !insertmacro MUI_HEADER_TEXT "Choose Shortcuts" "Choose which shortcuts Setup creates for ${PRODUCT_NAME}."
    nsDialogs::Create 1018
    Pop $0
    ${if} $0 == error
      Abort
    ${endif}

    ${NSD_CreateLabel} 0 0 100% 20u "Setup can create these shortcuts for ${PRODUCT_NAME}. Clear the ones you don't want."
    Pop $1

    ${NSD_CreateCheckBox} 0 30u 100% 12u "Create a desktop shortcut"
    Pop $ptDesktopShortcutBox
    ${if} $ptDesktopShortcutChoice == "0"  ; keep the choice across Back
      ${NSD_Uncheck} $ptDesktopShortcutBox
    ${else}
      ${NSD_Check} $ptDesktopShortcutBox
    ${endif}

    ${NSD_CreateCheckBox} 0 46u 100% 12u "Create a Start Menu shortcut"
    Pop $ptStartMenuShortcutBox
    ${if} $ptStartMenuShortcutChoice == "0"
      ${NSD_Uncheck} $ptStartMenuShortcutBox
    ${else}
      ${NSD_Check} $ptStartMenuShortcutBox
    ${endif}

    nsDialogs::Show
  FunctionEnd

  Function ptShortcutsPageLeave
    ${NSD_GetState} $ptDesktopShortcutBox $ptDesktopShortcutChoice
    ${NSD_GetState} $ptStartMenuShortcutBox $ptStartMenuShortcutChoice
  FunctionEnd
!macroend

; Windows' "Installed apps" / Add-Remove-Programs list reads DisplayIcon.
; electron-builder's default left it showing the stock uninstaller icon
; (the red no-entry circle). Anchor it to the installed app exe, whose
; embedded icon is the app icon (the trail).
!macro customInstall
  WriteRegStr SHCTX "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "DisplayIcon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"

  ; Honor the Shortcuts page. The stock template has already created or
  ; kept the shortcuts by the time customInstall runs; an empty choice
  ; (silent install, update, page never shown) changes nothing, so the
  ; stock machinery stays in charge everywhere the page did not appear.
  ${if} $ptDesktopShortcutChoice == "0"
    WinShell::UninstShortcut "$newDesktopLink"
    Delete "$newDesktopLink"
    System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
  ${elseif} $ptDesktopShortcutChoice == "1"
    ${ifNot} ${FileExists} "$newDesktopLink"
      ; ticked on a reinstall whose earlier install skipped or lost it
      CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
      System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
    ${endif}
  ${endif}

  ${if} $ptStartMenuShortcutChoice == "0"
    WinShell::UninstShortcut "$newStartMenuLink"
    Delete "$newStartMenuLink"
    ; the finish page's Run option must not point at a deleted shortcut
    StrCpy $launchLink "$appExe"
  ${elseif} $ptStartMenuShortcutChoice == "1"
    ${ifNot} ${FileExists} "$newStartMenuLink"
      !insertmacro createMenuDirectory
      CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
      StrCpy $launchLink "$newStartMenuLink"
    ${endif}
  ${endif}
!macroend
