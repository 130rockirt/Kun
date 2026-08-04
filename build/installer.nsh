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
Var /GLOBAL KunInstallerPrimarySourceStale
Var /GLOBAL KunInstallerSecondarySourceStale
Var /GLOBAL KunInstallerCandidateExplicit
Var /GLOBAL KunInstallerPresentedTargetDir
Var /GLOBAL KunInstallerUpdateSourceDir
Var /GLOBAL KunInstallerPreserveOtherScope
Var /GLOBAL KunInstallerOtherUninstallString
Var /GLOBAL KunInstallerOtherQuietUninstallString
Var /GLOBAL KunInstallerRestoreInteractive
Var /GLOBAL KunInstallerCurrentUserShortcutName
Var /GLOBAL KunInstallerCurrentUserMenuDirectory
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
  !ifdef BUILD_UNINSTALLER
    nsExec::ExecToStack `"$KunInstallerPowerShellPath" -NoProfile -ExecutionPolicy Bypass -File "$KunInstallerHelperPath" -Action ${ACTION}`
  !else
    nsExec::ExecToStack `"$KunInstallerPowerShellPath" -NoProfile -ExecutionPolicy Bypass -File "$KunInstallerHelperPath" -Action ${ACTION} -ResultPath "$KunInstallerResultPath"`
  !endif
  Pop $KunInstallerHelperExitCode
  Pop $KunInstallerHelperOutput
!macroend

!macro kunSetEnvironmentFromRegister NAME REGISTER
  # System::Call reparses quoted variable expansions. Copy arbitrary registry
  # text into a local NSIS register and let the plugin read it directly so an
  # UninstallString containing quotes is preserved verbatim.
  Push $9
  StrCpy $9 ${REGISTER}
  System::Call 'kernel32::SetEnvironmentVariable(t, t)i ("${NAME}", r9).r0'
  Pop $9
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
  StrCpy $KunInstallerPrimarySourceStale 0
  StrCpy $KunInstallerSecondarySourceStale 0
  StrCpy $KunInstallerCandidateExplicit 0
  StrCpy $KunInstallerPresentedTargetDir ""
  StrCpy $KunInstallerUpdateSourceDir ""
  StrCpy $KunInstallerPreserveOtherScope 0
  StrCpy $KunInstallerOtherUninstallString ""
  StrCpy $KunInstallerOtherQuietUninstallString ""
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

  !insertmacro GetDParameter $R0
  ${if} $R0 != ""
    StrCpy $KunInstallerCandidateExplicit 1
  ${endif}

  Call KunSetProductEnvironment
  Call KunSelectAutomaticUpdateMode
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
    System::Call 'kernel32::SetEnvironmentVariable(t, t)i ("KUN_INSTALLER_CANONICAL_LEAF", "${APP_FILENAME}").r0'
    System::Call 'kernel32::SetEnvironmentVariable(t, t)i ("KUN_INSTALLER_APP_EXECUTABLE", "${APP_EXECUTABLE_FILENAME}").r0'
    System::Call 'kernel32::SetEnvironmentVariable(t, t)i ("KUN_INSTALLER_PRODUCT_NAME", "${PRODUCT_NAME}").r0'
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
  ${if} $KunInstallerPrimarySourceStale != 1
    StrCpy $KunInstallerSourceDir $KunInstallerPrimarySourceDir
    Call KunHandleOldUninstallerResult
  ${else}
    ClearErrors
    StrCpy $R0 0
  ${endif}
  ${if} $installMode != "all"
    Call KunRestoreInteractiveInstaller
  ${elseIf} $KunInstallerPreserveOtherScope == 1
    Call KunSuspendCurrentUserUninstallRegistration
  ${endif}
!macroend

!macro customUnInstallCheckCurrentUser
  ${if} $KunInstallerPreserveOtherScope == 1
    Call KunRestoreCurrentUserUninstallRegistration
    ClearErrors
    StrCpy $R0 0
    StrCpy $KunInstallerSourceDir $KunInstallerPrimarySourceDir
    Call KunRestoreInteractiveInstaller
    Return
  ${endif}
  ${if} $KunInstallerSecondarySourceStale != 1
    StrCpy $KunInstallerSourceDir $KunInstallerSecondarySourceDir
    Call KunHandleOldUninstallerResult
  ${else}
    ClearErrors
    StrCpy $R0 0
  ${endif}
  # installSection invokes this callback only while an all-users install is
  # retiring an existing current-user registration. The old uninstaller usually
  # removes this shell state itself; fallback cleanup must finish the same scoped
  # transition after the validated application payload is gone.
  Call KunRetireCurrentUserShellState
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

  !insertmacro kunRunMigrationHelper ValidatePayload
  ${if} $KunInstallerHelperExitCode != 0
    MessageBox MB_OK|MB_ICONSTOP "Kun installation is incomplete. No PATH changes were made; run the installer again to repair it.$\r$\n$KunInstallerHelperOutput" /SD IDOK
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
  Function KunSetProductEnvironment
    System::Call 'kernel32::SetEnvironmentVariable(t, t)i ("KUN_INSTALLER_CANONICAL_LEAF", "${APP_FILENAME}").r0'
    System::Call 'kernel32::SetEnvironmentVariable(t, t)i ("KUN_INSTALLER_APP_EXECUTABLE", "${APP_EXECUTABLE_FILENAME}").r0'
    System::Call 'kernel32::SetEnvironmentVariable(t, t)i ("KUN_INSTALLER_PRODUCT_NAME", "${PRODUCT_NAME}").r0'
    System::Call 'kernel32::SetEnvironmentVariable(t, t)i ("KUN_INSTALLER_APP_GUID", "${APP_GUID}").r0'
  FunctionEnd

  Function KunSetMigrationEnvironment
    # $APPDATA follows SetShellVarContext, so per-machine recovery is shared
    # while current-user recovery stays in the selected user's profile.
    StrCpy $KunInstallerJournalPath "$APPDATA\KunInstallerRecovery\${APP_GUID}.json"

    System::Call 'kernel32::SetEnvironmentVariable(t, t)i ("KUN_INSTALLER_SOURCE", "$KunInstallerSourceDir").r0'
    System::Call 'kernel32::SetEnvironmentVariable(t, t)i ("KUN_INSTALLER_SECONDARY_SOURCE", "$KunInstallerSecondarySourceDir").r0'
    System::Call 'kernel32::SetEnvironmentVariable(t, t)i ("KUN_INSTALLER_TARGET", "$KunInstallerTargetDir").r0'
    System::Call 'kernel32::SetEnvironmentVariable(t, t)i ("KUN_INSTALLER_JOURNAL", "$KunInstallerJournalPath").r0'
    System::Call 'kernel32::SetEnvironmentVariable(t, t)i ("KUN_INSTALLER_SELF_PID", "$KunInstallerCurrentPid").r0'
    System::Call 'kernel32::SetEnvironmentVariable(t, t)i ("KUN_INSTALLER_PRIMARY_SOURCE_STALE", "$KunInstallerPrimarySourceStale").r0'
    System::Call 'kernel32::SetEnvironmentVariable(t, t)i ("KUN_INSTALLER_SECONDARY_SOURCE_STALE", "$KunInstallerSecondarySourceStale").r0'
    System::Call 'kernel32::SetEnvironmentVariable(t, t)i ("KUN_INSTALLER_CANDIDATE_EXPLICIT", "$KunInstallerCandidateExplicit").r0'
    System::Call 'kernel32::SetEnvironmentVariable(t, t)i ("KUN_INSTALLER_INSTALL_MODE", "$installMode").r0'
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
      StrCpy $KunInstallerHelperOutput "The installer helper did not produce a result file."
      Delete "$KunInstallerResultPath"
  FunctionEnd

  Function KunResolveRegisteredSource
    System::Call 'kernel32::SetEnvironmentVariable(t, t)i ("KUN_INSTALLER_SOURCE", "$KunInstallerSourceDir").r0'
    !insertmacro kunSetEnvironmentFromRegister "KUN_INSTALLER_UNINSTALL_STRING" $R9
    Delete "$KunInstallerResultPath"
    !insertmacro kunRunMigrationHelper ResolveSource
    ${if} $KunInstallerHelperExitCode == 0
      Call KunReadMigrationResult
    ${endif}
    ${if} $KunInstallerHelperExitCode != 0
    ${orIf} $KunInstallerHelperOutput == ""
      MessageBox MB_OK|MB_ICONSTOP "Kun found an existing installation registration but could not recover its program directory.$\r$\n$KunInstallerHelperOutput" /SD IDOK
      SetErrorLevel 2
      Quit
    ${endif}
    StrCpy $KunInstallerSourceDir $KunInstallerHelperOutput
  FunctionEnd

  Function KunSelectAutomaticUpdateMode
    ${ifNot} ${isUpdated}
      Return
    ${endif}
    ReadEnvStr $KunInstallerUpdateSourceDir "KUN_INSTALLER_UPDATE_SOURCE"
    ${if} $KunInstallerUpdateSourceDir == ""
      # Older Kun versions did not export the running application directory.
      # Select an unambiguous single registration explicitly because the
      # updater's --updated path may otherwise retain the default install mode.
      ReadRegStr $R0 HKEY_CURRENT_USER "${INSTALL_REGISTRY_KEY}" InstallLocation
      ReadRegStr $R1 HKEY_CURRENT_USER "${UNINSTALL_REGISTRY_KEY}" UninstallString
      ReadRegStr $R2 HKEY_LOCAL_MACHINE "${INSTALL_REGISTRY_KEY}" InstallLocation
      ReadRegStr $R3 HKEY_LOCAL_MACHINE "${UNINSTALL_REGISTRY_KEY}" UninstallString
      ${if} $R0 == ""
      ${andIf} $R1 == ""
        ${if} $R2 != ""
        ${orIf} $R3 != ""
          StrCpy $hasPerMachineInstallation 1
          StrCpy $hasPerUserInstallation 0
          !insertmacro setInstallModePerAllUsers
          DetailPrint "Automatic update selected the only registered all-users ${PRODUCT_NAME} installation."
        ${else}
          DetailPrint "Automatic update found no existing ${PRODUCT_NAME} registration; keeping the requested install mode."
        ${endif}
        Return
      ${endif}
      ${if} $R2 == ""
      ${andIf} $R3 == ""
        StrCpy $hasPerMachineInstallation 0
        StrCpy $hasPerUserInstallation 1
        !insertmacro setInstallModePerUser
        DetailPrint "Automatic update selected the only registered current-user ${PRODUCT_NAME} installation."
        Return
      ${endif}
      DetailPrint "Automatic update source marker is unavailable with registrations in both scopes; keeping the requested install mode."
      Return
    ${endif}

    ReadRegStr $R0 HKEY_CURRENT_USER "${INSTALL_REGISTRY_KEY}" InstallLocation
    ReadRegStr $R1 HKEY_CURRENT_USER "${UNINSTALL_REGISTRY_KEY}" UninstallString
    ReadRegStr $R2 HKEY_LOCAL_MACHINE "${INSTALL_REGISTRY_KEY}" InstallLocation
    ReadRegStr $R3 HKEY_LOCAL_MACHINE "${UNINSTALL_REGISTRY_KEY}" UninstallString
    System::Call 'kernel32::SetEnvironmentVariable(t, t)i ("KUN_INSTALLER_CURRENT_USER_SOURCE", "$R0").r0'
    !insertmacro kunSetEnvironmentFromRegister "KUN_INSTALLER_CURRENT_USER_UNINSTALL_STRING" $R1
    System::Call 'kernel32::SetEnvironmentVariable(t, t)i ("KUN_INSTALLER_ALL_USERS_SOURCE", "$R2").r0'
    !insertmacro kunSetEnvironmentFromRegister "KUN_INSTALLER_ALL_USERS_UNINSTALL_STRING" $R3
    Delete "$KunInstallerResultPath"
    !insertmacro kunRunMigrationHelper ResolveUpdateScope
    ${if} $KunInstallerHelperExitCode == 0
      Call KunReadMigrationResult
    ${endif}
    ${if} $KunInstallerHelperExitCode != 0
    ${orIf} $KunInstallerHelperOutput == ""
      MessageBox MB_OK|MB_ICONSTOP "${PRODUCT_NAME} could not match this automatic update to one installed application.$\r$\n$KunInstallerHelperOutput" /SD IDOK
      SetErrorLevel 2
      Quit
    ${endif}

    ${if} $KunInstallerHelperOutput == "current"
      StrCpy $hasPerMachineInstallation 0
      StrCpy $hasPerUserInstallation 1
      !insertmacro setInstallModePerUser
      DetailPrint "Automatic update selected the current-user ${PRODUCT_NAME} registration."
      Return
    ${endif}
    ${if} $KunInstallerHelperOutput == "all"
      StrCpy $KunInstallerPreserveOtherScope 1
      StrCpy $hasPerMachineInstallation 1
      StrCpy $hasPerUserInstallation 0
      !insertmacro setInstallModePerAllUsers
      DetailPrint "Automatic update selected the all-users ${PRODUCT_NAME} registration."
      Return
    ${endif}

    MessageBox MB_OK|MB_ICONSTOP "${PRODUCT_NAME} received an invalid automatic update scope: $KunInstallerHelperOutput" /SD IDOK
    SetErrorLevel 2
    Quit
  FunctionEnd

  Function KunRetireSelectedShellState
    ReadRegStr $KunInstallerCurrentUserShortcutName SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" ShortcutName
    ReadRegStr $KunInstallerCurrentUserMenuDirectory SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" MenuDirectory

    ${if} $KunInstallerCurrentUserShortcutName != ""
      Delete "$DESKTOP\$KunInstallerCurrentUserShortcutName.lnk"
      Delete "$SMPROGRAMS\$KunInstallerCurrentUserShortcutName.lnk"
      ${if} $KunInstallerCurrentUserMenuDirectory != ""
        Delete "$SMPROGRAMS\$KunInstallerCurrentUserMenuDirectory\$KunInstallerCurrentUserShortcutName.lnk"
      ${endif}
    ${endif}

    Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
    Delete "$SMPROGRAMS\${SHORTCUT_NAME}.lnk"
    Delete "$DESKTOP\DeepSeek GUI.lnk"
    Delete "$SMPROGRAMS\DeepSeek GUI.lnk"
    ${if} $KunInstallerCurrentUserMenuDirectory != ""
      Delete "$SMPROGRAMS\$KunInstallerCurrentUserMenuDirectory\${SHORTCUT_NAME}.lnk"
      Delete "$SMPROGRAMS\$KunInstallerCurrentUserMenuDirectory\DeepSeek GUI.lnk"
      RMDir "$SMPROGRAMS\$KunInstallerCurrentUserMenuDirectory"
    ${endif}

    DeleteRegKey SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}"
    DeleteRegKey SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}"
  FunctionEnd

  Function KunRetireCurrentUserShellState
    ReadRegStr $KunInstallerCurrentUserShortcutName HKEY_CURRENT_USER "${INSTALL_REGISTRY_KEY}" ShortcutName
    ReadRegStr $KunInstallerCurrentUserMenuDirectory HKEY_CURRENT_USER "${INSTALL_REGISTRY_KEY}" MenuDirectory
    SetShellVarContext current

    ${if} $KunInstallerCurrentUserShortcutName != ""
      Delete "$DESKTOP\$KunInstallerCurrentUserShortcutName.lnk"
      Delete "$SMPROGRAMS\$KunInstallerCurrentUserShortcutName.lnk"
      ${if} $KunInstallerCurrentUserMenuDirectory != ""
        Delete "$SMPROGRAMS\$KunInstallerCurrentUserMenuDirectory\$KunInstallerCurrentUserShortcutName.lnk"
      ${endif}
    ${endif}

    Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
    Delete "$SMPROGRAMS\${SHORTCUT_NAME}.lnk"
    Delete "$DESKTOP\DeepSeek GUI.lnk"
    Delete "$SMPROGRAMS\DeepSeek GUI.lnk"
    ${if} $KunInstallerCurrentUserMenuDirectory != ""
      Delete "$SMPROGRAMS\$KunInstallerCurrentUserMenuDirectory\${SHORTCUT_NAME}.lnk"
      Delete "$SMPROGRAMS\$KunInstallerCurrentUserMenuDirectory\DeepSeek GUI.lnk"
      RMDir "$SMPROGRAMS\$KunInstallerCurrentUserMenuDirectory"
    ${endif}

    DeleteRegKey HKEY_CURRENT_USER "${UNINSTALL_REGISTRY_KEY}"
    DeleteRegKey HKEY_CURRENT_USER "${INSTALL_REGISTRY_KEY}"
    SetShellVarContext all
  FunctionEnd

  Function KunReadRegisteredSource
    ReadRegStr $KunInstallerSourceDir SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
    ReadRegStr $R9 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" UninstallString
    ${if} $R9 == ""
    ${andIf} $installMode != "all"
      ReadRegStr $R9 HKEY_CURRENT_USER "${UNINSTALL_REGISTRY_KEY}" UninstallString
    ${endif}
    ${if} $KunInstallerSourceDir != ""
    ${orIf} $R9 != ""
      Call KunResolveRegisteredSource
    ${endif}
    StrCpy $KunInstallerPrimarySourceDir $KunInstallerSourceDir
    StrCpy $KunInstallerSecondarySourceDir ""
    ${if} $installMode == "all"
    ${andIf} $KunInstallerPreserveOtherScope != 1
      StrCpy $KunInstallerSourceDir ""
      ReadRegStr $KunInstallerSourceDir HKEY_CURRENT_USER "${INSTALL_REGISTRY_KEY}" InstallLocation
      ReadRegStr $R9 HKEY_CURRENT_USER "${UNINSTALL_REGISTRY_KEY}" UninstallString
      ${if} $KunInstallerSourceDir != ""
      ${orIf} $R9 != ""
        Call KunResolveRegisteredSource
      ${endif}
      StrCpy $KunInstallerSecondarySourceDir $KunInstallerSourceDir
    ${endif}
    StrCpy $KunInstallerSourceDir $KunInstallerPrimarySourceDir
  FunctionEnd

  Function KunResolveInstallTarget
    System::Call 'kernel32::SetEnvironmentVariable(t, t)i ("KUN_INSTALLER_SOURCE", "$KunInstallerSourceDir").r0'
    System::Call 'kernel32::SetEnvironmentVariable(t, t)i ("KUN_INSTALLER_CANDIDATE", "$INSTDIR").r0'
    System::Call 'kernel32::SetEnvironmentVariable(t, t)i ("KUN_INSTALLER_CANDIDATE_EXPLICIT", "$KunInstallerCandidateExplicit").r0'
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
    StrCpy $KunInstallerPresentedTargetDir $INSTDIR
  FunctionEnd

  Function KunInstallDirectoryPageLeave
    ${if} $INSTDIR != $KunInstallerPresentedTargetDir
      StrCpy $KunInstallerCandidateExplicit 1
    ${endif}
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
    Delete "$KunInstallerResultPath"
    !insertmacro kunRunMigrationHelper Prepare
    ${if} $KunInstallerHelperExitCode != 0
      MessageBox MB_OK|MB_ICONSTOP "Kun kept the existing installation unchanged because it could not migrate the program directory safely.$\r$\n$KunInstallerHelperOutput" /SD IDOK
      SetErrorLevel 2
      Quit
    ${endif}
    Call KunReadMigrationResult
    ${if} $KunInstallerHelperExitCode != 0
      MessageBox MB_OK|MB_ICONSTOP "Kun kept the existing installation unchanged because it could not classify the registered program directory safely.$\r$\n$KunInstallerHelperOutput" /SD IDOK
      SetErrorLevel 2
      Quit
    ${endif}

    ${if} $KunInstallerHelperOutput == "1"
    ${orIf} $KunInstallerHelperOutput == "3"
      StrCpy $KunInstallerPrimarySourceStale 1
      DetailPrint "Retiring stale selected-scope Kun registration without modifying $KunInstallerPrimarySourceDir."
      Call KunRetireSelectedShellState
    ${else}
      StrCpy $KunInstallerSourceDir $KunInstallerPrimarySourceDir
      Call KunSecureSelectedUninstallRegistration
    ${endif}
    ${if} $KunInstallerHelperOutput == "2"
    ${orIf} $KunInstallerHelperOutput == "3"
      StrCpy $KunInstallerSecondarySourceStale 1
      DetailPrint "Retiring stale current-user Kun registration without modifying $KunInstallerSecondarySourceDir."
      Call KunRetireCurrentUserShellState
    ${elseIf} $KunInstallerSecondarySourceDir != ""
      StrCpy $KunInstallerSourceDir $KunInstallerSecondarySourceDir
      Call KunSecureCurrentUserUninstallRegistration
    ${endif}
    StrCpy $KunInstallerSourceDir $KunInstallerPrimarySourceDir
    StrCpy $KunInstallerMigrationPrepared 1
  FunctionEnd

  Function KunSuspendCurrentUserUninstallRegistration
    ReadRegStr $KunInstallerOtherUninstallString HKEY_CURRENT_USER "${UNINSTALL_REGISTRY_KEY}" UninstallString
    ReadRegStr $KunInstallerOtherQuietUninstallString HKEY_CURRENT_USER "${UNINSTALL_REGISTRY_KEY}" QuietUninstallString
    DeleteRegValue HKEY_CURRENT_USER "${UNINSTALL_REGISTRY_KEY}" UninstallString
    DeleteRegValue HKEY_CURRENT_USER "${UNINSTALL_REGISTRY_KEY}" QuietUninstallString
    DetailPrint "Preserving the unrelated current-user ${PRODUCT_NAME} registration during an all-users automatic update."
  FunctionEnd

  Function KunRestoreCurrentUserUninstallRegistration
    ${if} $KunInstallerOtherUninstallString != ""
      WriteRegStr HKEY_CURRENT_USER "${UNINSTALL_REGISTRY_KEY}" UninstallString "$KunInstallerOtherUninstallString"
    ${endif}
    ${if} $KunInstallerOtherQuietUninstallString != ""
      WriteRegStr HKEY_CURRENT_USER "${UNINSTALL_REGISTRY_KEY}" QuietUninstallString "$KunInstallerOtherQuietUninstallString"
    ${endif}
  FunctionEnd

  Function KunResolveTrustedUninstaller
    System::Call 'kernel32::SetEnvironmentVariable(t, t)i ("KUN_INSTALLER_SOURCE", "$KunInstallerSourceDir").r0'
    Delete "$KunInstallerResultPath"
    !insertmacro kunRunMigrationHelper ResolveUninstaller
    ${if} $KunInstallerHelperExitCode == 0
      Call KunReadMigrationResult
    ${endif}
    ${if} $KunInstallerHelperExitCode != 0
      MessageBox MB_OK|MB_ICONSTOP "${PRODUCT_NAME} could not validate the old application uninstaller.$\r$\n$KunInstallerHelperOutput" /SD IDOK
      SetErrorLevel 2
      Quit
    ${endif}
  FunctionEnd

  Function KunSecureSelectedUninstallRegistration
    Call KunResolveTrustedUninstaller
    ${if} $KunInstallerHelperOutput == ""
      DeleteRegValue SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" UninstallString
      DeleteRegValue SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" QuietUninstallString
      DetailPrint "The old ${PRODUCT_NAME} uninstaller is unavailable; conservative cleanup will be used."
      Return
    ${endif}
    ${if} $installMode == "all"
      StrCpy $R8 "/allusers"
    ${else}
      StrCpy $R8 "/currentuser"
    ${endif}
    WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" UninstallString '"$KunInstallerHelperOutput" $R8'
    WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" QuietUninstallString '"$KunInstallerHelperOutput" $R8 /S'
  FunctionEnd

  Function KunSecureCurrentUserUninstallRegistration
    Call KunResolveTrustedUninstaller
    ${if} $KunInstallerHelperOutput == ""
      DeleteRegValue HKEY_CURRENT_USER "${UNINSTALL_REGISTRY_KEY}" UninstallString
      DeleteRegValue HKEY_CURRENT_USER "${UNINSTALL_REGISTRY_KEY}" QuietUninstallString
      DetailPrint "The old current-user ${PRODUCT_NAME} uninstaller is unavailable; conservative cleanup will be used."
      Return
    ${endif}
    WriteRegStr HKEY_CURRENT_USER "${UNINSTALL_REGISTRY_KEY}" UninstallString '"$KunInstallerHelperOutput" /currentuser'
    WriteRegStr HKEY_CURRENT_USER "${UNINSTALL_REGISTRY_KEY}" QuietUninstallString '"$KunInstallerHelperOutput" /currentuser /S'
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
