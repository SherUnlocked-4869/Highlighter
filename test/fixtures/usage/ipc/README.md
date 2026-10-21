# Usage page IPC contract fixtures

These JSON files are the **frozen request/response shapes** for the Highlighter
"Usage" page (`usage:*` IPC channels), copied from the development plan
(`docs/plans/2026-10-21-tokentracker-usage-page-development-plan.md`, §2.7 and
附录 B). They are used by:

- page development before the data engine exists (`config/routes/usage.js`),
- IPC contract tests (`test/usage-ipc.test.js`),
- e2e assertions (fixture-home variant lives in `test/fixtures/usage/home/`).

Numbers are synthetic but internally consistent: `summary.totals` equals
`breakdown.totals`; `daily.rows` sums to `summary.totals`; `hourly.rows` is a
24-hour slice of the last day. All token values are integers; `total_cost_usd`
is `null` because the confirmed scope excludes money.

| File | Channel |
|---|---|
| `status.json` | `usage:status` |
| `summary.json` | `usage:summary` |
| `daily.json` | `usage:daily` |
| `hourly.json` | `usage:hourly` |
| `breakdown.json` | `usage:breakdown` |
| `heatmap.json` | `usage:heatmap` |

Do not edit these fixtures to make a test pass; change the contract (plan §2.7)
and the produced payloads together. `status.json` deliberately contains one
`ok`, one `empty`, one `absent`/`unsupported` source so every coverage state has
a mock.
