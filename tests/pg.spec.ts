/**
 * Basic contract tests for the PostgreSQL session-persistence backend.
 * Requires a local PostgreSQL instance at the default connection string.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import { PostgresSessionPersistence, type Config } from '../src/index.ts'
import { randomUUID } from 'node:crypto'

const CONNECTION_STRING = 'postgres://postgres:postgres@localhost:5432/postgres'

/** Rebuild the test schema before each test so state is isolated. */
async function resetSchema(): Promise<void> {
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: CONNECTION_STRING })
  await pool.query('DROP TABLE IF EXISTS events CASCADE')
  await pool.query('DROP TABLE IF EXISTS sessions CASCADE')
  await pool.query('DROP TABLE IF EXISTS persistence_state CASCADE')
  await pool.end()
}

/** Create a fresh backend + context for each test. */
async function createBackend(config: Partial<Config> = {}): Promise<{
  ctx: Context
  persistence: PostgresSessionPersistence
  dispose: () => Promise<void>
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const fiber = await ctx.plugin(PostgresSessionPersistence, {
    connectionString: CONNECTION_STRING,
    preparedSessionCacheSize: 2,
    writeBatchMaxDelayMs: 100,
    ...config,
  })
  return {
    ctx,
    persistence: ctx.sessionPersistence as PostgresSessionPersistence,
    dispose: async () => { await fiber.dispose() },
  }
}

describe('PostgresSessionPersistence', () => {
  beforeEach(resetSchema)

  it('registers as ctx.sessionPersistence', async () => {
    const { persistence, dispose } = await createBackend()
    expect(persistence).toBeDefined()
    expect(persistence.name).toBe('session-persistence-postgres')
    await dispose()
  })

  it('locate returns undefined (no per-session artifact)', async () => {
    const { persistence, dispose } = await createBackend()
    const meta = { version: 0, id: randomUUID() as never, createdAt: 0 }
    expect(persistence.locate(meta)).toBeUndefined()
    await dispose()
  })

  it('supportsRawArtifacts is false', async () => {
    const { persistence, dispose } = await createBackend()
    expect(persistence.supportsRawArtifacts).toBe(false)
    await dispose()
  })

  it('create + append + load round-trips', async () => {
    const { persistence, dispose } = await createBackend()
    const id = randomUUID() as never
    const meta = { version: 0, id, createdAt: Date.now() }

    // Create the session
    await persistence.create(meta)

    // Append events with proper message identification
    const msgId = `msg-${randomUUID()}`
    const events = [
      { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } },
      { type: 'user/message', seq: 1, time: 2000, data: { role: 'user', id: msgId, source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] }, surfaceOp: 'append' },
      { type: 'turn/end', seq: 2, time: 3000, data: { turn: 1, reason: { kind: 'completed' } } },
    ] as never[]
    await persistence.append(id, events)

    // Load and verify
    const inspection = await persistence.load(id)
    expect(inspection.meta.id).toBe(id)
    expect(inspection.events).toHaveLength(3)
    expect(inspection.events[0]?.type).toBe('turn/start')
    expect(inspection.events[1]?.type).toBe('user/message')
    expect(inspection.events[2]?.type).toBe('turn/end')

    await dispose()
  })

  it('round-trips NUL bytes (U+0000) in event data through JSONB', async () => {
    const { persistence, dispose } = await createBackend()
    const id = randomUUID() as never
    const meta = { version: 0, id, createdAt: Date.now() }
    await persistence.create(meta)

    // DSH agent-instructions events carry ".\u0000AGENTS.md" scopes (NUL
    // separator). PG text/JSONB rejects raw NUL, so the backend escapes it.
    const data = {
      role: 'user',
      id: `agent-instructions-${randomUUID()}`,
      content: [{ type: 'text', text: 'instructions' }],
      source: {
        kind: 'agent-instructions',
        form: 'instructions',
        baselineIdentity: '{}',
        changes: [
          { action: 'set', scope: '.\u0000AGENTS.md', path: 'AGENTS.md', digest: 'abc123' },
          { action: 'set', scope: 'literal \\u0000 stays literal', path: 'CLAUDE.md', digest: 'def456' },
        ],
      },
    }
    await persistence.append(id, [{ type: 'user/message', seq: 0, time: 1000, data, surfaceOp: 'append' } as never])

    const inspection = await persistence.load(id)
    const restored = inspection.events[0]?.data as typeof data
    expect(restored.source.changes[0]?.scope).toBe('.\u0000AGENTS.md')
    expect(restored.source.changes[0]?.scope).toContain('\u0000')
    expect(restored.source.changes[1]?.scope).toBe('literal \\u0000 stays literal')
    // Restored data matches the original object exactly.
    expect(restored).toEqual(data)

    await dispose()
  })

  it('list returns all materialized sessions', async () => {
    const { persistence, dispose } = await createBackend()
    const id1 = randomUUID() as never
    const id2 = randomUUID() as never

    await persistence.create({ version: 0, id: id1, createdAt: Date.now() })
    await persistence.create({ version: 0, id: id2, createdAt: Date.now() })

    // Not appended yet → should be absent from list (lazy materialization)
    let list = await persistence.list()
    expect(list).toHaveLength(0)

    // Append to one session
    await persistence.append(id1, [{ type: 'turn/end', seq: 0, time: 1000, data: { turn: 1, reason: { kind: 'completed' } } } as never])
    list = await persistence.list()
    expect(list).toHaveLength(1)
    expect(list[0]?.id).toBe(id1)

    await dispose()
  })

  it('listSnapshots returns revisions', async () => {
    const { persistence, dispose } = await createBackend()
    const id = randomUUID() as never
    await persistence.create({ version: 0, id, createdAt: Date.now() })
    await persistence.append(id, [{ type: 'turn/end', seq: 0, time: 1000, data: { turn: 1, reason: { kind: 'completed' } } } as never])

    const snapshots = await persistence.listSnapshots()
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]?.header.id).toBe(id)
    expect(snapshots[0]?.revision).toBeTruthy()
    expect(typeof snapshots[0]?.revision).toBe('string')

    await dispose()
  })

  it('readFrom returns suffix', async () => {
    const { persistence, dispose } = await createBackend()
    const id = randomUUID() as never
    await persistence.create({ version: 0, id, createdAt: Date.now() })
    await persistence.append(id, [
      { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } },
      { type: 'user/message', seq: 1, time: 2000, data: { role: 'user', id: `msg-${randomUUID()}`, source: { kind: 'user' }, content: [{ type: 'text', text: 'a' }] }, surfaceOp: 'append' },
      { type: 'turn/end', seq: 2, time: 3000, data: { turn: 1, reason: { kind: 'completed' } } },
    ] as never[])

    const suffix = await persistence.readFrom(id, 1)
    expect(suffix.events).toHaveLength(2)
    expect(suffix.events[0]?.seq).toBe(1)
    expect(suffix.events[1]?.seq).toBe(2)

    await dispose()
  })

  it('close releases the pool', async () => {
    const { persistence, dispose } = await createBackend()
    await dispose()
    // If dispose did not throw, the pool was closed cleanly
  }, 10000)
})