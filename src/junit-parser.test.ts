import {
  type TResult,
  parseJUnitXML,
  ingestFile,
  ingestDir
} from './junit-parser.js'
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
const readFixture = (filename: string): string => {
  return readFileSync(`src/__test-fixtures__/${filename}`, {
    encoding: 'utf-8'
  })
}

const expectSuccess = <T>(result: TResult<T>): T => {
  if (!result.success) {
    throw new Error(`Expected success but got error: ${result.error}`)
  }
  return result.data
}

describe('JUnit XML Parser', () => {
  test('should parse complete junit xml', () => {
    const xml = readFixture('junit-complete.xml')
    const result = expectSuccess(parseJUnitXML(xml))
    expect(result).toMatchInlineSnapshot(`
      {
        "testsuites": [
          {
            "name": "Tests.Registration",
            "properties": {
              "browser": "Google Chrome",
              "ci": "https://github.com/actions/runs/1234",
              "commit": "ef7bebf",
              "config": "Config line #1
                      Config line #2
                      Config line #3",
              "version": "1.774",
            },
            "suites": undefined,
            "systemErr": "Data written to standard error.",
            "systemOut": "Data written to standard out.",
            "tests": [
              {
                "classname": "Tests.Registration",
                "name": "testCase1",
                "properties": undefined,
                "result": {
                  "status": "passed",
                },
                "systemErr": undefined,
                "systemOut": undefined,
                "time": 2.436,
              },
              {
                "classname": "Tests.Registration",
                "name": "testCase2",
                "properties": undefined,
                "result": {
                  "status": "passed",
                },
                "systemErr": undefined,
                "systemOut": undefined,
                "time": 1.534,
              },
              {
                "classname": "Tests.Registration",
                "name": "testCase3",
                "properties": undefined,
                "result": {
                  "status": "passed",
                },
                "systemErr": undefined,
                "systemOut": undefined,
                "time": 0.822,
              },
              {
                "classname": "Tests.Registration",
                "name": "testCase4",
                "properties": undefined,
                "result": {
                  "message": "Test was skipped.",
                  "status": "skipped",
                },
                "systemErr": undefined,
                "systemOut": undefined,
                "time": 0,
              },
              {
                "classname": "Tests.Registration",
                "name": "testCase5",
                "properties": undefined,
                "result": {
                  "body": "",
                  "message": "Expected value did not match.",
                  "status": "failed",
                  "type": "AssertionError",
                },
                "systemErr": undefined,
                "systemOut": undefined,
                "time": 2.902412,
              },
              {
                "classname": "Tests.Registration",
                "name": "testCase6",
                "properties": undefined,
                "result": {
                  "body": "",
                  "message": "Division by zero.",
                  "status": "error",
                  "type": "ArithmeticError",
                },
                "systemErr": undefined,
                "systemOut": undefined,
                "time": 3.819,
              },
              {
                "classname": "Tests.Registration",
                "name": "testCase7",
                "properties": undefined,
                "result": {
                  "status": "passed",
                },
                "systemErr": "Data written to standard error.",
                "systemOut": "Data written to standard out.",
                "time": 2.944,
              },
              {
                "classname": "Tests.Registration",
                "name": "testCase8",
                "properties": {
                  "attachment": "screenshots/users.png",
                  "author": "Adrian",
                  "description": "This text describes the purpose of this test case and provides
                          an overview of what the test does and how it works.",
                  "language": "english",
                  "priority": "high",
                },
                "result": {
                  "status": "passed",
                },
                "systemErr": undefined,
                "systemOut": undefined,
                "time": 1.625275,
              },
            ],
            "totals": {
              "cumulativeTime": 16.082687,
              "error": 1,
              "failed": 1,
              "passed": 5,
              "skipped": 1,
              "tests": 8,
              "time": 16.082687,
            },
          },
        ],
        "totals": {
          "cumulativeTime": 16.082687,
          "error": 1,
          "failed": 1,
          "passed": 5,
          "skipped": 1,
          "tests": 8,
          "time": 16.082687,
        },
      }
    `)
  })

  test('should reject XML with DOCTYPE declarations (XXE protection)', () => {
    const maliciousXml = `<?xml version="1.0"?>
		<!DOCTYPE testsuite [
		  <!ENTITY xxe SYSTEM "file:///etc/passwd">
		]>
		<testsuite name="test">
		  <testcase name="test1" classname="TestClass" time="0.5"/>
		</testsuite>`

    const result = parseJUnitXML(maliciousXml)
    expect(result.success).toBe(false)
    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining(
        'XML contains potentially malicious DOCTYPE or ENTITY declarations'
      )
    })
  })

  test('should reject oversized XML content', () => {
    const largeContent = 'x'.repeat(11 * 1024 * 1024)
    const xml = `<testsuite name="${largeContent}"><testcase name="test1" classname="TestClass" time="0.5"/></testsuite>`

    const result = parseJUnitXML(xml)
    expect(result.success).toBe(false)
    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('XML content exceeds maximum size')
    })
  })

  test('should reject non-string input', () => {
    const nullResult = parseJUnitXML(null as unknown as string)
    expect(nullResult.success).toBe(false)
    expect(nullResult).toMatchObject({
      success: false,
      error: expect.stringContaining('XML content must be a string')
    })

    const undefinedResult = parseJUnitXML(undefined as unknown as string)
    expect(undefinedResult.success).toBe(false)
    expect(undefinedResult).toMatchObject({
      success: false,
      error: expect.stringContaining('XML content must be a string')
    })

    const numberResult = parseJUnitXML(123 as unknown as string)
    expect(numberResult.success).toBe(false)
    expect(numberResult).toMatchObject({
      success: false,
      error: expect.stringContaining('XML content must be a string')
    })
  })

  test('should sanitize property names to prevent prototype pollution', () => {
    const xml = `<testsuites time="0.5">
		<testsuite name="test" time="0.5">
		  <properties>
		    <property name="__proto__" value="malicious"/>
		    <property name="constructor" value="attack"/>
		    <property name="prototype" value="injection"/>
		    <property name="valid" value="good"/>
		  </properties>
		  <testcase name="test1" classname="TestClass" time="0.5"/>
		</testsuite>
		</testsuites>`

    const result = expectSuccess(parseJUnitXML(xml))
    const suite = result.testsuites[0]!

    expect(suite.properties).toBeDefined()
    expect(suite.properties!['__proto__']).toBeUndefined()
    expect(suite.properties!['constructor']).toBeUndefined()
    expect(suite.properties!['prototype']).toBeUndefined()
    expect(suite.properties!['valid']).toBe('good')
  })

  test('should truncate very long strings', () => {
    const longString = 'x'.repeat(60000)
    const xml = `<testsuites time="0.5">
		<testsuite name="test" time="0.5">
		  <testcase name="test1" classname="TestClass" time="0.5">
		    <failure message="${longString}" type="TestFailure">Long content</failure>
		  </testcase>
		</testsuite>
		</testsuites>`

    const result = expectSuccess(parseJUnitXML(xml))
    const testCase = result.testsuites[0]!.tests[0]!

    if (testCase.result.status !== 'failed') {
      throw new Error('Expected test result to be failed')
    }

    expect(testCase.result).toMatchObject({
      status: 'failed',
      message: expect.stringMatching(/.*\.\.\.\[truncated\]/)
    })
    expect(testCase.result.message!.length).toBeLessThanOrEqual(50020)
  })

  test('should limit maximum number of properties', () => {
    const properties = Array.from(
      { length: 1001 },
      (_, i) => `<property name="prop${i}" value="value${i}"/>`
    ).join('')

    const xml = `<testsuite name="test">
		  <properties>${properties}</properties>
		  <testcase name="test1" classname="TestClass" time="0.5"/>
		</testsuite>`

    const result = parseJUnitXML(xml)
    expect(result.success).toBe(false)
    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining(
        'Maximum properties count of 1000 exceeded'
      )
    })
  })

  test('should handle deeply nested testsuites with depth limit', () => {
    let xml = '<testsuites>'
    for (let i = 0; i < 25; i++) {
      xml += `<testsuite name="suite${i}">`
    }
    xml += '<testcase name="test1" classname="TestClass" time="0.5"/>'
    for (let i = 0; i < 25; i++) {
      xml += '</testsuite>'
    }
    xml += '</testsuites>'

    const result = parseJUnitXML(xml)
    expect(result.success).toBe(false)
    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('Maximum nesting depth of 20 exceeded')
    })
  })

  test('should safely parse numeric values', () => {
    const xml = `<testsuites time="0">
		<testsuite name="test" time="0">
		  <testcase name="test1" classname="TestClass" time="NaN"/>
		  <testcase name="test2" classname="TestClass" time="invalid"/>
		  <testcase name="test3" classname="TestClass" time="-5"/>
		</testsuite>
		</testsuites>`

    const result = expectSuccess(parseJUnitXML(xml))
    const suite = result.testsuites[0]!

    expect(suite.tests[0]!.time).toBe(0)
    expect(suite.tests[1]!.time).toBe(0)
    expect(suite.tests[2]!.time).toBe(0)

    expect(suite.totals.tests).toBe(3)
    expect(suite.totals.passed).toBe(3)
    expect(suite.totals.time).toBe(0)
  })
})

describe('JUnit XML File System Ingestion', () => {
  const testDir = `test-temp`

  test('should ingest single XML file using ingestFile', () => {
    const result = expectSuccess(
      ingestFile('src/__test-fixtures__/junit-basic.xml')
    )

    expect(result.testsuites).toMatchInlineSnapshot(`
      [
        {
          "name": "Tests.Registration",
          "properties": undefined,
          "suites": undefined,
          "systemErr": undefined,
          "systemOut": undefined,
          "tests": [
            {
              "classname": "Tests.Registration",
              "name": "testCase1",
              "properties": undefined,
              "result": {
                "status": "passed",
              },
              "systemErr": undefined,
              "systemOut": undefined,
              "time": 2.113871,
            },
            {
              "classname": "Tests.Registration",
              "name": "testCase2",
              "properties": undefined,
              "result": {
                "status": "passed",
              },
              "systemErr": undefined,
              "systemOut": undefined,
              "time": 1.051,
            },
            {
              "classname": "Tests.Registration",
              "name": "testCase3",
              "properties": undefined,
              "result": {
                "status": "passed",
              },
              "systemErr": undefined,
              "systemOut": undefined,
              "time": 3.441,
            },
          ],
          "totals": {
            "cumulativeTime": 6.605871,
            "error": 0,
            "failed": 0,
            "passed": 3,
            "skipped": 0,
            "tests": 3,
            "time": 6.605871,
          },
        },
        {
          "name": "Tests.Authentication",
          "properties": undefined,
          "suites": [
            {
              "name": "Tests.Authentication.Login",
              "properties": undefined,
              "suites": undefined,
              "systemErr": undefined,
              "systemOut": undefined,
              "tests": [
                {
                  "classname": "Tests.Authentication.Login",
                  "name": "testCase4",
                  "properties": undefined,
                  "result": {
                    "status": "passed",
                  },
                  "systemErr": undefined,
                  "systemOut": undefined,
                  "time": 2.244,
                },
                {
                  "classname": "Tests.Authentication.Login",
                  "name": "testCase5",
                  "properties": undefined,
                  "result": {
                    "status": "passed",
                  },
                  "systemErr": undefined,
                  "systemOut": undefined,
                  "time": 0.781,
                },
                {
                  "classname": "Tests.Authentication.Login",
                  "name": "testCase6",
                  "properties": undefined,
                  "result": {
                    "status": "passed",
                  },
                  "systemErr": undefined,
                  "systemOut": undefined,
                  "time": 1.331,
                },
              ],
              "totals": {
                "cumulativeTime": 4.356,
                "error": 0,
                "failed": 0,
                "passed": 3,
                "skipped": 0,
                "tests": 3,
                "time": 4.356,
              },
            },
          ],
          "systemErr": undefined,
          "systemOut": undefined,
          "tests": [
            {
              "classname": "Tests.Authentication",
              "name": "testCase7",
              "properties": undefined,
              "result": {
                "status": "passed",
              },
              "systemErr": undefined,
              "systemOut": undefined,
              "time": 2.508,
            },
            {
              "classname": "Tests.Authentication",
              "name": "testCase8",
              "properties": undefined,
              "result": {
                "status": "passed",
              },
              "systemErr": undefined,
              "systemOut": undefined,
              "time": 1.230816,
            },
            {
              "classname": "Tests.Authentication",
              "name": "testCase9",
              "properties": undefined,
              "result": {
                "body": "",
                "message": "Assertion error message",
                "status": "failed",
                "type": "AssertionError",
              },
              "systemErr": undefined,
              "systemOut": undefined,
              "time": 0.982,
            },
          ],
          "totals": {
            "cumulativeTime": 9.076816,
            "error": 0,
            "failed": 1,
            "passed": 5,
            "skipped": 0,
            "tests": 6,
            "time": 9.076816,
          },
        },
      ]
    `)
  })

  test('should handle file not found error', () => {
    const result = ingestFile('nonexistent.xml')
    expect(result.success).toBe(false)
    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('ENOENT')
    })
  })

  test('should ingest directory with XML files using ingestDir', () => {
    try {
      mkdirSync(testDir, { recursive: true })

      const minimalXml = `<testsuites time="0.5">
        <testsuite name="TempTest1" time="0.5">
          <testcase name="test1" classname="TestClass" time="0.5"/>
        </testsuite>
      </testsuites>`

      const anotherXml = `<testsuites time="2.5">
        <testsuite name="TempTest2" time="2.5">
          <testcase name="test2" classname="TestClass" time="1.0"/>
          <testcase name="test3" classname="TestClass" time="1.5"/>
        </testsuite>
      </testsuites>`

      writeFileSync(join(testDir, 'test1.xml'), minimalXml)
      writeFileSync(join(testDir, 'test2.xml'), anotherXml)
      writeFileSync(join(testDir, 'ignore.txt'), 'not xml')

      const result = expectSuccess(ingestDir(testDir))

      expect(result.testsuites).toHaveLength(2)
      expect(result.totals.tests).toBe(3)
      expect(result.totals.time).toBe(3.0)
    } finally {
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  test('should handle empty directory', () => {
    try {
      mkdirSync(testDir, { recursive: true })

      const result = expectSuccess(ingestDir(testDir))

      expect(result.testsuites).toHaveLength(0)
      expect(result.totals.tests).toBe(0)
    } finally {
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  test('should handle directory not found error', () => {
    const result = ingestDir('non-existent-dir')
    expect(result.success).toBe(false)
    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('Failed to ingest directory')
    })
  })

  test('should handle path that is not a directory', () => {
    const result = ingestDir('src/__test-fixtures__/junit-basic.xml')
    expect(result.success).toBe(false)
    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('is not a directory')
    })
  })

  test('should handle multi-root XML documents', () => {
    try {
      mkdirSync(testDir, { recursive: true })

      const multiRootXml = `<testsuites time="1.5">
        <testsuite name="Suite1" time="0.5">
          <testcase name="test1" classname="TestClass" time="0.5"/>
        </testsuite>
        <testsuite name="Suite2" time="1.0">
          <testcase name="test2" classname="TestClass" time="1.0"/>
        </testsuite>
      </testsuites>`

      writeFileSync(join(testDir, 'multi-root.xml'), multiRootXml)

      const result = expectSuccess(ingestFile(join(testDir, 'multi-root.xml')))

      expect(result.testsuites).toHaveLength(2)
      expect(result.testsuites[0]!.name).toBe('Suite1')
      expect(result.testsuites[1]!.name).toBe('Suite2')
      expect(result.totals.tests).toBe(2)
    } finally {
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  test('should combine totals correctly across multiple files', () => {
    try {
      mkdirSync(testDir, { recursive: true })

      const xml1 = `<testsuites time="3.0">
        <testsuite name="PassingSuite" time="3.0">
          <testcase name="test1" classname="TestClass" time="1.0"/>
          <testcase name="test2" classname="TestClass" time="2.0"/>
        </testsuite>
      </testsuites>`

      const xml2 = `<testsuites time="2">
        <testsuite name="FailingSuite" time="2">
          <testcase name="test3" classname="TestClass" time="0.5"/>
          <testcase name="test4" classname="TestClass" time="1.5">
            <failure message="test failed">Failure message</failure>
          </testcase>
        </testsuite>
      </testsuites>`

      writeFileSync(join(testDir, 'passing.xml'), xml1)
      writeFileSync(join(testDir, 'failing.xml'), xml2)

      const result = expectSuccess(ingestDir(testDir))

      expect(result.totals.tests).toBe(4)
      expect(result.totals.passed).toBe(3)
      expect(result.totals.failed).toBe(1)
      expect(result.totals.time).toBe(5.0)
    } finally {
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  test('should preserve time discrepancies between XML time and cumulative time (jest-junit example)', async () => {
    const result = expectSuccess(
      ingestFile('src/__test-fixtures__/jest-junit.xml')
    )

    expect(result.totals.time).toBe(0.542)
    expect(result.totals.cumulativeTime).toBe(0.412)

    const metricsSuite = result.testsuites.find(
      (s) => s.name === 'src/metrics-submitter.test.ts'
    )
    expect(metricsSuite).toBeDefined()
    expect(metricsSuite!.totals.time).toBe(0.265)
    expect(metricsSuite!.totals.cumulativeTime).toBe(0.153)

    const junitSuite = result.testsuites.find(
      (s) => s.name === 'src/junit-parser.test.ts'
    )
    expect(junitSuite).toBeDefined()
    expect(junitSuite!.totals.time).toBe(0.061)
    expect(junitSuite!.totals.cumulativeTime).toBe(0.019)

    const mainSuite = result.testsuites.find(
      (s) => s.name === 'src/main.test.ts'
    )
    expect(mainSuite).toBeDefined()
    expect(mainSuite!.totals.time).toBe(0.05)
    expect(mainSuite!.totals.cumulativeTime).toBe(0.008)

    const genSuite = result.testsuites.find(
      (s) => s.name === 'src/metrics-generator.test.ts'
    )
    expect(genSuite).toBeDefined()
    expect(genSuite!.totals.time).toBe(0.036)
    expect(genSuite!.totals.cumulativeTime).toBe(0.004)
  })

  test('should require time attribute on testsuites element', () => {
    const xmlWithoutTime = `<?xml version="1.0"?>
      <testsuites name="test" tests="1" failures="0" errors="0">
        <testsuite name="TestSuite" time="1.0">
          <testcase name="test1" classname="Test" time="1.0"/>
        </testsuite>
      </testsuites>`

    const result = parseJUnitXML(xmlWithoutTime)
    expect(result.success).toBe(false)
    if (result.success) {
      throw new Error('Expected parsing to fail but it succeeded')
    }
    expect(result.error).toBe(
      'testsuites element is missing required time attribute'
    )
  })
})
