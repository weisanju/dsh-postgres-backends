/**
 * Storage-domain migration between the official JSON file backend
 * (`~/.dsh/storages/*.json`, the `storage-json` format) and this package's
 * PostgreSQL KV backend. Two operations: a read-only side-by-side listing
 * (`storage.list`) and a bidirectional, dry-run-capable import
 * (`storage.migrate`).
 *
 * Both operations construct an ISOLATED `PostgresStorageBackend` instance
 * (its own pool, never registered on the parent storage hub) so a migration
 * never races the mounted runtime backend. The JSON side is read/written
 * directly through the same file format `storage-json` ships —
 * `{ unit: {name, version}, global, tables }` — so a round-trip is
 * byte-compatible with the official backend.
 *
 * @module dsh-postgres-backends/console/storage-migrate
 */

import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type pg from 'pg'
import { PostgresStorageBackend } from '../storage/index.ts'
import { recordTableName } from '../storage/schema.ts'
import { escapeNulText, unescapeNulText } from '../schema.ts'
import type {
  PgConnectionConfig, StorageConflictPolicy, StorageListResult,
  StorageMigrationDirection, StorageMigrateResult, StorageUnitEntry,
  StorageUnitResult, StorageUnitSide,
} from './shared.ts'

/** The directory holding one `<unit>.json` per storage unit. */
export function storageJsonRoot(): string {
  return join(resolveDshHome(), 'storages')
}

// ── JSON file format (mirrors @deepseek-ai/dsh-storage-json/src/format.ts) ──

interface JsonUnitFile {
  unit: { name: string; version: number }
  global: unknown
  tables: Record<string, Record<string, unknown>>
}

/** Parse one JSON unit file, tolerating absence. */
async function readJsonUnit(name: string): Promise<{ file: JsonUnitFile | undefined; error?: string }> {
  const path = join(storageJsonRoot(), `${name}.json`)
  try {
    const text = await readFile(path, 'utf8')
    return { file: JSON.parse(text) as JsonUnitFile }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { file: undefined }
    return { file: undefined, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Serialize one unit state to the storage-json file format. */
function serializeJsonUnit(file: JsonUnitFile): string {
  return `${JSON.stringify(file, null, 2)}\n`
}

// ── isolated PostgreSQL backend construction ─────────────────────────────────

/**
 * Build an isolated storage backend (own pool, never registered on the hub)
 * from a connection config. The caller MUST call `dispose()` to release the
 * pool — a migration never leaves a dangling connection behind.
 */
export async function isolatedStorageBackend(
  config: PgConnectionConfig,
): Promise<{ backend: PostgresStorageBackend; dispose: () => Promise<void> }> {
  const backend = new PostgresStorageBackend({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password === '' ? 'postgres' : config.password,
    database: config.database,
    poolMax: config.poolMax,
    connectionTimeoutMillis: config.connectionTimeoutMillis,
  })
  return { backend, dispose: () => backend.close() }
}

// ── side probes ─────────────────────────────────────────────────────────────

/** Probe the JSON side of one unit. */
async function jsonSide(name: string): Promise<StorageUnitSide> {
  const { file, error } = await readJsonUnit(name)
  if (file === undefined) {
    return error === undefined ? { present: false } : { present: false, error }
  }
  let recordCount = 0
  for (const table of Object.values(file.tables)) recordCount += Object.keys(table).length
  const hasGlobal = file.global !== null && file.global !== undefined
  return { present: true, version: file.unit.version, recordCount, hasGlobal }
}

/** Probe the PostgreSQL side of one unit via raw SQL (no unit open needed). */
async function pgSide(pool: pg.Pool, name: string): Promise<StorageUnitSide> {
  const unit = await pool.query<{ version: number }>(
    'SELECT version FROM kv_units WHERE name = $1',
    [name],
  )
  if (unit.rows.length === 0) return { present: false }
  const version = unit.rows[0]!.version
  // Global presence.
  const global = await pool.query<{ value: unknown }>(
    'SELECT value FROM kv_unit_globals WHERE unit = $1',
    [name],
  )
  const hasGlobal = global.rows.length > 0
  // Sum records across every record table for this unit. The table naming is
  // `kv_<unit>_<table>`; discover via information_schema so we don't need the
  // descriptor's table list.
  const tables = await pool.query<{ table_name: string }>(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name LIKE $1
  `, [`kv_${name}_%`])
  let recordCount = 0
  for (const row of tables.rows) {
    const count = await pool.query(`SELECT count(*)::int AS n FROM "${row.table_name}"`)
    recordCount += (count.rows[0] as { n: number }).n
  }
  return { present: true, version, recordCount, hasGlobal }
}

/** List every unit name seen on either side. */
async function allUnitNames(pool: pg.Pool): Promise<string[]> {
  const names = new Set<string>()
  // JSON side: *.json filenames in the storages root.
  try {
    const entries = await readdir(storageJsonRoot())
    for (const entry of entries) {
      if (entry.endsWith('.json')) names.add(entry.slice(0, -'.json'.length))
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  // PG side: kv_units rows.
  const pgNames = await pool.query<{ name: string }>('SELECT name FROM kv_units')
  for (const row of pgNames.rows) names.add(row.name)
  return [...names].sort()
}

// ── storage.list ────────────────────────────────────────────────────────────

/** Implement `storage.list`: a side-by-side inventory of every unit. */
export async function listStorage(config: PgConnectionConfig): Promise<StorageListResult> {
  const { backend, dispose } = await isolatedStorageBackend(config)
  try {
    await backend.ready
    const pool = backend.pool
    const names = await allUnitNames(pool)
    const units: StorageUnitEntry[] = []
    for (const name of names) {
      units.push({ name, json: await jsonSide(name), pg: await pgSide(pool, name) })
    }
    return { ok: true, units, jsonRoot: storageJsonRoot() }
  } catch (error) {
    return {
      ok: false,
      units: [],
      jsonRoot: storageJsonRoot(),
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    await dispose()
  }
}

// ── storage.migrate ─────────────────────────────────────────────────────────

/** One unit's source content, normalized from whichever side it came from. */
interface UnitContent {
  name: string
  version: number
  tables: Record<string, Record<string, unknown>>
  global: unknown
  hasGlobal: boolean
}

/** Read the JSON side of one unit into normalized content (absent → undefined). */
async function readJsonContent(name: string): Promise<UnitContent | undefined> {
  const { file } = await readJsonUnit(name)
  if (file === undefined) return undefined
  const tables: Record<string, Record<string, unknown>> = {}
  for (const [table, records] of Object.entries(file.tables)) {
    tables[table] = { ...records }
  }
  return {
    name: file.unit.name,
    version: file.unit.version,
    tables,
    global: file.global,
    hasGlobal: file.global !== null && file.global !== undefined,
  }
}

/** Read the PostgreSQL side of one unit into normalized content (absent → undefined). */
async function readPgContent(pool: pg.Pool, name: string): Promise<UnitContent | undefined> {
  const unit = await pool.query<{ version: number }>(
    'SELECT version FROM kv_units WHERE name = $1',
    [name],
  )
  if (unit.rows.length === 0) return undefined
  const version = unit.rows[0]!.version
  const tablesList = await pool.query<{ table_name: string }>(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name LIKE $1
  `, [`kv_${name}_%`])
  const tables: Record<string, Record<string, unknown>> = {}
  for (const row of tablesList.rows) {
    // table_name is kv_<unit>_<table>; strip the `kv_<unit>_` prefix.
    const table = row.table_name.slice(`kv_${name}_`.length)
    const records = await pool.query<{ key: string; value: unknown }>(
      `SELECT key, value FROM "${row.table_name}"`,
    )
    const map: Record<string, unknown> = {}
    for (const rec of records.rows) map[rec.key] = unescapeNulText(rec.value)
    tables[table] = map
  }
  const global = await pool.query<{ value: unknown }>(
    'SELECT value FROM kv_unit_globals WHERE unit = $1',
    [name],
  )
  const hasGlobal = global.rows.length > 0
  return {
    name,
    version,
    tables,
    global: hasGlobal ? unescapeNulText(global.rows[0]!.value) : null,
    hasGlobal,
  }
}

/**
 * Apply the `rebootstrap` option to a workspace unit's global: force
 * `initialized: false` and empty `workspaceIds` so the registry rebuilds
 * sessionIds on next startup. Mutates `content.global` in place.
 */
function applyRebootstrap(content: UnitContent): void {
  const global = (content.global ?? {}) as Record<string, unknown>
  global.initialized = false
  global.workspaceIds = []
  content.global = global
  content.hasGlobal = true
}

/** Wipe one unit's records + global from PostgreSQL (overwrite policy). */
async function pgWipeUnit(pool: pg.Pool, name: string): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const tables = await client.query<{ table_name: string }>(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name LIKE $1
    `, [`kv_${name}_%`])
    for (const row of tables.rows) {
      await client.query(`DROP TABLE IF EXISTS "${row.table_name}" CASCADE`)
    }
    await client.query('DELETE FROM kv_unit_globals WHERE unit = $1', [name])
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

/** Wipe one unit's JSON file (overwrite policy, pg-to-json direction). */
async function jsonWipeUnit(name: string): Promise<void> {
  const { rm } = await import('node:fs/promises')
  await rm(join(storageJsonRoot(), `${name}.json`), { force: true })
}

/** Write normalized content into PostgreSQL (the pg target). */
async function pgImport(
  pool: pg.Pool,
  content: UnitContent,
  tableNames: readonly string[],
): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['dsh-storage-postgres'])
    await client.query('BEGIN')
    try {
      await client.query(
        'INSERT INTO kv_units (name, version) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET version = excluded.version',
        [content.name, content.version],
      )
      for (const table of tableNames) {
        await client.query(`
          CREATE TABLE IF NOT EXISTS ${recordTableName(content.name, table)} (
            key   TEXT PRIMARY KEY,
            value JSONB NOT NULL
          )
        `)
        // Clear before re-inserting so an overwrite is a clean rebuild.
        await client.query(`DELETE FROM ${recordTableName(content.name, table)}`)
      }
      for (const [table, records] of Object.entries(content.tables)) {
        for (const [key, value] of Object.entries(records)) {
          await client.query(
            `INSERT INTO ${recordTableName(content.name, table)} (key, value) VALUES ($1, $2::jsonb)
             ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
            [key, JSON.stringify(escapeNulText(value))],
          )
        }
      }
      if (content.hasGlobal) {
        await client.query(
          `INSERT INTO kv_unit_globals (unit, value) VALUES ($1, $2::jsonb)
           ON CONFLICT (unit) DO UPDATE SET value = excluded.value`,
          [content.name, JSON.stringify(escapeNulText(content.global))],
        )
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    }
  } finally {
    client.release()
  }
}

/** Write normalized content into a JSON file (the json target). */
async function jsonImport(content: UnitContent): Promise<void> {
  const root = storageJsonRoot()
  await mkdir(root, { recursive: true, mode: 0o700 })
  const file: JsonUnitFile = {
    unit: { name: content.name, version: content.version },
    global: content.global,
    tables: content.tables,
  }
  await writeFile(join(root, `${content.name}.json`), serializeJsonUnit(file), { mode: 0o600 })
}

/** Count records across a unit's tables. */
function countRecords(content: UnitContent): number {
  let n = 0
  for (const records of Object.values(content.tables)) n += Object.keys(records).length
  return n
}

/** Run one storage migration (or dry-run scan). */
export async function migrateStorage(
  config: PgConnectionConfig,
  direction: StorageMigrationDirection,
  dryRun: boolean,
  onConflict: StorageConflictPolicy,
  rebootstrap: boolean,
): Promise<StorageMigrateResult> {
  const result: StorageMigrateResult = {
    ok: true,
    direction,
    dryRun,
    onConflict,
    rebootstrap,
    units: [],
    recordsTotal: 0,
    sourceTotal: 0,
  }
  const { backend, dispose } = await isolatedStorageBackend(config)
  try {
    await backend.ready
    const pool = backend.pool
    const names = await allUnitNames(pool)
    result.sourceTotal = names.length
    for (const name of names) {
      const unit: StorageUnitResult = { name, records: 0, hasGlobal: false }
      try {
        const isJsonToPg = direction === 'json-to-pg'
        // Absent source is not an error for a unit that exists only on the
        // target side; just skip it.
        const source = isJsonToPg
          ? await readJsonContent(name)
          : await readPgContent(pool, name)
        if (source === undefined) {
          unit.skipped = 'source has no trace of this unit'
          result.units.push(unit)
          continue
        }
        unit.hasGlobal = source.hasGlobal
        if (rebootstrap && name === 'workspace' && isJsonToPg) {
          applyRebootstrap(source)
        }
        unit.records = countRecords(source)

        // Probe the target to apply the conflict policy.
        const targetPresent = isJsonToPg
          ? (await pool.query('SELECT 1 FROM kv_units WHERE name = $1', [name])).rows.length > 0
          : (await readJsonUnit(name)).file !== undefined

        if (targetPresent && onConflict === 'skip') {
          unit.skipped = 'target already has this unit (skip)'
        } else if (targetPresent && onConflict === 'overwrite') {
          if (dryRun) {
            unit.overwritten = true
            unit.skipped = 'would rebuild target (overwrite)'
          } else {
            if (isJsonToPg) await pgWipeUnit(pool, name)
            else await jsonWipeUnit(name)
            if (isJsonToPg) {
              await pgImport(pool, source, Object.keys(source.tables))
            } else {
              await jsonImport(source)
            }
            unit.overwritten = true
            unit.skipped = 'target rebuilt from source (overwrite)'
            result.recordsTotal += unit.records
          }
        } else if (!dryRun) {
          if (isJsonToPg) {
            await pgImport(pool, source, Object.keys(source.tables))
          } else {
            await jsonImport(source)
          }
          result.recordsTotal += unit.records
        } else {
          // dry-run, no conflict: would import.
          result.recordsTotal += unit.records
        }
      } catch (error) {
        unit.error = error instanceof Error ? error.message : String(error)
        result.ok = false
      }
      result.units.push(unit)
    }
  } catch (error) {
    result.ok = false
    result.error = error instanceof Error ? error.message : String(error)
  } finally {
    await dispose()
  }
  return result
}
