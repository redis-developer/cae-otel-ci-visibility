export type TSuspiciousTestId = {
  readonly testId: string
  readonly reasons: readonly string[]
}

type TDetector = {
  readonly reason: string
  readonly pattern: RegExp
}

// OS-assigned (random) ports come from the ephemeral range 32768–65535;
// fixed well-known ports in test names (localhost:6379) are stable and must
// not be flagged — measured live: node-redis URL-parsing tests carry them.
const EPHEMERAL_PORT =
  '(?:3276[8-9]|327[7-9][0-9]|32[8-9][0-9]{2}|3[3-9][0-9]{3}|[4-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])'

// Heuristics for run-varying values embedded in test names. Every new value
// mints a new metric series per run, reintroducing unbounded cardinality —
// the exact churn the stable label schema removed. A fixed date or token in
// a test name is legal, just suspicious — which is why `warn` is the default
// enforcement mode. Every pattern here was measured against the live fleet's
// ~3.5k proven-stable test ids (zero churn) with zero hits.
const DETECTORS: readonly TDetector[] = [
  {
    reason: 'UUID',
    pattern: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
  },
  {
    // 12+ hex chars (hashes, memory addresses). Deliberately above the
    // 8-char hash suffix that truncated test IDs legitimately carry.
    // Requires a letter so pure digit runs fall to 'long digit run',
    // which knows about legitimate numeric boundary constants.
    reason: 'long hex token',
    pattern: /(?<![0-9a-f])(?=[0-9]*[a-f])[0-9a-f]{12,}(?![0-9a-f])/i
  },
  {
    // 7–11 hex chars containing both a digit and a letter (git short SHAs,
    // short hashes). Pure words can't match (no digit); the legitimate
    // ___hash8 truncation suffix is excluded by the underscore lookbehind.
    reason: 'short hex hash',
    pattern:
      /(?<![0-9a-f_])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,11}(?![0-9a-f])/i
  },
  {
    reason: 'hex memory address',
    pattern: /0x[0-9a-f]{6,}(?![0-9a-f])/i
  },
  {
    reason: 'ISO date',
    pattern: /\b\d{4}-\d{2}-\d{2}\b/
  },
  {
    // Full ISO-8601 timestamps glue digits to 'T' (a word character), which
    // defeats the \b boundaries of the date and clock patterns — so
    // '2026-07-29T12:30:45Z' escapes both. Measured: 0 hits on the live
    // corpus.
    reason: 'ISO timestamp',
    pattern: /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/
  },
  {
    // 2020–2039 keeps date-shaped 8-digit numbers apart from plain counts
    reason: 'compact date (YYYYMMDD)',
    pattern: /(?<!\d)20[2-3]\d(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])(?!\d)/
  },
  {
    reason: 'clock time',
    pattern: /\b\d{1,2}:\d{2}:\d{2}\b/
  },
  {
    // 10-digit epoch seconds or 13-digit epoch millis, 2017–2033 range
    reason: 'epoch timestamp',
    pattern: /(?<!\d)1[5-9]\d{8}(?:\d{3})?(?!\d)/
  },
  {
    // Snowflake ids, random int64s, nanotime. Exempts the boundary
    // constants 2^53−1, 2^63−1 and 2^64−1, which appear in legitimate
    // limit-handling test names.
    reason: 'long digit run',
    pattern:
      /(?<!\d)(?!(?:9007199254740991|9223372036854775807|18446744073709551615)(?!\d))\d{13,}(?!\d)/
  },
  {
    reason: 'host:port address',
    pattern: new RegExp(
      `\\b(?:localhost|\\d{1,3}(?:\\.\\d{1,3}){3}):${EPHEMERAL_PORT}\\b`
    )
  },
  {
    reason: 'ephemeral port',
    pattern: new RegExp(`\\bports?[\\s:=#_-]+${EPHEMERAL_PORT}\\b`, 'i')
  },
  {
    reason: 'process id',
    pattern: /\bpid[\s:=#_-]*\d{2,}\b/i
  },
  {
    // Counter after a run/build-flavored keyword ("run 48291"). Requires 4+
    // digits and skips numbers ending in 00 — round counts in stable names
    // ("run 1000 commands") vastly outnumber round random counters.
    reason: 'run counter',
    pattern:
      /\b(?:run|seed|attempt|retry|iteration|worker|job|build)[\s#_-]*(?!\d*00\b)\d{4,}\b/i
  },
  {
    // Padded base64 only: 16+ token chars containing a digit, closed by
    // '='/'=='. Unpadded base64 is indistinguishable from long camelCase
    // identifiers with digits (e.g. testTimeSeriesAddSha256Digest).
    reason: 'base64 token',
    pattern: /(?=[A-Za-z0-9+/]*\d)[A-Za-z0-9+/]{16,}={1,2}(?![A-Za-z0-9+/=])/
  },
  {
    // Measured durations embedded in names churn by nature
    reason: 'measured duration',
    pattern:
      /\b(?:took|elapsed)[\s:]+\d+(?:\.\d+)?\s*(?:ms|ns|us|s|sec|secs|seconds|millis|milliseconds)?\b/i
  },
  {
    // Fixed literal paths (/tmp/redis.sock) are stable — measured live; only
    // paths with a digit in a path segment (mkdtemp-style randomness) flag.
    // The query string is excluded so unix:///tmp/x.sock?db=2 stays clean.
    reason: 'temp directory path',
    pattern: /(?:\/tmp\/|\/var\/folders\/|\\Temp\\)[^\s?]*\d/i
  }
]

/**
 * Flags test IDs that look nondeterministic (contain values that change
 * from run to run). Returns one entry per distinct suspicious ID with the
 * matched reasons.
 */
export const detectNondeterministicTestIds = (
  testIds: readonly (string | undefined)[]
): readonly TSuspiciousTestId[] => {
  const suspicious: TSuspiciousTestId[] = []

  for (const testId of new Set(testIds)) {
    if (!testId) {
      continue
    }

    const reasons = DETECTORS.filter((detector) =>
      detector.pattern.test(testId)
    ).map((detector) => detector.reason)

    if (reasons.length > 0) {
      suspicious.push({ testId, reasons })
    }
  }

  return suspicious
}
