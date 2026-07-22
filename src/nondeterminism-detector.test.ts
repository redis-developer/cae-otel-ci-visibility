import { detectNondeterministicTestIds } from './nondeterminism-detector.js'

describe('detectNondeterministicTestIds', () => {
  const flagged: { name: string; testId: string; reason: string }[] = [
    {
      name: 'UUID in test name',
      testId:
        'client.session.reconnects after 3f2b8c9a-77aa-4bde-9c01-2f4a5b6c7d8e expires',
      reason: 'UUID'
    },
    {
      name: 'UUID glued to an underscore',
      testId: 'client.session.session_3f2b8c9a-77aa-4bde-9c01-2f4a5b6c7d8e',
      reason: 'UUID'
    },
    {
      name: 'long hex token (memory address / hash)',
      testId: 'CacheTest.evicts entry 7f9c3a2b4d5e6f10',
      reason: 'long hex token'
    },
    {
      name: 'ISO date',
      testId: 'reports.DailyReportTest.generates report for 2026-07-21',
      reason: 'ISO date'
    },
    {
      name: 'clock time',
      testId: 'scheduler.JobTest.fires at 12:30:45',
      reason: 'clock time'
    },
    {
      name: 'epoch seconds',
      testId: 'session.SessionTest.expires_1753142400',
      reason: 'epoch timestamp'
    },
    {
      name: 'epoch milliseconds',
      testId: 'tracing.SpanTest.records trace_1753142400123',
      reason: 'epoch timestamp'
    },
    {
      name: 'localhost with random port',
      testId: 'ClientTest.connects to localhost:54321',
      reason: 'host:port address'
    },
    {
      name: 'IP address with port',
      testId: 'ClientTest.connects to 10.0.0.17:41337',
      reason: 'host:port address'
    },
    {
      name: 'unix temp path',
      testId: 'FileStoreTest.writes /tmp/build-9If3qZ/output.bin',
      reason: 'temp directory path'
    },
    {
      name: 'windows temp path',
      testId: 'FileStoreTest.writes C:\\Users\\ci\\AppData\\Local\\Temp\\x.bin',
      reason: 'temp directory path'
    }
  ]

  it.each(flagged)('flags: $name', ({ testId, reason }) => {
    const result = detectNondeterministicTestIds([testId])

    expect(result).toHaveLength(1)
    expect(result[0]!.testId).toBe(testId)
    expect(result[0]!.reasons).toContain(reason)
  })

  const clean: { name: string; testId: string }[] = [
    {
      name: 'plain java test id',
      testId: 'com.redis.lettucemod.RedisModulesClientTest.testTimeSeriesAdd'
    },
    {
      name: 'sentence-style jest name',
      testId: 'client.bf.add.BF.ADD transformArguments'
    },
    {
      name: 'version numbers',
      testId: 'MigrationTest.upgrades from 7.2.0 to 8.0.1'
    },
    {
      name: 'large but non-epoch number',
      testId: 'BoundaryTest.handles 100000 items'
    },
    {
      name: 'truncation hash suffix (8 hex chars) is legitimate',
      testId: 'com.example.LongParameterizedTest.case with args___61070ed8'
    },
    {
      name: 'ipv6 localhost without port pattern',
      testId: 'NetTest.parses ::1 correctly'
    }
  ]

  it.each(clean)('does not flag: $name', ({ testId }) => {
    expect(detectNondeterministicTestIds([testId])).toHaveLength(0)
  })

  it('reports each distinct suspicious id once with all matched reasons', () => {
    const testId = 'JobTest.ran 2026-07-21 at 12:30:45'

    const result = detectNondeterministicTestIds([testId, testId])

    expect(result).toHaveLength(1)
    expect(result[0]!.reasons).toEqual(['ISO date', 'clock time'])
  })

  it('ignores undefined entries', () => {
    expect(detectNondeterministicTestIds([undefined, undefined])).toHaveLength(
      0
    )
  })

  it('returns empty for an empty input', () => {
    expect(detectNondeterministicTestIds([])).toHaveLength(0)
  })
})
