!macro KunAbortAutomaticUpdate CODE PHASE MESSAGE
  ${if} ${isUpdated}
    StrCpy $KunInstallerAbortCode "${CODE}"
    StrCpy $KunInstallerAbortPhase "${PHASE}"
    StrCpy $KunInstallerAbortMessage "${MESSAGE}"
    Call KunRestoreAutomaticUpdateBackup
    Call KunWriteAutomaticUpdateResult
    Call KunTryRelaunchOldApp
  ${endif}
  SetErrorLevel 2
  Quit
!macroend

!macro KunCompleteAutomaticUpdate
  ${if} ${isUpdated}
    StrCpy $KunInstallerAbortCode "success"
    StrCpy $KunInstallerAbortPhase "validated"
    StrCpy $KunInstallerAbortMessage "Payload validation completed; first-launch health check is pending."
    Call KunWriteAutomaticUpdateResult
  ${endif}
!macroend

!macro KunAutomaticUpdateFunctions
  Function KunWriteAutomaticUpdateResult
    ${ifNot} ${isUpdated}
      Return
    ${endif}
    ReadEnvStr $KunInstallerPendingResultPath "KUN_PENDING_UPDATE_RESULT"
    ${if} $KunInstallerPendingResultPath == ""
      Return
    ${endif}
    System::Call 'kernel32::SetEnvironmentVariable(t, t)i ("KUN_INSTALLER_PENDING_RESULT", "$KunInstallerPendingResultPath").r0'
    System::Call 'kernel32::SetEnvironmentVariable(t, t)i ("KUN_INSTALLER_ABORT_CODE", "$KunInstallerAbortCode").r0'
    System::Call 'kernel32::SetEnvironmentVariable(t, t)i ("KUN_INSTALLER_ABORT_PHASE", "$KunInstallerAbortPhase").r0'
    System::Call 'kernel32::SetEnvironmentVariable(t, t)i ("KUN_INSTALLER_ABORT_MESSAGE", "$KunInstallerAbortMessage").r0'
    !insertmacro kunRunMigrationHelper WriteUpdateResult
    ${if} $KunInstallerHelperExitCode != 0
      DetailPrint "Kun could not record the automatic-update result: $KunInstallerHelperOutput"
    ${endif}
  FunctionEnd

  Function KunRestoreAutomaticUpdateBackup
    ${if} $KunInstallerInPlaceUpdate != 1
      Return
    ${endif}
    !insertmacro kunRunMigrationHelper RestorePayloadBackup
    ${if} $KunInstallerHelperExitCode != 0
      DetailPrint "Kun could not restore the in-place update backup: $KunInstallerHelperOutput"
    ${endif}
  FunctionEnd

  Function KunTryRelaunchOldApp
    ${ifNot} ${isUpdated}
      Return
    ${endif}
    ${if} $KunInstallerInPlaceUpdate == 1
      StrCpy $R0 "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
      StrCpy $R2 "$INSTDIR\resources\app.asar"
    ${else}
      ReadEnvStr $R1 "KUN_INSTALLER_UPDATE_SOURCE"
      ${if} $R1 == ""
        DetailPrint "No automatic-update source directory was available for restart."
        Return
      ${endif}
      StrCpy $R0 "$R1\${APP_EXECUTABLE_FILENAME}"
      StrCpy $R2 "$R1\resources\app.asar"
    ${endif}
    ${if} ${FileExists} "$R0"
    ${andIf} ${FileExists} "$R2"
      DetailPrint "Restarting the preserved ${PRODUCT_NAME} application after automatic-update failure."
      Exec '"$R0"'
    ${else}
      DetailPrint "The preserved ${PRODUCT_NAME} executable is unavailable after automatic-update failure."
    ${endif}
  FunctionEnd
!macroend
