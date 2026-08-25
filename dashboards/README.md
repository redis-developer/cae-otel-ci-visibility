# Grafana dashboards (schema v16)

Grafana schema-V2 dashboard JSONs for the `cae_v16_*` metrics this action emits
(see the repo README's Dashboard Integration section for the metric contract).

| File                    | Title                         | Live uid               | Job                                                      |
| ----------------------- | ----------------------------- | ---------------------- | -------------------------------------------------------- |
| `v16-regressions.json`  | Test Regressions (v16)        | `botthhp`              | Alarm triage: what's flagged right now, fleet-wide       |
| `v16-repo-health.json`  | Repo Health (v16)             | `bos8jzw`              | Developer view: one repo's slowest/movers, bird's-eye    |
| `v16-trends.json`       | Test Trends & Timelines (v16) | `bocj686`              | Fleet view: offenders, per-track trends, catalog stats   |
| `v16-test-details.json` | Test Details (v16)            | `cae-test-details-v16` | Debug view: timeline + health context for selected tests |

Test-name clicks on the other three boards deep-link into Test Details with
`var-test_id` preset; its uid is therefore hardcoded in all three JSONs. The uid
was chosen in `metadata.name` before first import — if Grafana ever mints a
different uid instead of honoring it, repoint the links and this table.

## Import rules (hard-won — do not deviate)

- **Files are full v2 resources, paste-ready.** Each JSON is wrapped in the
  Kubernetes-style envelope (`apiVersion: dashboard.grafana.app/v2`,
  `kind: Dashboard`, `metadata.name` = live uid, `spec` = the dashboard) that
  Grafana's paste-JSON import requires — a bare spec fails with "Missing
  property metadata/spec", and `v2beta1`/`v2alpha1` apiVersions are rejected.
  Query edits go under `spec`; the uid lives only in `metadata.name`.
- **Always import with overwrite, never delete+import.** Grafana assigns uids on
  import and ignores the JSON's; deleting a board mints a new uid and breaks
  every cross-link. The live uids above are hardcoded into the cross-board links
  in all three JSONs — importing into a different Grafana org requires
  repointing those uids.
- Dashboards are edited **programmatically** (Python `json.load` → transform →
  `json.dump`), never hand-edited and never authored in the Grafana UI. Every
  edit ends with `npx prettier --write <file>` and a `JSON.parse` round-trip
  check.
- New or changed queries get smoke-tested at real scale via the Prometheus API
  (row count + latency) before re-import.

## Wording conventions

All user-facing text (titles, descriptions, column names, variable labels)
follows `GLOSSARY.md` in this directory: one term per concept, one voice on
every board, ASD-STE100 style (active voice, short sentences, no idioms, no
Latin), and the three-part description template (what it shows / what healthy
looks like / what to do when it is not). Do not add or edit user-facing text
without checking it against the glossary.
