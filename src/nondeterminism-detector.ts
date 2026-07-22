export type TSuspiciousTestId = {
  readonly testId: string
  readonly reasons: readonly string[]
}

type TDetector = {
  readonly reason: string
  readonly pattern: RegExp
}

// Heuristics for run-varying values embedded in test names. Every new value
// mints a new metric series per run, reintroducing unbounded cardinality —
// the exact churn the v14 label schema removed. Matches are warnings, not
// failures: a fixed date in a test name is legal, just suspicious.
const DETECTORS: readonly TDetector[] = [
  {
    reason: 'UUID',
    pattern: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
  },
  {
    // 12+ hex chars (hashes, memory addresses). Deliberately above the
    // 8-char hash suffix that truncated test IDs legitimately carry.
    reason: 'long hex token',
    pattern: /(?<![0-9a-f])[0-9a-f]{12,}(?![0-9a-f])/i
  },
  {
    reason: 'ISO date',
    pattern: /\b\d{4}-\d{2}-\d{2}\b/
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
    reason: 'host:port address',
    pattern: /\b(?:localhost|\d{1,3}(?:\.\d{1,3}){3}):\d{2,5}\b/
  },
  {
    reason: 'temp directory path',
    pattern: /\/tmp\/|\/var\/folders\/|\\Temp\\/i
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
