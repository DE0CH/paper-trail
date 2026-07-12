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
  MessageBox MB_OKCANCEL|MB_ICONINFORMATION `${PRODUCT_NAME} is running. Click OK to close it - you will be asked to save any unsaved reading session first.` /SD IDOK IDOK close_${PT_UID}
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
  MessageBox MB_OK|MB_ICONEXCLAMATION `${PRODUCT_NAME} is still running - it may be waiting for you to save your reading session. Finish up in the app, then run the installer again.`

abort_${PT_UID}:
  SetErrorLevel 4
  Quit

notRunning_${PT_UID}:
  !undef PT_UID
!macroend
