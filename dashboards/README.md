# Grafana dashboards (schema v16)

Grafana schema-V2 dashboard JSONs for the `cae_v16_*` metrics this action emits
(see the repo README's Dashboard Integration section for the metric contract).

| File                   | Title                              | Live uid  | Job                                                    |
| ---------------------- | ---------------------------------- | --------- | ------------------------------------------------------ |
| `v16-regressions.json` | Test Regressions (v16)             | `botthhp` | Alarm triage: what's flagged right now, fleet-wide     |
| `v16-repo-health.json` | Repo Health - Test Drilldown (v16) | `bos8jzw` | Developer view: one repo's slowest/movers + timeline   |
| `v16-trends.json`      | Test Trends & Timelines (v16)      | `bocj686` | Fleet view: offenders, per-track trends, catalog stats |

## Import rules (hard-won — do not deviate)

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
