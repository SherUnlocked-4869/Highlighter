# Host contracts (R0 draft)

Machine-readable evidence for the R0-02 task of the Rust migration plan
(`docs/plans/2026-11-10-rust-migration-development-plan.md` §7 R0-02). The format
itself is frozen by [`docs/plans/rust-migration/contract-format.md`](../../docs/plans/rust-migration/contract-format.md).

This directory is a **draft baseline snapshot**, not a production protocol. It
describes what the current Electron/JavaScript host exposes so the Rust side can be
compared against one shared truth. It does not change `main/`, `preload*.js` or
`shared/`; differences found during extraction are recorded in
[`docs/plans/rust-migration/host-contract-inventory.md`](../../docs/plans/rust-migration/host-contract-inventory.md).

## Files and commands

| Path | Content | Verify |
|---|---|---|
| `contracts/host/host-contracts.json` | roles / methods / surface / errorCodes / resourceLimits / sharedSchemas | `node scripts/rust/extract-host-contracts.js --check` |
| `test/fixtures/host-parity/manifest.json` | fixture index, one sha256 per case | `node scripts/rust/generate-host-fixtures.js --check` |
| `test/fixtures/host-parity/<group>/<case>.json` | synthetic cross-language fixtures | same as above |
| `test/host-contracts.test.js` | completeness / permission / limit / hash / replay gate | `node --test test/host-contracts.test.js` |

Regenerate with `--write`, verify with `--check`. `--check` never writes and exits
nonzero on the first stale artifact (with a diff summary and both sha256 values).

Both generators are deterministic by construction:

- UTF-8, LF line endings, two-space indentation, insertion-order keys, arrays sorted
  by a stable key, exactly one trailing newline;
- no timestamps, random ids, absolute paths, host names or `process.versions`;
- running from the repository root only: no network, no Electron, no GUI, no user
  data. `vm` executes the real preload bodies with a stub `electron` module.

## `host-contracts.json`

Top-level fields (see contract-format §3): `schemaVersion`, `kind`, `status`,
`baseline`, `roles`, `errorCodes`, `resourceLimits`, `sharedSchemas`, `knownGaps`.

- `baseline.gitCommit` is the source baseline **declared by the R0 plan** (§1), not
  the working-tree HEAD, so `--check` stays green after a commit. The extractor
  prints the actual HEAD on stderr as a hint when it differs. `baseline.node` is the
  R0 baseline host recorded by the format draft; it is not read from the machine.
- `roles` (13, sorted by role) each carry `page`, `preload`, `globalObject`,
  `methods[]` (`name`/`kind`/`channel`/`call`/`returns`/`source`/`tests`),
  `surface` (`handles`/`listeners`/`receives`) and `knownGaps`.
  - `kind` is what the executed preload actually does: `invoke` → `Promise<unknown>`,
    `send` → `void`, `subscribe` → `unsubscribe function` when the method returns one,
    else `void`.
  - `surface.handles`/`listeners` are `IPC_SURFACES` sorted alphabetically;
    `surface.receives` lists every channel the preload subscribes to via
    `ipcRenderer.on` (main → renderer pushes; not required to appear in
    `IPC_SURFACES`).
  - `methods[].tests` is evidence only: the existing `test/*.test.js` files whose text
    contains that channel as a quoted string literal. It is not a coverage claim.
  - `knownGaps` records anything the extractor could not resolve or that disagrees
    with `IPC_SURFACES` (method, channel, source location, reason). A method that is
    exposed but produces no observable IPC channel appears **only** in
    `knownGaps`, never silently disappears.
- `errorCodes` is extracted from the `deny(...)` branches of
  `main/services/ipc-security.js` (`direction: "deny"`) and the `reportBlocked(...)`
  reasons of `main/services/window-security.js` (`direction: "block"`), with a
  `file:line` source.
- `resourceLimits` covers all eight inherited limits of plan §9.1. Values are read
  from the owning module (`extraction: "module"`); if a module cannot be loaded
  without Electron the extractor falls back to the source constant and records
  `extraction: "static"` plus the owning `symbols`.
- `sharedSchemas` covers the six objects of plan §5.1. SQLite-backed stores carry
  `userVersion` and, for the clipboard DB, the `schemaPath`; `settings-normalize`
  has `version: null` (that module has no schema version) and names its
  `normalizeSymbol`.
- `knownGaps` (top level) records cross-role findings such as auxiliary windows that
  expose a preload but are not registered in `IPC_SURFACES`.

## Fixtures

`manifest.json` groups cases by format. Every case file is:

```json
{
  "schemaVersion": 1,
  "caseId": "<group>/<id>",
  "format": "<group format>",
  "source": ["<module that produced it>"],
  "expect": "valid" | "invalid"
}
```

Invalid cases always carry a machine-readable `reason`. Case files sort their `id`
inside the manifest; files are byte-identical to what the generator writes.

| Group | Case payload |
|---|---|
| `capture-document` (`capture-document.v3`) | `document` (the produced v3 document), `invariants` (`schemaVersion`, `documentId`, `revision`, `revisionId`, `sourceWidth/Height`, `outputWidth/Height`, `contentFingerprint`, plus `migratedFrom`/`outputStyle` where relevant). Upgrade cases add `input` (the older payload) so both sides of the migration are present; invalid cases have `input`, `reason`, `errors[]` and no `document`. |
| `recording-project` (`recording-project.v1`) | `project` (a v1 manifest; for valid cases it is already the canonical `normalizeProject` output) and `invariants` (`schemaVersion`, `projectId`, `keepRanges` as `[startMs, endMs)` pairs). Invalid cases carry `project`, `reason`, `errors[]`. |
| `clipboard-protocol` (`clipboard-protocol.v1`) | `kind`, `chunks` (base64 raw bytes in feed order), `expectedFrames` (`header` + `payloadBase64`) for valid cases, `expectedError`; invalid cases also carry `failAt` (`feed` or `finish`) and `reason`. |
| `recording-export-options` (`recording-export-options.v1`) | `kind: "limits"` with `expectedLimits`, or `kind: "normalize"` with `request` + `metadata` + `expected` (full `normalizeExportRequest` value); invalid cases carry `reason`. |
| `settings` (`settings.normalize.v1`) | `kind: "normalize"`, `input` + `expected` (full normalized settings object). Synthetic data root only. |

`capture-document` includes both a plain v3 document and a `card-light` document so
the §5.1 outputStyle geometry rule (result size ≠ crop once padding/shadow is on) is
covered by fixtures, not just prose.

## Rust consumption

- Parse with `serde_json` only; do not require Node at test time and do not copy
  fixture contents into Rust source as a second truth.
- Use `clipboard-protocol` for decoder parity (valid frames must match field by
  field; invalid frames must map to the same error), `capture-document` for
  serialize/normalize/fingerprint parity, `recording-project`/`recording-export-options`
  for editor semantics and budget parity.
- Values that exist only to make a case readable (`invariants.revision`, extra
  `notes`-style fields) are documented here; ignore unknown fields.
- When a fixture group is missing in a future revision, skip it explicitly with a
  recorded reason instead of faking a pass.

## Limits of this draft

This snapshot records the external surface only. It deliberately excludes the new
internal contracts of plan §4.2 (`WindowHost`, `CaptureBackend`, ...), TypeScript
type generation and production protocol freezing. See
[`host-contract-inventory.md`](../../docs/plans/rust-migration/host-contract-inventory.md)
for the differences found against the plan and for the complete knownGaps list.
