# Dashboard glossary and text style

The canonical terms and the writing rules for ALL user-facing dashboard text:
board descriptions, panel descriptions (the info icons), titles, column names
and variable labels. Every edit to that text must use these terms and follow
these rules.

## Terms

Use exactly these terms. Do not use synonyms.

| Term                    | Meaning                                                                  |
| ----------------------- | ------------------------------------------------------------------------ |
| run                     | One CI execution that uploads test results                               |
| test name               | The identity of a test; the same name always means the same test         |
| server version          | The Redis server version the tests ran against                           |
| combination             | One test name + one server version; tracked and billed as one unit       |
| typical duration        | The median duration over a window of runs                                |
| recent window           | The last few days (`$recent`); what counts as "now"                      |
| baseline window         | The weeks before the recent window (`$baseline`); what counts as "usual" |
| typical (recent)        | The typical duration over the recent window                              |
| typical (baseline)      | The typical duration over the baseline window                            |
| change (s) / change (%) | Typical (recent) minus typical (baseline), absolute / relative           |
| slowdown threshold      | The ratio a test must exceed to count as regressed (`$ratio`)            |
| regression rule         | All three: over the threshold, more than 1 second slower, 10+ runs       |
| regressed               | Matches the regression rule                                              |
| verdict                 | The regression rule's answer for one test                                |
| runs counted            | The number of runs in the baseline window                                |
| reports                 | A repository "reports" when a run uploads its test results               |
| unstable test name      | A test name that changes from run to run                                 |
| metric series           | One metric + one combination of label values; the billed unit            |
| active series           | A metric series with data in the last 20 minutes; billed                 |

"Metric series" and "active series" are allowed only in the billing and
name-stability panels, where they are the measured unit.

## Say / do not say

| Say                                         | Not                                |
| ------------------------------------------- | ---------------------------------- |
| test names                                  | ids, series, cardinality           |
| combination of test name and server version | series, permutation, catalog entry |
| unstable test names                         | churn, nondeterministic            |
| became slower in small steps                | drift, drifters, creep             |
| tests that changed the most                 | movers                             |
| typical (recent) / typical (baseline)       | recent median / baseline median    |
| change (s) / change (%)                     | abs change / rel change            |
| times slower                                | ratio, x median                    |
| runs counted                                | samples                            |
| verdict                                     | is regression, gate                |
| total test time                             | suite duration                     |
| compared with 3 weeks ago                   | offset                             |

## Writing rules (ASD-STE100 applied)

- Active voice, present tense. Short sentences: aim below 20 words, one idea per
  sentence.
- No idioms and no figurative language ("bird's-eye", "creepers", "collateral
  damage", "minting", "on fire").
- No Latin ("de facto", "via", "e.g." — write "for example").
- One term per concept, from the table above. Do not invent new terms in a panel
  description.
- No implementation detail in user-facing text: no PromQL, no query cost, no
  row-cap rationale, no storage internals. That content lives in the runbook and
  the plan docs.

## Panel description template

Every panel description answers, in this order:

1. **What the panel shows.** One or two sentences.
2. **What a healthy value looks like.** "A healthy value is 0."
3. **What it means when it is not, and what to do.** Name the action or the
   place to look next.

Tables may end with a short column list. Panels that link somewhere end with the
click instruction: "Click a test name to open it in Test Details."
