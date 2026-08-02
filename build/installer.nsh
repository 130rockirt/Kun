!ifndef BUILD_UNINSTALLER
Var /GLOBAL KunInstallerSourceDir
Var /GLOBAL KunInstallerPrimarySourceDir
Var /GLOBAL KunInstallerSecondarySourceDir
Var /GLOBAL KunInstallerTargetDir
Var /GLOBAL KunInstallerResultPath
Var /GLOBAL KunInstallerResultHandle
Var /GLOBAL KunInstallerJournalPath
Var /GLOBAL KunInstallerMigrationPrepared
Var /GLOBAL KunInstallerSnapshotMode
Var /GLOBAL KunInstallerRestoreInteractive
!endif
Var /GLOBAL KunInstallerHelperPath
Var /GLOBAL KunInstallerPowerShellPath
Var /GLOBAL KunInstallerHelperExitCode
Var /GLOBAL KunInstallerHelperOutput
Var /GLOBAL KunInstallerCurrentPid
!ifdef BUILD_UNINSTALLER
Var /GLOBAL KunInstallerStopAttempt
Var /GLOBAL KunInstallerStopResult
!endif

!macro kunRunMigrationHelper ACTION
  nsExec::ExecToStack `"$KunInstallerPowerShellPath" -NoProfile -ExecutionPolicy Bypass -File "$KunInstallerHelperPath" -Action ${ACTION}`
  Pop $KunInstallerHelperExitCode
  Pop $KunInstallerHelperOutput
!macroend

!macro customPageAfterChangeDir
  !define MUI_PAGE_CUSTOMFUNCTION_PRE KunInstallDirectoryPagePre
  !define MUI_PAGE_CUSTOMFUNCTION_LEAVE KunInstallDirectoryPageLeave
  !insertmacro MUI_PAGE_DIRECTORY
  !define MUI_PAGE_CUSTOMFUNCTION_PRE KunInstallFilesPagePre
!macroend

!macro customInit
  InitPluginsDir
  StrCpy $KunInstallerPowerShellPath "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  File /oname=$PLUGINSDIR\kun-windows-installer-migration.ps1 "${PROJECT_DIR}\build\windows-installer-migration.ps1"
  StrCpy $KunInstallerHelperPath "$PLUGINSDIR\kun-windows-installer-migration.ps1"
  StrCpy $KunInstallerResultPath "$PLUGINSDIR\kun-windows-installer-result.txt"
  System::Call 'kernel32::GetCurrentProcessId() i .r0'
  StrCpy $KunInstallerCurrentPid $0
  StrCpy $KunInstallerMigrationPrepared 0
  StrCpy $KunInstallerSnapshotMode ""
  !ifndef BUILD_UNINSTALLER
    StrCpy $KunInstallerRestoreInteractive 0
  !endif

  ${if} ${isUpdated}
    # electron-updater always passes --updated, including older Kun versions
    # that launched the assisted installer without /S. Force only that path
    # into silent mode so retry/cancel dialogs use their safe default while a
    # manually launched installer remains interactive.
    SetSilent silent
  ${endif}

  Call KunRefreshInstallPaths

  ${if} ${UAC_IsInnerInstance}
  ${andIf} ${Silent}
    Call KunPrepareInstallMigration
  ${endif}
!macroend

!macro customCheckAppRunning
  !ifdef BUILD_UNINSTALLER
    ${if} $INSTDIR == ""
      Return
    ${endif}

    InitPluginsDir
    StrCpy $KunInstallerPowerShellPath "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
    File /oname=$PLUGINSDIR\kun-windows-installer-migration.ps1 "${PROJECT_DIR}\build\windows-installer-migration.ps1"
    StrCpy $KunInstallerHelperPath "$PLUGINSDIR\kun-windows-installer-migration.ps1"
    System::Call 'kernel32::GetCurrentProcessId() i .r0'
    StrCpy $KunInstallerCurrentPid $0
    System::Call 'kernel32::SetEnvironmentVariable(t, t)i ("KUN_INSTALLER_APP_ROOT", "$INSTDIR").r0'
    System::Call 'kernel32::SetEnvironmentVariable(t, t)i ("KUN_INSTALLER_SELF_PID", "$KunInstallerCurrentPid").r0'
    StrCpy $KunInstallerStopAttempt 0

    KunStopProcessesFromInstallDir:
      IntOp $KunInstallerStopAttempt $KunInstallerStopAttempt + 1
      DetailPrint "Checking for running ${PRODUCT_NAME} processes under $INSTDIR."
      !insertmacro kunRunMigrationHelper StopProcesses
      StrCpy $KunInstallerStopResult $KunInstallerHelperExitCode

      ${if} $KunInstallerStopResult == 0
        Goto KunInstallDirProcessesStopped
      ${endif}

      Sleep 1200
      ${if} $KunInstallerStopAttempt <= 5
        Goto KunStopProcessesFromInstallDir
      ${endif}

      ${ifNot} ${isUpdated}
        MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY KunStopProcessesFromInstallDir
        Quit
      ${endif}

      DetailPrint "${PRODUCT_NAME} processes may still be running; stopping uninstall to preserve the installation."
      SetErrorLevel 2
      Quit

    KunInstallDirProcessesStopped:
  !else
    Call KunPrepareInstallMigration
    StrCpy $appExe "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    ${ifNot} ${Silent}
      SetSilent silent
      StrCpy $KunInstallerRestoreInteractive 1
    ${endif}
  !endif
!macroend

!macro customUnInstallCheck
  StrCpy $KunInstallerSourceDir $KunInstallerPrimarySourceDir
  Call KunHandleOldUninstallerResult
  ${if} $installMode != "all"
    Call KunRestoreInteractiveInstaller
  ${endif}
!macroend

!macro customUnInstallCheckCurrentUser
  StrCpy $KunInstallerSourceDir $KunInstallerSecondarySourceDir
  Call KunHandleOldUninstallerResult
  StrCpy $KunInstallerSourceDir $KunInstallerPrimarySourceDir
  Call KunRestoreInteractiveInstaller
!macroend

!macro customInstall
  StrCpy $KunInstallerTargetDir $INSTDIR
  Call KunSetMigrationEnvironment

  !insertmacro kunRunMigrationHelper Restore
  ${if} $KunInstallerHelperExitCode != 0
    MessageBox MB_OK|MB_ICONSTOP "Kun was installed, but preserved files could not be restored without overwriting another file. The recovery directory and log were retained.$\r$\n$KunInstallerHelperOutput" /SD IDOK
    SetErrorLevel 2
    Quit
  ${endif}

  !insertmacro kunRunMigrationHelper UpdatePath
  ${if} $KunInstallerHelperExitCode != 0
    DetailPrint "Kun could not update the user PATH: $KunInstallerHelperOutput"
  ${else}
    DetailPrint "Reconciled the user PATH from $KunInstallerSourceDir\bin to $INSTDIR\bin."
  ${endif}
  System::Call 'user32::SendMessageTimeout(i 0xffff, i 0x001A, i 0, t "Environment", i 2, i 5000, *i .r0)'
!macroend

!macro customUnInstall
  DetailPrint "Removing $INSTDIR\bin from PATH."
  System::Call 'kernel32::SetEnvironmentVariable(t, t)i ("KUN_CLI_BIN", "$INSTDIR\bin").r0'
  nsExec::ExecToLog `"$PowerShellPath" -NoProfile -ExecutionPolicy Bypass -Command "$$p=[Environment]::GetEnvironmentVariable('Path','User');$$parts=@($$p -split ';' | ? { $$_.Trim() -ne '' -and -not $$_.TrimEnd('\').Equals($$env:KUN_CLI_BIN.TrimEnd('\'),'OrdinalIgnoreCase') });[Environment]::SetEnvironmentVariable('Path',($$parts -join ';'),'User')"`
  Pop $0
  System::Call 'user32::SendMessageTimeout(i 0xffff, i 0x001A, i 0, t "Environment", i 2, i 5000, *i .r0)'
!macroend

# installer.nsi inserts customHeader after common.nsh, multiUser.nsh, and the
# assisted-page declarations. Defining functions there lets them reference the
# template's installMode/appExe variables without forking the upstream script.
!macro customHeader
!ifndef BUILD_UNINSTALLER
  Function KunSetMigrationEnvironment
    # $APPDATA follows SetShellVarContext, so per-machine recovery is shared
    # while current-user recovery stays in the selected user's profile.
    StrCpy $KunInstallerJournalPath "$APPDATA\KunInstallerRecovery\${APP_GUID}.json"

    System::Call 'kernel32::SetEnvironmentVariable(t, t)i ("KUN_INSTALLER_SOURCE", "$KunInstallerSourceDir").r0'
    System::Call 'kernel32::SetEnvironmentVariable(t, t)i ("KUN_INSTALLER_SECONDARY_SOURCE", "$KunInstallerSecondarySourceDir").r0'
    System::Call 'kernel32::SetEnvironmentVariable(t, t)i ("KUN_INSTALLER_TARGET", "$KunInstallerTargetDir").r0'
    System::Call 'kernel32::SetEnvironmentVariable(t, t)i ("KUN_INSTALLER_JOURNAL", "$KunInstallerJournalPath").r0'
    System::Call 'kernel32::SetEnvironmentVariable(t, t)i ("KUN_INSTALLER_SELF_PID", "$KunInstallerCurrentPid").r0'
  FunctionEnd

  Function KunReadMigrationResult
    ClearErrors
    StrCpy $KunInstallerHelperOutput ""
    FileOpen $KunInstallerResultHandle "$KunInstallerResultPath" r
    IfErrors KunMigrationResultMissing
    FileReadUTF16LE $KunInstallerResultHandle $KunInstallerHelperOutput
    FileClose $KunInstallerResultHandle
    Delete "$KunInstallerResultPath"
    Return

    KunMigrationResultMissing:
      StrCpy $KunInstallerHelperExitCode 1
      StrCpy $KunInstallerHelperOutput "The path resolver did not produce a result file."
      Delete "$KunInstallerResultPath"
  FunctionEnd

  Function KunGetInQuotes
    Exch $R0
    Push $R1
    Push $R2

    StrCpy $R1 -1
    KunGetInQuotesFindStart:
      IntOp $R1 $R1 + 1
      StrCpy $R2 $R0 1 $R1
      StrCmp $R2 "" KunGetInQuotesInvalid
      StrCmp $R2 '"' KunGetInQuotesStart KunGetInQuotesFindStart

    KunGetInQuotesStart:
      IntOp $R1 $R1 + 1
      StrCpy $R0 $R0 "" $R1
      StrCpy $R1 0

    KunGetInQuotesFindEnd:
      IntOp $R1 $R1 + 1
      StrCpy $R2 $R0 1 $R1
      StrCmp $R2 "" KunGetInQuotesInvalid
      StrCmp $R2 '"' KunGetInQuotesDone KunGetInQuotesFindEnd

    KunGetInQuotesInvalid:
      StrCpy $R0 ""
      Goto KunGetInQuotesReturn

    KunGetInQuotesDone:
      StrCpy $R0 $R0 $R1

    KunGetInQuotesReturn:
      Pop $R2
      Pop $R1
      Exch $R0
  FunctionEnd

  Function KunGetFileParent
    Exch $R0
    Push $R1
    Push $R2
    Push $R3

    StrCpy $R1 0
    StrLen $R2 $R0

    KunGetFileParentLoop:
      IntOp $R1 $R1 + 1
      IntCmp $R1 $R2 KunGetFileParentDone 0 KunGetFileParentDone
      StrCpy $R3 $R0 1 -$R1
      StrCmp $R3 "\" KunGetFileParentDone KunGetFileParentLoop

    KunGetFileParentDone:
      StrCpy $R0 $R0 -$R1
      Pop $R3
      Pop $R2
      Pop $R1
      Exch $R0
  FunctionEnd

  Function KunRecoverSourceFromUninstallString
    StrCpy $KunInstallerSourceDir ""
    Push "$R9"
    Call KunGetInQuotes
    Pop $KunInstallerSourceDir
    ${if} $KunInstallerSourceDir != ""
      Push $KunInstallerSourceDir
      Call KunGetFileParent
      Pop $KunInstallerSourceDir
    ${endif}
    ${if} $KunInstallerSourceDir == ""
      MessageBox MB_OK|MB_ICONSTOP "Kun found an existing uninstall registration but could not recover its installation directory." /SD IDOK
      SetErrorLevel 2
      Quit
    ${endif}
  FunctionEnd

  Function KunReadRegisteredSource
    ReadRegStr $KunInstallerSourceDir SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${if} $KunInstallerSourceDir == ""
      ReadRegStr $R9 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" UninstallString
      ${if} $R9 == ""
      ${andIf} $installMode != "all"
        ReadRegStr $R9 HKEY_CURRENT_USER "${UNINSTALL_REGISTRY_KEY}" UninstallString
      ${endif}
      ${if} $R9 != ""
        Call KunRecoverSourceFromUninstallString
      ${endif}
    ${endif}
    StrCpy $KunInstallerPrimarySourceDir $KunInstallerSourceDir
    StrCpy $KunInstallerSecondarySourceDir ""
    ${if} $installMode == "all"
      ReadRegStr $KunInstallerSecondarySourceDir HKEY_CURRENT_USER "${INSTALL_REGISTRY_KEY}" InstallLocation
      ${if} $KunInstallerSecondarySourceDir == ""
        ReadRegStr $R9 HKEY_CURRENT_USER "${UNINSTALL_REGISTRY_KEY}" UninstallString
        ${if} $R9 != ""
          Call KunRecoverSourceFromUninstallString
          StrCpy $KunInstallerSecondarySourceDir $KunInstallerSourceDir
        ${endif}
      ${endif}
    ${endif}
  FunctionEnd

  Function KunResolveInstallTarget
    System::Call 'kernel32::SetEnvironmentVariable(t, t)i ("KUN_INSTALLER_SOURCE", "$KunInstallerSourceDir").r0'
    System::Call 'kernel32::SetEnvironmentVariable(t, t)i ("KUN_INSTALLER_CANDIDATE", "$INSTDIR").r0'
    Delete "$KunInstallerResultPath"
    !insertmacro kunRunMigrationHelper ResolvePath
    ${if} $KunInstallerHelperExitCode == 0
      Call KunReadMigrationResult
    ${endif}
    ${if} $KunInstallerHelperExitCode != 0
    ${orIf} $KunInstallerHelperOutput == ""
      MessageBox MB_OK|MB_ICONSTOP "Kun could not resolve a safe installation directory.$\r$\n$KunInstallerHelperOutput" /SD IDOK
      SetErrorLevel 2
      Quit
    ${endif}
    StrCpy $KunInstallerTargetDir $KunInstallerHelperOutput
    StrCpy $INSTDIR $KunInstallerTargetDir
  FunctionEnd

  Function KunRefreshInstallPaths
    # The old uninstaller removes its registration. Keep the first source snapshot
    # for the selected mode and only refresh it if the user changes install mode.
    ${if} $KunInstallerSnapshotMode != $installMode
      Call KunReadRegisteredSource
      StrCpy $KunInstallerSnapshotMode $installMode
    ${endif}
    StrCpy $KunInstallerSourceDir $KunInstallerPrimarySourceDir
    Call KunResolveInstallTarget
    Call KunSetMigrationEnvironment
  FunctionEnd

  Function KunInstallDirectoryPagePre
    ${if} ${isUpdated}
      Abort
    ${endif}
    Call KunRefreshInstallPaths
  FunctionEnd

  Function KunInstallDirectoryPageLeave
    Call KunRefreshInstallPaths
  FunctionEnd

  Function KunInstallFilesPagePre
    Call KunPrepareInstallMigration
  FunctionEnd

  Function KunPrepareInstallMigration
    ${if} $KunInstallerMigrationPrepared == 1
      Return
    ${endif}
    Call KunRefreshInstallPaths
    !insertmacro kunRunMigrationHelper Prepare
    ${if} $KunInstallerHelperExitCode != 0
      MessageBox MB_OK|MB_ICONSTOP "Kun kept the existing installation unchanged because it could not migrate the program directory safely.$\r$\n$KunInstallerHelperOutput" /SD IDOK
      SetErrorLevel 2
      Quit
    ${endif}
    StrCpy $KunInstallerMigrationPrepared 1
  FunctionEnd

  Function KunHandleOldUninstallerResult
    IfErrors KunOldUninstallerFailed KunOldUninstallerFinished

    KunOldUninstallerFailed:
      DetailPrint "Old ${PRODUCT_NAME} uninstaller was unavailable or failed for $KunInstallerSourceDir."

    KunOldUninstallerFinished:
      DetailPrint "Cleaning only recognized application payload left in $KunInstallerSourceDir."
      Call KunSetMigrationEnvironment
      !insertmacro kunRunMigrationHelper FallbackCleanup
      ${if} $KunInstallerHelperExitCode != 0
        MessageBox MB_OK|MB_ICONSTOP "Kun could not clean the old program files safely.$\r$\n$KunInstallerHelperOutput" /SD IDOK
        SetErrorLevel 2
        Quit
      ${endif}
      ClearErrors
      StrCpy $R0 0
  FunctionEnd

  Function KunRestoreInteractiveInstaller
    ${if} $KunInstallerRestoreInteractive == 1
      SetSilent normal
      StrCpy $KunInstallerRestoreInteractive 0
    ${endif}
  FunctionEnd
!endif
!macroend
