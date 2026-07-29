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
      name: 'git short SHA (7 hex chars with digits)',
      testId: 'DeployTest.builds commit 61070ed',
      reason: 'short hex hash'
    },
    {
      name: 'short hex hash glued to a dash',
      testId: 'DeployTest.builds build-a1b2c3d4e5f',
      reason: 'short hex hash'
    },
    {
      name: 'hex memory address',
      testId: 'SpanTest.allocates buffer at 0x7ffee4c3',
      reason: 'hex memory address'
    },
    {
      name: 'ISO date',
      testId: 'reports.DailyReportTest.generates report for 2026-07-21',
      reason: 'ISO date'
    },
    {
      name: 'compact date (YYYYMMDD)',
      testId: 'reports.RotationTest.rotates 20260721',
      reason: 'compact date (YYYYMMDD)'
    },
    {
      name: 'ISO-8601 timestamp (T-glued, escapes date and clock patterns)',
      testId: 'AuditTest.records event at 2026-07-29T12:30:45Z',
      reason: 'ISO timestamp'
    },
    {
      name: 'ISO-8601 timestamp without seconds',
      testId: 'AuditTest.schedules for 2026-07-29T12:30',
      reason: 'ISO timestamp'
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
      name: 'long digit run (snowflake id)',
      testId: 'IdTest.resolves snowflake 7215489234567890123',
      reason: 'long digit run'
    },
    {
      name: 'localhost with ephemeral port',
      testId: 'ClientTest.connects to localhost:54321',
      reason: 'host:port address'
    },
    {
      name: 'IP address with ephemeral port',
      testId: 'ClientTest.connects to 10.0.0.17:41337',
      reason: 'host:port address'
    },
    {
      name: 'bare ephemeral port after "port"',
      testId: 'WorkerTest.spawns listener on port 49152',
      reason: 'ephemeral port'
    },
    {
      name: 'process id',
      testId: 'ProcTest.kills pid 48213',
      reason: 'process id'
    },
    {
      name: 'run counter',
      testId: 'JobTest.processes run 48291',
      reason: 'run counter'
    },
    {
      name: 'padded base64 token',
      testId: 'AuthTest.accepts token QWxhZGRpbjpvcGVuIHNlc2FtZQ==',
      reason: 'base64 token'
    },
    {
      name: 'measured duration',
      testId: 'PerfTest.bulk insert took 1234ms',
      reason: 'measured duration'
    },
    {
      name: 'unix temp path with random component',
      testId: 'FileStoreTest.writes /tmp/build-9If3qZ/output.bin',
      reason: 'temp directory path'
    },
    {
      name: 'macOS temp path (per-user hash has digits)',
      testId: 'FileStoreTest.writes /var/folders/cp/v3mpm1b542gg/T/x.bin',
      reason: 'temp directory path'
    },
    {
      name: 'windows temp path with random component',
      testId:
        'FileStoreTest.writes C:\\Users\\ci\\AppData\\Local\\Temp\\build-9If3qZ\\x.bin',
      reason: 'temp directory path'
    }
  ]

  it.each(flagged)('flags: $name', ({ testId, reason }) => {
    const result = detectNondeterministicTestIds([testId])

    expect(result).toHaveLength(1)
    expect(result[0]!.testId).toBe(testId)
    expect(result[0]!.reasons).toContain(reason)
  })

  // Negatives are drawn from the live fleet's proven-stable test ids (zero
  // churn measured) — each was a real or near-miss false positive during
  // pattern selection.
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
      name: 'version range in name (live)',
      testId: 'FT.SUGGET WITHPAYLOADS null [6] - [7.4.0]'
    },
    {
      name: 'argument list in name (live)',
      testId: 'client.bf.add.BF.ADD transformArguments 0, 1'
    },
    {
      name: 'arity annotation in name (live)',
      testId:
        'CONFIG SET search-default-dialect set dialect with ft.aggregate (narg 9)'
    },
    {
      name: 'version numbers',
      testId: 'MigrationTest.upgrades from 7.2.0 to 8.0.1'
    },
    {
      name: 'decimal numbers',
      testId: 'ZADD with GT XX CH flags 1.5 2.5'
    },
    {
      name: 'large but non-epoch number',
      testId: 'BoundaryTest.handles 100000 items'
    },
    {
      name: 'well-known fixed port in a URL (live)',
      testId: 'Client parseURL redis://user:secret@localhost:6379/0'
    },
    {
      name: 'fixed port after "port"',
      testId: 'ClientTest.connects to port 6379'
    },
    {
      name: 'fixed literal unix socket path (live)',
      testId: 'Client parseURL unix socket URLs unix:///tmp/redis.sock'
    },
    {
      name: 'fixed socket path with digit only in query string (live)',
      testId:
        'Client parseURL unix socket URLs unix://user:secret@/tmp/redis.sock?db=2'
    },
    {
      name: 'millisecond option value (live)',
      testId:
        'Socket keepAliveInitialDelay default passes keepAliveInitialDelay: 30000 to net.createConnection by default'
    },
    {
      name: 'round count after "run"',
      testId: 'BenchTest.run 1000 commands'
    },
    {
      name: 'small fixed seed',
      testId: 'RandomSeedTest.seed 42 reproduces failures'
    },
    {
      name: 'http status code after "job"',
      testId: 'JobsApiTest.job 404 returns not found'
    },
    {
      name: 'Number.MAX_SAFE_INTEGER boundary constant',
      testId: 'ScanTest.handles cursor 9007199254740991'
    },
    {
      name: 'Long.MAX_VALUE boundary constant',
      testId: 'RangeTest.handles 9223372036854775807'
    },
    {
      name: 'long camelCase name with digits (not base64)',
      testId:
        'com.redis.lettucemod.RedisModulesClientTest.testTimeSeriesAddSha256Digest'
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
