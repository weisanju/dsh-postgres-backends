/**
 * Migration tests for the storage-domain JSON ⇄ PostgreSQL path. Uses a
 * throwaway DSH_HOME so the real ~/.dsh/storages/ is never touched, and an
 * isolated `dsh_test` database (see helpers/db.ts) so production is never
 * touched either.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { rm, writeFile, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  listStorage, migrateStorage, storageJsonRoot,
} from '../src/console/storage-migrate.ts'
import { ensureTestDatabase, TEST_CONFIG, TEST_CONNECTION_STRING } from './helpers/db.ts'

const CONNECTION = {
  host: TEST_CONFIG.host, port: TEST_CONFIG.port,
  user: TEST_CONFIG.user, password: TEST_CONFIG.password,
  database: TEST_CONFIG.database, poolMax: 10, connectionTimeoutMillis: 0,
}

let dshHome = ''
const originalDshHome = process.env.DSH_HOME

async function resetPg(): Promise<void> {
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: TEST_CONNECTION_STRING })
  const tables = await pool.query<{ table_name: string }>(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name LIKE 'kv_%'
  `)
  for (const row of tables.rows) {
    await pool.query(`DROP TABLE IF EXISTS "${row.table_name}" CASCADE`)
  }
  await pool.query('DROP TABLE IF EXISTS kv_unit_globals CASCADE')
  await pool.query('DROP TABLE IF EXISTS kv_units CASCADE')
  await pool.end()
}

describe('storage-migrate', () => {
  beforeAll(async () => {
    await ensureTestDatabase()
    dshHome = mkdtempSync(join(tmpdir(), 'dsh-migrate-'))
    process.env.DSH_HOME = dshHome
  })
  afterAll(async () => {
    process.env.DSH_HOME = originalDshHome
    await rm(dshHome, { recursive: true, force: true })
  })
  beforeEach(async () => {
    await resetPg()
    await rm(join(dshHome, 'storages'), { recursive: true, force: true })
  })
  afterEach(async () => { await resetPg() })

  /** Write a workspace.json unit under the test DSH_HOME. */
  async function seedWorkspaceJson(): Promise<void> {
    await mkdir(join(dshHome, 'storages'), { recursive: true })
    await writeFile(
      join(dshHome, 'storages', 'workspace.json'),
      JSON.stringify({
        unit: { name: 'workspace', version: 2 },
        global: { initialized: true, workspaceIds: ['ws-1'], archivedSessionIds: [] },
        tables: {
          workspaces: {
            'ws-1': { path: '/x', title: 'x', sessionIds: ['s-1'], createdAt: 't', updatedAt: 't' },
          },
        },
      }, null, 2) + '\n',
    )
  }

  it('storageJsonRoot honors DSH_HOME', () => {
    expect(storageJsonRoot()).toBe(join(dshHome, 'storages'))
  })

  it('list reports both sides empty when neither holds any unit', async () => {
    const result = await listStorage(CONNECTION)
    expect(result.ok).toBe(true)
    expect(result.units).toEqual([])
    expect(result.jsonRoot).toBe(join(dshHome, 'storages'))
  })

  it('json→pg migrates a unit with a global and records', async () => {
    await seedWorkspaceJson()

    const dryRun = await migrateStorage(CONNECTION, 'json-to-pg', true, 'skip', false)
    expect(dryRun.ok).toBe(true)
    expect(dryRun.sourceTotal).toBe(1)
    expect(dryRun.units[0]!.records).toBe(1)
    expect(dryRun.recordsTotal).toBe(1) // counted in dry-run

    // Dry-run must not have written anything to PG.
    let after = await listStorage(CONNECTION)
    expect(after.units.find((u) => u.name === 'workspace')?.pg.present).toBe(false)

    const real = await migrateStorage(CONNECTION, 'json-to-pg', false, 'skip', false)
    expect(real.ok).toBe(true)
    expect(real.recordsTotal).toBe(1)
    after = await listStorage(CONNECTION)
    const ws = after.units.find((u) => u.name === 'workspace')
    expect(ws?.pg.present).toBe(true)
    expect(ws?.pg.version).toBe(2)
    expect(ws?.pg.recordCount).toBe(1)
    expect(ws?.pg.hasGlobal).toBe(true)
    expect(ws?.json.present).toBe(true) // source not deleted
  })

  it('skip policy leaves an existing PG target untouched', async () => {
    await seedWorkspaceJson()
    // Seed PG with a workspace unit holding one record.
    await migrateStorage(CONNECTION, 'json-to-pg', false, 'skip', false)
    // JSON source now also present (from the prior migrate); run again with skip.
    const again = await migrateStorage(CONNECTION, 'json-to-pg', false, 'skip', false)
    const unit = again.units.find((u) => u.name === 'workspace')
    expect(unit?.skipped).toMatch(/already has/)
    expect(again.recordsTotal).toBe(0)
  })

  it('overwrite policy rebuilds the PG target from source', async () => {
    await seedWorkspaceJson()
    await migrateStorage(CONNECTION, 'json-to-pg', false, 'skip', false)
    const again = await migrateStorage(CONNECTION, 'json-to-pg', false, 'overwrite', false)
    const unit = again.units.find((u) => u.name === 'workspace')
    expect(unit?.overwritten).toBe(true)
    expect(again.recordsTotal).toBe(1)
  })

  it('rebootstrap rewrites the workspace global to initialized=false + empty ids', async () => {
    await seedWorkspaceJson()
    await migrateStorage(CONNECTION, 'json-to-pg', false, 'skip', true)
    // Read the PG global directly.
    const { Pool } = await import('pg')
    const pool = new Pool({ connectionString: TEST_CONNECTION_STRING })
    const r = await pool.query('SELECT value FROM kv_unit_globals WHERE unit = $1', ['workspace'])
    const global = r.rows[0]!.value as { initialized: boolean; workspaceIds: unknown[] }
    expect(global.initialized).toBe(false)
    expect(global.workspaceIds).toEqual([])
    await pool.end()
  })

  it('pg→json rebuilds the file byte-compatible with storage-json format', async () => {
    await seedWorkspaceJson()
    // Seed PG from JSON first.
    await migrateStorage(CONNECTION, 'json-to-pg', false, 'skip', false)
    // Wipe the JSON file, then reverse-migrate.
    await rm(join(dshHome, 'storages', 'workspace.json'), { force: true })
    const reverse = await migrateStorage(CONNECTION, 'pg-to-json', false, 'skip', false)
    expect(reverse.ok).toBe(true)
    expect(reverse.recordsTotal).toBe(1)
    const text = await readFile(join(dshHome, 'storages', 'workspace.json'), 'utf8')
    const doc = JSON.parse(text) as { unit: { name: string; version: number }; global: unknown; tables: Record<string, unknown> }
    expect(doc.unit.name).toBe('workspace')
    expect(doc.unit.version).toBe(2)
    expect(Object.keys(doc.tables.workspaces!)).toEqual(['ws-1'])
  })

  it('NUL bytes round-trip through both directions', async () => {
    const NUL = String.fromCharCode(0)
    await mkdir(join(dshHome, 'storages'), { recursive: true })
    await writeFile(
      join(dshHome, 'storages', 'nulunit.json'),
      JSON.stringify({
        unit: { name: 'nulunit', version: 1 },
        global: null,
        tables: { t: { k: { scope: `pre${NUL}post`, nested: `a${NUL}b` } } },
      }) + '\n',
    )
    const forward = await migrateStorage(CONNECTION, 'json-to-pg', false, 'skip', false)
    expect(forward.ok).toBe(true)
    await rm(join(dshHome, 'storages', 'nulunit.json'), { force: true })
    const reverse = await migrateStorage(CONNECTION, 'pg-to-json', false, 'skip', false)
    expect(reverse.ok).toBe(true)
    const text = await readFile(join(dshHome, 'storages', 'nulunit.json'), 'utf8')
    const doc = JSON.parse(text) as { tables: { t: { k: { scope: string; nested: string } } } }
    expect(doc.tables.t.k.scope).toBe(`pre${NUL}post`)
    expect(doc.tables.t.k.nested).toBe(`a${NUL}b`)
  })
})
