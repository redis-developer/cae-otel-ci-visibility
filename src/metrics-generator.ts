import { createHash } from 'crypto'
import type { TJUnitReport, TSuite, TTest } from './junit-parser.js'

export interface TMetricsConfig {
  readonly repository: string | undefined
  readonly branch: string | undefined
}

export interface TMetricDataPoint {
  readonly metricName: string
  readonly metricType: 'histogram' | 'counter' | 'updowncounter' | 'gauge'
  readonly value: number
  readonly attributes: Readonly<Record<string, string>>
  readonly description: string
  readonly unit: string | undefined
}

// Length caps bytes, not cardinality. Mimir rejects label values over 2048
// bytes (default max_label_value_length) and a rejected sample fails the
// whole export, so IDs must stay well under that; 256 makes truncation rare.
const MAX_TEST_ID_LENGTH = 256
const TRUNCATED_HEAD_CHARS = 80
const HASH_LENGTH = 8
// head + '...' + tail + '___' + hash must fit within MAX_TEST_ID_LENGTH
const TRUNCATED_TAIL_CHARS =
  MAX_TEST_ID_LENGTH - TRUNCATED_HEAD_CHARS - HASH_LENGTH - '...___'.length

/**
 * Generates a deterministic, human-readable test ID.
 *
 * The ID is `{className}.{testName}`. Suite names mostly duplicate the class
 * name (Surefire) or are constant noise (`pytest`), so the suite is only
 * used as a fallback when the class name is empty. A test name that repeats
 * the class name as a dot- or space-separated prefix (or a class name that
 * already ends with the test name) is collapsed so no part appears twice.
 *
 * Two different tests sharing a class and test name under different suites
 * would collide here — `generateMetrics` detects that within a report and
 * switches the colliding tests to the suite-qualified form.
 *
 * @param suiteName - Test suite name (fallback context only)
 * @param className - Test class name
 * @param testName - Test method/case name
 * @returns A unique test identifier
 */
export const generateTestId = (
  suiteName: string,
  className: string,
  testName: string
): string => {
  const context = normalizeSegment(className) || normalizeSegment(suiteName)
  const fullId = compactJoin(context, normalizeSegment(testName))

  if (!fullId) {
    return 'unnamed'
  }

  return capTestIdLength(fullId)
}

/**
 * Suite-qualified variant, used only for tests whose short ID collides with
 * a different test in the same report (same class and test name under
 * different suites). Applies the same compaction rules between suite and
 * class, so a suite repeating the class still adds nothing.
 */
const generateSuiteQualifiedTestId = (
  suiteName: string,
  className: string,
  testName: string
): string => {
  const context = compactJoin(
    normalizeSegment(suiteName),
    normalizeSegment(className)
  )
  const fullId = compactJoin(context, normalizeSegment(testName))

  if (!fullId) {
    return 'unnamed'
  }

  return capTestIdLength(fullId)
}

const normalizeSegment = (value: string): string =>
  value.replace(/\s+/g, ' ').trim()

const compactJoin = (context: string, test: string): string => {
  if (!context) {
    return test
  }

  if (!test) {
    return context
  }

  const testRepeatsContext =
    test === context ||
    test.startsWith(`${context}.`) ||
    test.startsWith(`${context} `)

  if (testRepeatsContext) {
    return test
  }

  // jest-junit's default classNameTemplate is the test title, so the test
  // name frequently ends with the class ("0, 1" + "... transformReply 0, 1")
  const testEndsWithContext =
    test.endsWith(`.${context}`) || test.endsWith(` ${context}`)

  if (testEndsWithContext) {
    return test
  }

  const contextEndsWithTest =
    context.endsWith(`.${test}`) || context.endsWith(` ${test}`)

  if (contextEndsWithTest) {
    return context
  }

  return `${context}.${test}`
}

const capTestIdLength = (fullId: string): string => {
  if (fullId.length <= MAX_TEST_ID_LENGTH) {
    return fullId
  }

  const hash = createHash('sha256')
    .update(fullId)
    .digest('hex')
    .substring(0, HASH_LENGTH)

  const head = fullId.slice(0, TRUNCATED_HEAD_CHARS).replace(/\.+$/, '')
  const tail = fullId.slice(-TRUNCATED_TAIL_CHARS).replace(/^\.+/, '')

  return `${head}...${tail}___${hash}`
}

export const generateMetrics = (
  report: TJUnitReport,
  config: TMetricsConfig
): readonly TMetricDataPoint[] => {
  const baseAttributes = getBaseAttributes(config)

  const flattened: TFlattenedTest[] = []
  for (const suite of report.testsuites) {
    flattenSuite(suite, flattened)
  }

  const testIds = assignTestIds(flattened)

  return flattened.map(({ testCase }, index) => ({
    metricName: 'test_duration_seconds',
    metricType: 'gauge',
    value: testCase.time,
    attributes: {
      ...baseAttributes,
      'test.id': testIds[index]!
    },
    description:
      'Individual test execution duration for performance regression detection',
    unit: 's'
  }))
}

type TFlattenedTest = {
  readonly suiteName: string
  readonly testCase: TTest
}

const flattenSuite = (suite: TSuite, into: TFlattenedTest[]): void => {
  for (const testCase of suite.tests) {
    into.push({ suiteName: suite.name, testCase })
  }

  if (suite.suites) {
    for (const nestedSuite of suite.suites) {
      flattenSuite(nestedSuite, into)
    }
  }
}

/**
 * Assigns each test its short `class.test` ID, falling back to the
 * suite-qualified ID only for tests whose short ID is claimed by more than
 * one distinct test in this report. Reruns of the same test (identical
 * suite, class and name) are not collisions and share one ID.
 */
const assignTestIds = (flattened: readonly TFlattenedTest[]): string[] => {
  const identity = ({ suiteName, testCase }: TFlattenedTest): string =>
    [suiteName, testCase.classname, testCase.name]
      .map(normalizeSegment)
      .join('\u0000')

  const identitiesByShortId = new Map<string, Set<string>>()
  const shortIds = flattened.map((entry) => {
    const shortId = generateTestId(
      entry.suiteName,
      entry.testCase.classname,
      entry.testCase.name
    )

    const identities = identitiesByShortId.get(shortId) ?? new Set<string>()
    identities.add(identity(entry))
    identitiesByShortId.set(shortId, identities)

    return shortId
  })

  return flattened.map((entry, index) => {
    const shortId = shortIds[index]!
    const isCollision = (identitiesByShortId.get(shortId)?.size ?? 0) > 1

    if (!isCollision) {
      return shortId
    }

    return generateSuiteQualifiedTestId(
      entry.suiteName,
      entry.testCase.classname,
      entry.testCase.name
    )
  })
}

// Deliberately excludes per-run values (run IDs, commit SHAs): a fresh label
// value on every run mints #tests new series per run and cardinality grows
// as tests × runs. With stable labels, runs append samples to existing
// series and cardinality stays at tests × repos × branches.
const getBaseAttributes = (
  config: TMetricsConfig
): Readonly<Record<string, string>> => {
  const attributes: Record<string, string> = {}

  if (config.repository) {
    attributes['vcs.repository.name'] = config.repository
  }

  if (config.branch) {
    attributes['vcs.repository.ref.name'] = config.branch
  }

  return attributes
}
