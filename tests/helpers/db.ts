/**
 * Shared PostgreSQL test-database bootstrap. All specs import from here so no
 * test ever touches a production connection string.
 *
 * Resolution order for the test target:
 *   1. `DSH_PG_TEST_CONN` env var (a full `postgres://...` connection string).
 *   2. A local `dsh_test` database on the default host/port/credentials.
 *
 * The target database is created on demand (against the maintenance `postgres`
 * database) the first time {@link ensureTestDatabase} is awaited; subsequent
 * calls return the same memoized promise, so it is cheap to call per-test.
 */
import pg from 'pg'

const { Pool } = pg

/** Connection parameters the specs and migration helpers consume. */
export interface TestPgConfig {
  host: string
  port: number
  user: string
  password: string
  database: string
  poolMax: number
  connectionTimeoutMillis: number
}

const DEFAULT_HOST = 'localhost'
const DEFAULT_PORT = 5432
const DEFAULT_USER = 'postgres'
const DEFAULT_PASSWORD = 'postgres'
const DEFAULT_TEST_DB = 'dsh_test'

/** Parse a `postgres://` connection string into config parts. */
function configFromUrl(cs: string): TestPgConfig {
  const u = new URL(cs)
  return {
    host: u.hostname || DEFAULT_HOST,
    port: u.port ? Number(u.port) : DEFAULT_PORT,
    user: decodeURIComponent(u.username) || DEFAULT_USER,
    password: decodeURIComponent(u.password) || DEFAULT_PASSWORD,
    database: u.pathname.replace(/^\//, '') || DEFAULT_TEST_DB,
    poolMax: 10,
    connectionTimeoutMillis: 0,
  }
}

/** Rebuild a `postgres://` connection string from config parts. */
function configToConnectionString(c: TestPgConfig): string {
  return `postgres://${encodeURIComponent(c.user)}:${encodeURIComponent(c.password)}@${c.host}:${c.port}/${c.database}`
}

function resolveTestConfig(): TestPgConfig {
  const cs = process.env.DSH_PG_TEST_CONN
  return cs ? configFromUrl(cs) : {
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    user: DEFAULT_USER,
    password: DEFAULT_PASSWORD,
    database: DEFAULT_TEST_DB,
    poolMax: 10,
    connectionTimeoutMillis: 0,
  }
}

/** The test target config (host/port/user/password/database). */
export const TEST_CONFIG = resolveTestConfig()

/** The test target as a connection string. */
export const TEST_CONNECTION_STRING = configToConnectionString(TEST_CONFIG)

let ensured: Promise<void> | undefined

/**
 * Ensure the test database exists. Connects to the maintenance `postgres`
 * database (NOT the test target) and runs `CREATE DATABASE` if missing.
 * Memoized — safe to await from every `beforeEach`/test.
 */
export function ensureTestDatabase(): Promise<void> {
  ensured ??= doEnsure()
  return ensured
}

async function doEnsure(): Promise<void> {
  const admin = new Pool({
    host: TEST_CONFIG.host,
    port: TEST_CONFIG.port,
    user: TEST_CONFIG.user,
    password: TEST_CONFIG.password,
    database: 'postgres', // the always-present maintenance DB
  })
  try {
    const exists = await admin.query<{ datname: string }>(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [TEST_CONFIG.database],
    )
    if (exists.rows.length === 0) {
      // Identifier is safe — TEST_CONFIG.database is a hardcoded default or
      // came from a connection string we control; never a user query param.
      await admin.query(`CREATE DATABASE "${TEST_CONFIG.database}"`)
    }
  } finally {
    await admin.end()
  }
}
