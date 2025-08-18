import { XMLParser } from 'fast-xml-parser'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, extname } from 'path'

const MAX_XML_SIZE = 10 * 1024 * 1024
const MAX_PROPERTY_NAME_LENGTH = 100
const MAX_STRING_LENGTH = 50000
const MAX_NESTING_DEPTH = 20
const MAX_PROPERTIES_COUNT = 1000

interface TTestResultPassed {
  readonly status: 'passed'
}

interface TTestResultSkipped {
  readonly status: 'skipped'
  /** Optional message describing why the test was skipped */
  readonly message: string | undefined
}

interface TTestResultFailed {
  readonly status: 'failed'
  /** Failure message */
  readonly message: string | undefined
  /** Type descriptor (typically assertion type) */
  readonly type: string | undefined
  /** Extended failure description or stack trace */
  readonly body: string | undefined
}

interface TTestResultError {
  readonly status: 'error'
  /** Error message */
  readonly message: string | undefined
  /** Type descriptor (typically exception class) */
  readonly type: string | undefined
  /** Extended error description or stack trace */
  readonly body: string | undefined
}

export type TTestResult =
  | TTestResultPassed
  | TTestResultSkipped
  | TTestResultFailed
  | TTestResultError

/**
 * Totals contains aggregated results across a set of test runs.
 * The following relation should hold true: Tests === (Passed + Skipped + Failed + Error)
 */
export interface TTotals {
  /** Total number of tests run */
  readonly tests: number
  /** Total number of tests that passed successfully */
  readonly passed: number
  /** Total number of tests that were skipped */
  readonly skipped: number
  /** Total number of tests that resulted in a failure */
  readonly failed: number
  /** Total number of tests that resulted in an error */
  readonly error: number
  /** Total time taken to run all tests in seconds (from XML time attribute) */
  readonly time: number
  /** Calculated cumulative time of all child elements in seconds */
  readonly cumulativeTime: number
}

/**
 * Test represents the results of a single test run.
 */
export interface TTest {
  /** Descriptor given to the test */
  readonly name: string
  /** Additional descriptor for the hierarchy of the test */
  readonly classname: string
  /** Total time taken to run the test in seconds (from XML time attribute) */
  readonly time: number
  /** Result of the test */
  readonly result: TTestResult
  /** Additional properties from XML node attributes */
  readonly properties: Readonly<Record<string, string>> | undefined
  /** Textual output for the test case (stdout) */
  readonly systemOut: string | undefined
  /** Textual error output for the test case (stderr) */
  readonly systemErr: string | undefined
}

/**
 * Suite represents a logical grouping (suite) of tests.
 */
export interface TSuite {
  /** Descriptor given to the suite */
  readonly name: string
  /** Mapping of key-value pairs that were available when the tests were run */
  readonly properties: Readonly<Record<string, string>> | undefined
  /** Ordered collection of tests with associated results */
  readonly tests: readonly TTest[]
  /** Ordered collection of suites with associated tests */
  readonly suites: readonly TSuite[] | undefined
  /** Textual test output for the suite (stdout) */
  readonly systemOut: string | undefined
  /** Textual test error output for the suite (stderr) */
  readonly systemErr: string | undefined
  /** Aggregated results of all tests */
  readonly totals: TTotals
}

/**
 * JUnitReport represents the complete test report.
 */
export interface TJUnitReport {
  /** Collection of test suites */
  readonly testsuites: readonly TSuite[]
  /** Overall totals across all suites */
  readonly totals: TTotals
}

/**
 * Result types for operations that can succeed or fail
 */
export type TOk<TData> = {
  success: true
  data: TData
}

export type TErr<TError = string> = {
  success: false
  error: TError
}

export type TResult<TData, TError = string> = TOk<TData> | TErr<TError>

const validateInput = (xmlContent: string): TResult<string> => {
  if (typeof xmlContent !== 'string') {
    return {
      success: false,
      error: 'XML content must be a string'
    }
  }

  if (xmlContent.length > MAX_XML_SIZE) {
    return {
      success: false,
      error: `XML content exceeds maximum size of ${MAX_XML_SIZE} bytes`
    }
  }

  if (/<!(?:DOCTYPE|ENTITY)/i.test(xmlContent)) {
    return {
      success: false,
      error: 'XML contains potentially malicious DOCTYPE or ENTITY declarations'
    }
  }

  return { success: true, data: xmlContent }
}

const sanitizeString = (value: unknown): string => {
  if (value == null) return ''
  const str = String(value).trim()
  return str.length > MAX_STRING_LENGTH
    ? str.substring(0, MAX_STRING_LENGTH) + '...[truncated]'
    : str
}

const parsePositiveFloat = (value: unknown): number => {
  const num = parseFloat(String(value || '0'))
  const result = Number.isNaN(num) || num < 0 ? 0 : num
  return roundTime(result)
}

const roundTime = (time: number): number => {
  return Number(time.toFixed(6))
}

const validatePropertyName = (name: string): boolean => {
  if (!name || typeof name !== 'string') return false
  if (name.length > MAX_PROPERTY_NAME_LENGTH) return false
  if (name === '__proto__' || name === 'constructor' || name === 'prototype')
    return false
  return true
}

const validateNestingDepth = (depth: number): TResult<void> => {
  if (depth > MAX_NESTING_DEPTH) {
    return {
      success: false,
      error: `Maximum nesting depth of ${MAX_NESTING_DEPTH} exceeded`
    }
  }
  return { success: true, data: undefined }
}

const parseProperties = (
  /* eslint-disable @typescript-eslint/no-explicit-any */
  propertiesElement: any
): TResult<Record<string, string> | undefined> => {
  if (!propertiesElement || !propertiesElement.property) {
    return { success: true, data: undefined }
  }

  const properties: Record<string, string> = Object.create(null)
  const props = Array.isArray(propertiesElement.property)
    ? propertiesElement.property
    : [propertiesElement.property]

  let propertyCount = 0
  for (const prop of props) {
    if (propertyCount >= MAX_PROPERTIES_COUNT) {
      return {
        success: false,
        error: `Maximum properties count of ${MAX_PROPERTIES_COUNT} exceeded`
      }
    }

    const rawName = prop['@_name']
    if (!validatePropertyName(rawName)) {
      continue
    }

    const name = sanitizeString(rawName)
    propertyCount++

    let value: string
    if (prop['@_value'] !== undefined) {
      value = sanitizeString(prop['@_value'])
    } else if (prop['#text'] !== undefined) {
      value = sanitizeString(prop['#text'])
    } else if (typeof prop === 'string') {
      value = sanitizeString(prop)
    } else {
      value = ''
    }

    properties[name] = value
  }

  const result = Object.keys(properties).length > 0 ? properties : undefined
  return { success: true, data: result }
}

const parseTest = (testcase: any): TResult<TTest> => {
  let result: TTestResult

  if (testcase.failure) {
    result = {
      status: 'failed',
      message: sanitizeString(testcase.failure['@_message']),
      type: sanitizeString(testcase.failure['@_type']),
      body: sanitizeString(testcase.failure['#text'])
    }
  } else if (testcase.error) {
    result = {
      status: 'error',
      message: sanitizeString(testcase.error['@_message']),
      type: sanitizeString(testcase.error['@_type']),
      body: sanitizeString(testcase.error['#text'])
    }
  } else if (testcase.skipped !== undefined) {
    result = {
      status: 'skipped',
      message: testcase.skipped['@_message']
        ? sanitizeString(testcase.skipped['@_message'])
        : undefined
    }
  } else {
    result = { status: 'passed' }
  }

  const propertiesResult = parseProperties(testcase.properties)
  if (!propertiesResult.success) {
    return propertiesResult
  }

  const testData: TTest = {
    name: sanitizeString(testcase['@_name']),
    classname: sanitizeString(testcase['@_classname']),
    time: parsePositiveFloat(testcase['@_time']),
    result,
    properties: propertiesResult.data,
    systemOut: testcase['system-out']
      ? sanitizeString(testcase['system-out'])
      : undefined,
    systemErr: testcase['system-err']
      ? sanitizeString(testcase['system-err'])
      : undefined
  }

  return { success: true, data: testData }
}

const parseSuite = (suite: any, depth: number = 0): TResult<TSuite> => {
  const depthValidation = validateNestingDepth(depth)
  if (!depthValidation.success) {
    return { success: false, error: depthValidation.error }
  }

  const testcases = suite.testcase
    ? Array.isArray(suite.testcase)
      ? suite.testcase
      : [suite.testcase]
    : []

  const parsedTests: TTest[] = []
  for (const testcase of testcases) {
    const testResult = parseTest(testcase)
    if (!testResult.success) {
      return testResult
    }
    parsedTests.push(testResult.data)
  }

  const nestedSuites = suite.testsuite
    ? Array.isArray(suite.testsuite)
      ? suite.testsuite
      : [suite.testsuite]
    : []

  const parsedNestedSuites: TSuite[] = []
  for (const nestedSuite of nestedSuites) {
    const suiteResult = parseSuite(nestedSuite, depth + 1)
    if (!suiteResult.success) {
      return suiteResult
    }
    parsedNestedSuites.push(suiteResult.data)
  }

  const propertiesResult = parseProperties(suite.properties)
  if (!propertiesResult.success) {
    return propertiesResult
  }

  const originalTime = parsePositiveFloat(suite['@_time'])
  const totals = calculateTotals(
    parsedTests,
    parsedNestedSuites.length > 0 ? parsedNestedSuites : undefined,
    originalTime
  )

  const suiteData: TSuite = {
    name: sanitizeString(suite['@_name']),
    properties: propertiesResult.data,
    tests: parsedTests,
    suites: parsedNestedSuites.length > 0 ? parsedNestedSuites : undefined,
    systemOut: suite['system-out']
      ? sanitizeString(suite['system-out'])
      : undefined,
    systemErr: suite['system-err']
      ? sanitizeString(suite['system-err'])
      : undefined,
    totals: totals
  }

  return { success: true, data: suiteData }
}

const calculateTotals = (
  tests: readonly TTest[],
  nestedSuites?: readonly TSuite[],
  originalTime?: number
): TTotals => {
  let totalTests = tests.length
  let totalPassed = 0
  let totalSkipped = 0
  let totalFailed = 0
  let totalError = 0
  let cumulativeTime = 0

  for (const test of tests) {
    cumulativeTime += test.time
    switch (test.result.status) {
      case 'passed':
        totalPassed++
        break
      case 'skipped':
        totalSkipped++
        break
      case 'failed':
        totalFailed++
        break
      case 'error':
        totalError++
        break
    }
  }

  if (nestedSuites) {
    for (const suite of nestedSuites) {
      totalTests += suite.totals.tests
      totalPassed += suite.totals.passed
      totalSkipped += suite.totals.skipped
      totalFailed += suite.totals.failed
      totalError += suite.totals.error
      cumulativeTime += suite.totals.cumulativeTime
    }
  }

  return {
    tests: totalTests,
    passed: totalPassed,
    skipped: totalSkipped,
    failed: totalFailed,
    error: totalError,
    time: originalTime || roundTime(cumulativeTime),
    cumulativeTime: roundTime(cumulativeTime)
  }
}

/**
 * Parse JUnit XML content and return a minimal common subset report.
 * Only parses attributes that are universally supported across JUnit implementations.
 */
export const parseJUnitXML = (xmlContent: string): TResult<TJUnitReport> => {
  const validation = validateInput(xmlContent)
  if (!validation.success) {
    return { success: false, error: validation.error }
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    parseAttributeValue: false,
    trimValues: true,
    processEntities: false,
    allowBooleanAttributes: false,
    ignoreDeclaration: true,
    ignorePiTags: true
  })

  const result = parser.parse(validation.data)

  const testsuites = result.testsuites
    ? Array.isArray(result.testsuites.testsuite)
      ? result.testsuites.testsuite
      : [result.testsuites.testsuite]
    : [result.testsuite]

  const parsedSuites: TSuite[] = []
  for (const suite of testsuites) {
    const suiteResult = parseSuite(suite)
    if (!suiteResult.success) {
      return suiteResult
    }
    parsedSuites.push(suiteResult.data)
  }

  const calculatedTotals = parsedSuites.reduce(
    (acc, suite) => ({
      tests: acc.tests + suite.totals.tests,
      passed: acc.passed + suite.totals.passed,
      skipped: acc.skipped + suite.totals.skipped,
      failed: acc.failed + suite.totals.failed,
      error: acc.error + suite.totals.error,
      time: roundTime(acc.time + suite.totals.time),
      cumulativeTime: roundTime(
        acc.cumulativeTime + suite.totals.cumulativeTime
      )
    }),
    {
      tests: 0,
      passed: 0,
      skipped: 0,
      failed: 0,
      error: 0,
      time: 0,
      cumulativeTime: 0
    }
  )

  if (!result.testsuites) {
    return {
      success: false,
      error: 'XML must have a testsuites wrapper element with time attribute'
    }
  }

  if (!result.testsuites['@_time']) {
    return {
      success: false,
      error: 'testsuites element is missing required time attribute'
    }
  }

  const originalTestsuitesTime = parsePositiveFloat(result.testsuites['@_time'])

  const reportTotals = {
    ...calculatedTotals,
    time: originalTestsuitesTime,
    cumulativeTime: roundTime(calculatedTotals.time)
  }

  const reportData: TJUnitReport = {
    testsuites: parsedSuites,
    totals: reportTotals
  }

  return { success: true, data: reportData }
}

export const aggregate = (suite: TSuite): TSuite => {
  let totalTests = suite.tests.length
  let totalPassed = 0
  let totalSkipped = 0
  let totalFailed = 0
  let totalError = 0
  let totalCumulativeTime = 0

  for (const test of suite.tests) {
    totalCumulativeTime += test.time
    switch (test.result.status) {
      case 'passed':
        totalPassed++
        break
      case 'skipped':
        totalSkipped++
        break
      case 'failed':
        totalFailed++
        break
      case 'error':
        totalError++
        break
    }
  }

  const updatedNestedSuites: readonly TSuite[] | undefined = suite.suites?.map(
    (nestedSuite) => {
      const updatedNestedSuite = aggregate(nestedSuite)
      const { tests, cumulativeTime, passed, skipped, failed, error } =
        updatedNestedSuite.totals

      totalTests += tests
      totalCumulativeTime += cumulativeTime
      totalPassed += passed
      totalSkipped += skipped
      totalFailed += failed
      totalError += error

      return updatedNestedSuite
    }
  )

  const updatedTotals = {
    tests: totalTests,
    passed: totalPassed,
    skipped: totalSkipped,
    failed: totalFailed,
    error: totalError,
    time: suite.totals.time,
    cumulativeTime: totalCumulativeTime
  }

  return {
    ...suite,
    suites: updatedNestedSuites,
    totals: updatedTotals
  }
}

const parseMultiRootXML = (xmlContent: string): TResult<TJUnitReport> => {
  const firstResult = parseJUnitXML(xmlContent)
  if (firstResult.success) {
    return firstResult
  }

  const wrappedXml = `<testsuites>${xmlContent}</testsuites>`
  const secondResult = parseJUnitXML(wrappedXml)
  if (secondResult.success) {
    return secondResult
  }

  return firstResult
}

export const ingestFile = (filePath: string): TResult<TJUnitReport> => {
  try {
    const xmlContent = readFileSync(filePath, 'utf-8')
    const result = parseMultiRootXML(xmlContent)
    if (!result.success) {
      return {
        success: false,
        error: `Failed to ingest file ${filePath}: ${result.error}`
      }
    }
    return result
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    return {
      success: false,
      error: `Failed to ingest file ${filePath}: ${errorMessage}`
    }
  }
}

export const ingestFiles = (filePaths: string[]): TResult<TJUnitReport> => {
  const allSuites: TSuite[] = []

  for (const filePath of filePaths) {
    const result = ingestFile(filePath)
    if (!result.success) {
      return result
    }
    allSuites.push(...result.data.testsuites)
  }

  const reportTotals = allSuites.reduce(
    (acc, suite) => ({
      tests: acc.tests + suite.totals.tests,
      passed: acc.passed + suite.totals.passed,
      skipped: acc.skipped + suite.totals.skipped,
      failed: acc.failed + suite.totals.failed,
      error: acc.error + suite.totals.error,
      time: roundTime(acc.time + suite.totals.time),
      cumulativeTime: roundTime(
        acc.cumulativeTime + suite.totals.cumulativeTime
      )
    }),
    {
      tests: 0,
      passed: 0,
      skipped: 0,
      failed: 0,
      error: 0,
      time: 0,
      cumulativeTime: 0
    }
  )

  const reportData: TJUnitReport = {
    testsuites: allSuites,
    totals: reportTotals
  }

  return { success: true, data: reportData }
}

export const ingestDir = (dirPath: string): TResult<TJUnitReport> => {
  try {
    const stat = statSync(dirPath)
    if (!stat.isDirectory()) {
      return {
        success: false,
        error: `Path ${dirPath} is not a directory`
      }
    }

    const files = readdirSync(dirPath)
    const xmlFiles = files
      .filter((file) => extname(file).toLowerCase() === '.xml')
      .map((file) => join(dirPath, file))

    if (xmlFiles.length === 0) {
      const emptyReport: TJUnitReport = {
        testsuites: [],
        totals: {
          tests: 0,
          passed: 0,
          skipped: 0,
          failed: 0,
          error: 0,
          time: 0,
          cumulativeTime: 0
        }
      }
      return { success: true, data: emptyReport }
    }

    return ingestFiles(xmlFiles)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    return {
      success: false,
      error: `Failed to ingest directory ${dirPath}: ${errorMessage}`
    }
  }
}
