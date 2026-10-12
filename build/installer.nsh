; Highlighter — custom "is the application still running?" check (2026-10-12).
;
; WHY THIS FILE EXISTS
; electron-builder's default check (app-builder-lib/templates/nsis/include/
; allowOnlyOneInstallerInstance.nsh) decides "the app is running" with a PATH PREFIX
; test (`$_.Path.StartsWith('$INSTDIR')`) and then treats "I could not terminate it" as
; "ask the user to close it manually" (`appCannotBeClosed`, the Retry/Cancel dialog).
; Measured on 2026-10-12 with that very predicate:
;     INSTDIR=''                        -> "found" (StartsWith('') is true for all)
;     INSTDIR='D:'                      -> "found"
;     INSTDIR='D:\Program Files\Highlighter' -> "not found"
; so a blank or too-broad install dir makes the dialog permanent, and any process that
; merely LIVES under the install dir (the uninstaller that ships there, an orphaned OCR
; sidecar or selection-hook host) keeps it satisfied even when the app itself is dead.
; The app is tray-resident by default (`system.autoStart`/`enableTray` default true and
; `window-all-closed` is a no-op), and the default dialog names neither a path nor a
; PID, so the user has nothing to act on.
;
; WHAT THIS MACRO DOES INSTEAD
; electron-builder inserts `customCheckAppRunning` when it is defined (see
; CHECK_APP_RUNNING in the template above):
;   1. a blank $INSTDIR is never treated as "running";
;   2. the app is matched by EXACT path `$INSTDIR\Highlighter.exe` (case-insensitive),
;      never by prefix — the installer, the uninstaller and unrelated processes can
;      never match;
;   3. the helper is generated as a .ps1 file and run with `-File`, so no NSIS/PowerShell
;      command-line quoting can go wrong, and it runs under a hard nsExec timeout, so a
;      wedged helper can never wedge the installer;
;   4. graceful close first, then a forced kill, then a re-check;
;   5. a process that really survives is reported with its exact path and PIDs, and a
;      SILENT install is never blocked by a dialog.

!include "LogicLib.nsh"

!macro customCheckAppRunning
  ; --- 1. guard: a blank install dir must never mean "everything is running" ---
  StrCmp $INSTDIR "" ccar_done

  ; --- 2. exact application path (strip a trailing backslash first) -----------
  StrCpy $R0 "$INSTDIR"
  ccar_trim:
    StrCpy $R1 "$R0" 1 -1
    StrCmp $R1 "\" 0 ccar_trimmed
    StrCpy $R0 "$R0" -1
    Goto ccar_trim
  ccar_trimmed:
  StrCmp $R0 "" ccar_done
  StrCpy $R0 "$R0\${APP_EXECUTABLE_FILENAME}"

  ; --- 3. generate the helper once (no shell quoting anywhere) ----------------
  ClearErrors
  FileOpen $R5 "$PLUGINSDIR\ccar.ps1" w
  FileWrite $R5 "param([string]$$Target, [string]$$OutFile)$\r$\n"
  FileWrite $R5 "$$o = 'none'$\r$\n"
  FileWrite $R5 "try {$\r$\n"
  FileWrite $R5 "  $$q = @(Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -and ($$_.ExecutablePath -ieq $$Target) })$\r$\n"
  FileWrite $R5 "  if ($$q.Count -gt 0) {$\r$\n"
  FileWrite $R5 "    $$q | ForEach-Object { try { (Get-Process -Id $$_.ProcessId).CloseMainWindow() | Out-Null } catch {} }$\r$\n"
  FileWrite $R5 "    Start-Sleep -Milliseconds 1500$\r$\n"
  FileWrite $R5 "    $$r = @(Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -and ($$_.ExecutablePath -ieq $$Target) })$\r$\n"
  FileWrite $R5 "    if ($$r.Count -gt 0) {$\r$\n"
  FileWrite $R5 "      $$r | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }$\r$\n"
  FileWrite $R5 "      Start-Sleep -Milliseconds 800$\r$\n"
  FileWrite $R5 "      $$s = @(Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -and ($$_.ExecutablePath -ieq $$Target) })$\r$\n"
  FileWrite $R5 "      if ($$s.Count -gt 0) { $$o = 'alive:' + ((($$s | ForEach-Object { $$_.ProcessId }) -join ',')) } else { $$o = 'closed' }$\r$\n"
  FileWrite $R5 "    } else { $$o = 'closed' }$\r$\n"
  FileWrite $R5 "  }$\r$\n"
  FileWrite $R5 "} catch { $$o = 'error' }$\r$\n"
  FileWrite $R5 "[void][IO.File]::WriteAllText($$OutFile, $$o)$\r$\n"
  FileClose $R5
  IfErrors ccar_fallback

  StrCpy $R4 0 ; attempt counter

  ccar_check:
  DetailPrint "Checking for a running ${PRODUCT_NAME} at $R0"
  Delete "$PLUGINSDIR\ccar.out"
  nsExec::ExecToStack /TIMEOUT=20000 '"$PowerShellPath" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\ccar.ps1" "$R0" "$PLUGINSDIR\ccar.out"'
  Pop $9 ; helper exit code (unused)
  Pop $8 ; helper stdout (unused)

  ; Read the helper's answer from the file it wrote (10s of slack after the timeout).
  StrCpy $R6 0
  ccar_wait:
    Sleep 500
    ClearErrors
    IfFileExists "$PLUGINSDIR\ccar.out" ccar_read
    IntOp $R6 $R6 + 1
    IntCmp $R6 20 ccar_fallback
    Goto ccar_wait

  ccar_read:
  ClearErrors
  FileOpen $R5 "$PLUGINSDIR\ccar.out" r
  FileRead $R5 $R7
  FileClose $R5
  IfErrors ccar_fallback

  StrCpy $R2 "$R7" 4 ; short prefix, so trailing whitespace can never matter
  StrCmp $R2 "none" ccar_done
  StrCmp $R2 "clos" ccar_done
  StrCmp $R2 "aliv" ccar_alive
  Goto ccar_fallback

  ccar_alive:
  StrCpy $R1 "$R7" "" 6 ; drop the "alive:" prefix
  DetailPrint "Cannot stop ${PRODUCT_NAME}: $R0 (PIDs $R1)"
  IntOp $R4 $R4 + 1
  IntCmp $R4 4 ccar_giveup
  ; Never block a silent install on a dialog (there is nobody to click it); log it and
  ; let the file copy report a locked executable if that is what happens.
  ${If} ${Silent}
    DetailPrint "Silent install: continuing even though $R0 is still running"
    Goto ccar_done
  ${EndIf}
  MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(^Name)：无法自动结束正在运行的 ${PRODUCT_NAME}。$\r$\n$\r$\n程序：$R0$\r$\n进程 PID：$R1$\r$\n$\r$\n请手动结束上面这些进程（任务管理器，或右键托盘图标 → 退出），然后点“重试”。$\r$\n$\r$\n${PRODUCT_NAME} is still running (path and PIDs above). Close it manually, then click Retry." /SD IDCANCEL IDRETRY ccar_check
  Quit

  ccar_giveup:
  DetailPrint "Gave up on $R0 after $R4 attempts; a locked file may be reported by the copy step."
  Goto ccar_done

  ; No usable answer (no PowerShell, blocked by policy/HIPS, helper wedged). Best
  ; effort by image name, then continue: the file copy reports a hard error if the
  ; executable really is locked.
  ccar_fallback:
  DetailPrint "PowerShell check unavailable; falling back to an image-name kill"
  nsExec::Exec /TIMEOUT=10000 '"$CmdPath" /C taskkill /F /IM "${APP_EXECUTABLE_FILENAME}" /FI "USERNAME eq %USERNAME%" >NUL 2>&1'
  Pop $9
  Sleep 600

  ccar_done:
!macroend
