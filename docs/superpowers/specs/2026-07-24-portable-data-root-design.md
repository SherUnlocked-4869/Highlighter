# Portable Data Root Design

## Goal

Make the Windows portable build keep all Highlighter-managed configuration, logs,
history, caches, and Electron runtime data in a user-selected data root. The
portable build must not silently fall back to `%APPDATA%`.

The feature also lets the user change the data root from the existing System
Settings page. Existing managed data is migrated automatically and the app
restarts only after the migration has been validated.

## Scope

This design applies to the electron-builder Windows `portable` target. The
portable wrapper exposes its original location through
`PORTABLE_EXECUTABLE_DIR`; the locator file is stored beside that wrapper.

Development runs keep their current Electron default paths unless a dedicated
test/development override is supplied. Installer behavior is outside this
feature. Screenshot and video output directories remain independent user
settings and are not forced under the data root.

## Chosen Approach

Use a sidecar locator file named `Highlighter.location.json` beside the
portable executable. It contains only a schema version and the absolute data
root path. This is preferred over the registry or `%APPDATA%` because it keeps
the portable build self-contained, and over prompting on every launch because
it preserves normal startup behavior.

The locator is written through a temporary file followed by an atomic rename.
If the executable directory is not writable, the app displays the failing path
and operating-system error, then exits. It never uses `%APPDATA%` as a fallback.

Example locator:

```json
{
  "version": 1,
  "dataRoot": "D:\\HighlighterData"
}
```

## Data Layout

The selected root owns these directories:

```text
<data-root>/
  config/       electron-store configuration and capture-history index
  logs/         application log files
  history/      automatically retained screenshot history
  cache/
    electron/   Chromium and Electron session caches
    ocr/        OCR temporary images
    recordings/ recording session files
    long-capture/ long-capture temporary images
  runtime/      persistent Electron runtime state that is not app settings
```

The path manager exposes named paths rather than allowing call sites to join
arbitrary subdirectories. `electron-store` uses `config/`, application logging
uses `logs/`, and all existing temporary services receive their named cache
path through constructor options.

Electron's `userData` path is set to `runtime/` and `sessionData` is set to
`cache/electron/` before any BrowserWindow, session, or store is created. This
prevents Chromium data from leaking back to its defaults.

## Startup Flow

1. Capture the legacy Electron `userData` path, then resolve the portable
   wrapper directory and locator path.
2. If the locator exists, parse and validate its schema and absolute data root.
   Set `userData` and `sessionData` to managed paths before Electron readiness.
3. If no locator exists, set provisional `userData` and `sessionData` paths to
   a unique directory under the operating-system temporary directory before
   Electron readiness. The bootstrap process never initializes the store,
   services, tray, shortcuts, or main window.
4. After Electron is ready, show a native directory picker. Cancelling the
   picker removes the provisional directory and exits the application.
5. Validate that the selected directory can be created, read, written, and
   renamed within. Create the managed directory layout.
6. If legacy Highlighter data exists at the captured legacy path, migrate it
   before activating the new root.
7. Atomically write the locator, remove the provisional directory, relaunch,
   and exit the bootstrap process.
8. The relaunched process reads the locator and configures Electron paths before
   readiness, then initializes `electron-store`, services, tray, shortcuts, and
   windows.

An invalid or unavailable configured root produces a recovery dialog with
`Retry`, `Choose Another Directory`, and `Exit`. Recovery never selects a path
without user confirmation.

## Settings Experience

System Settings gains a Data Root row in the Software Data section:

- a read-only field showing the active absolute path;
- an icon/text command to choose a new directory;
- an Open command to reveal the active root.

Choosing a different directory displays a confirmation that configuration,
logs, and screenshot history will be migrated and Highlighter will restart.
Choosing the current directory is a no-op. The existing screenshot-history
and output-directory controls remain available.

The renderer receives only the active root and migration result through narrow
IPC methods. All path validation, copying, locator updates, cleanup, and restart
control remain in the main process.

## Migration Transaction

The destination must be writable and must not be equal to, contain, or be
contained by the source managed root. A new migration is accepted only when
the destination does not contain conflicting Highlighter-managed directories.

The transaction follows these steps:

1. Flush the current store and stop services that can write managed files.
2. Create a uniquely named staging directory inside the selected destination.
3. Copy configuration, API keys, logs, history images, and the history index to
   staging. Transient caches are not copied.
4. Validate configuration JSON, expected file counts, and all copied history
   references.
5. Move staged managed directories into their final locations.
6. Atomically write `Highlighter.location.pending.json` with the previous root,
   new root, and migration identifier.
7. Atomically replace `Highlighter.location.json` with the new root.
8. Relaunch Highlighter and exit the old process.
9. After the new process successfully opens the store and verifies the active
   root, remove only known Highlighter-managed files at the old location and
   delete the pending record.

The app never recursively removes a broad `%APPDATA%` directory. Legacy cleanup
is restricted to the previous config file, log file, capture-history directory,
and known Highlighter cache/runtime directories.

If any step before locator replacement fails, staging and any pending record
are removed and the old root remains active. On startup, the presence of a
pending record means the new root still requires verification. If opening the
new store or validating its migration identifier fails, the process atomically
restores the previous locator from that record and relaunches once against the
old root. The source is not deleted until the new process has verified the new
root.

## Legacy Upgrade

An existing user upgrading from the current portable build has no locator but
may have settings and history under Electron's legacy `%APPDATA%` user-data
path. After the user chooses a root on first upgraded launch, the normal
migration transaction imports those managed files. A new user simply receives
the default settings in the chosen root.

## Error Handling

- Cancel on first launch: exit without creating app data.
- Locator directory not writable: show the exact path and error, then exit.
- Data root unavailable: offer Retry, Choose Another Directory, or Exit.
- Malformed locator: report it and allow choosing another directory; preserve
  the malformed file until a valid replacement is committed.
- Destination conflict: refuse migration and ask for an empty/new directory.
- Copy or validation failure: remove staging, resume stopped services, and keep
  the old root and locator.
- Restart verification failure: restore the old locator and retain both copies
  for diagnosis; never delete the source.

## Security

Renderer code cannot provide arbitrary copy or delete sources. IPC accepts only
a selected destination and the main process derives every managed source path.
All paths are resolved before containment checks. Symbolic links and junctions
inside migration sources or destinations are rejected so validation cannot be
bypassed into unrelated directories.

The API key remains in the electron-store configuration under `config/`; this
feature changes its location but does not add encryption or credential-manager
integration.

## Testing

Automated tests cover:

- portable locator resolution and atomic writes;
- first-launch selection and cancel-to-exit behavior;
- directory layout and Electron path mapping;
- writable-path, containment, conflict, symlink, and junction rejection;
- legacy `%APPDATA%` discovery;
- successful configuration/log/history migration;
- cache recreation without cache migration;
- copy and validation failures leaving the source and locator unchanged;
- relaunch verification and rollback markers;
- IPC and System Settings UI contracts.

Manual packaged verification uses an isolated temporary directory and a fresh
portable build:

1. first launch prompts before the main window;
2. cancelling exits without creating Highlighter data in `%APPDATA%`;
3. choosing a root creates the documented layout;
4. second launch reuses the locator without prompting;
5. changing the root migrates managed data and restarts;
6. screenshots, OCR, history, and recording use the new paths;
7. making the selected root unavailable shows recovery choices and does not
   fall back to `%APPDATA%`.

## Acceptance Criteria

- A fresh portable run requires an explicit data-root choice.
- Cancelling or encountering an unwritable executable directory exits cleanly.
- No Highlighter-managed configuration, history, logs, cache, or Electron
  runtime data is created in `%APPDATA%` during verified portable workflows.
- The active root can be viewed, opened, and changed from System Settings.
- A successful change preserves configuration and screenshot history, recreates
  transient caches, restarts the app, and cleans only known old managed files.
- A failed migration or restart verification preserves the previous working
  root and does not delete source data.
