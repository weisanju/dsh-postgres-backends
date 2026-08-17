/**
 * PostgreSQL durable session-persistence backend. It maps each session header
 * and event to rows, and delegates write-path orchestration to
 * {@link PersistenceCoordinator}. It has no independent per-session artifact,
 * so its locator returns `undefined`.
 *
 * This is a THIRD-PARTY backend: it implements the same
 * `ctx.sessionPersistence` seam contract as the official JSONL/SQLite backends
 * without modifying the DeepSeek Harness source tree.
 *
 * @module dsh-session-persistence-postgres
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import {
  DEFAULT_PREPARED_SESSION_CACHE_SIZE, DEFAULT_WRITE_BATCH_MAX_DELAY_MS, MAX_WRITE_BATCH_DELAY_MS,
  SessionPersistence, SessionPersistenceRevision, PersistenceCoordinator,
  type PersistenceBackend, type SessionLocation, type SessionPersistenceSnapshot,
  type SessionInspection, type SessionPersistenceRevision as PersistenceRevision,
  type StoredPrefix, type StoredSuffix,
} from '@deepseek-ai/dsh-session-persistence'
import type { SessionEvent, SurfaceEventType, SessionId, SessionHeader, SessionPreparation } from '@deepseek-ai/dsh-session'
import {
  DDL, SCHEMA_VERSION, rowToMeta, scanRows, envelopeBindings, escapeNulText,
  type EventRow, type SessionRow,
} from './schema.ts'

const { Pool } = pg

/** Plugin configuration. */
export interface Config {
  /**
   * PostgreSQL connection string, e.g.
   * `postgres://user:password@host:5432/database`.
   */
  connectionString?: string
  /** PostgreSQL host (used when connectionString is not provided). */
  host?: string
  /** PostgreSQL port (used when connectionString is not provided). */
  port?: number
  /** PostgreSQL user (used when connectionString is not provided). */
  user?: string
  /** PostgreSQL password (used when connectionString is not provided). */
  password?: string
  /** PostgreSQL database name (used when connectionString is not provided). */
  database?: string
  /**
   * Maximum number of prepared session preparations retained for
   * history-to-resume reuse.
   */
  preparedSessionCacheSize?: number
  /** Fixed live-event coalescing window; not a backend completion deadline. */
  writeBatchMaxDelayMs?: number
}

/**
 * The PostgreSQL persistence backend. Load as a plugin; it registers as
 * `ctx.sessionPersistence` and (via the coordinator) installs the write-path
 * listeners. Its torn-tail marker is the seq to delete from.
 */
export class PostgresSessionPersistence extends SessionPersistence implements PersistenceBackend<number> {
  override readonly supportsRawArtifacts = false

  static inject = ['sessions']

  static Config: z<Config> = z.object({
    connectionString: z.string().default(''),
    host: z.string().default('localhost'),
    port: z.number().default(5432),
    user: z.string().default('postgres'),
    password: z.string().default('postgres'),
    database: z.string().default('postgres'),
    preparedSessionCacheSize: z.number().step(1).min(1).default(DEFAULT_PREPARED_SESSION_CACHE_SIZE),
    writeBatchMaxDelayMs: z.number().step(1).min(1).max(MAX_WRITE_BATCH_DELAY_MS)
      .default(DEFAULT_WRITE_BATCH_MAX_DELAY_MS),
  })

  /**
   * Backend label for the coordinator's dispose diagnostics.
   */
  override readonly name = 'session-persistence-postgres'

  private pool!: pg.Pool
  private storeIdentity!: string
  private ready: Promise<void>
  private coordinator: PersistenceCoordinator<number>

  constructor(ctx: Context, public config: Config) {
    super(ctx)
    const preparedSessionCacheSize = config.preparedSessionCacheSize
      ?? DEFAULT_PREPARED_SESSION_CACHE_SIZE
    const writeBatchMaxDelayMs = config.writeBatchMaxDelayMs
      ?? DEFAULT_WRITE_BATCH_MAX_DELAY_MS
    // Open asynchronously so connection setup does not block plugin apply;
    // every storage hook awaits the same readiness promise.
    this.ready = this.openDb(config)
    this.coordinator = new PersistenceCoordinator<number>(this.ctx, this, {
      preparedSessionCacheSize,
      writeBatchMaxDelayMs,
    })
  }

  private poolConfig(config: Config): pg.PoolConfig {
    if (config.connectionString) return { connectionString: config.connectionString }
    return {
      host: config.host ?? 'localhost',
      port: config.port ?? 5432,
      user: config.user,
      password: config.password,
      database: config.database,
    }
  }

  private async openDb(config: Config): Promise<void> {
    this.pool = new Pool(this.poolConfig(config))
    const client = await this.pool.connect()
    try {
      // One advisory-lock-scoped transaction: validate or initialize the schema
      // and read the store identity, so concurrent processes cannot race.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['dsh-session-persistence-postgres'])
      await client.query('BEGIN')
      try {
        await client.query(DDL)
        const state = await client.query<{ store_id: string; schema_version: number | null }>(
          'SELECT store_id, schema_version FROM persistence_state WHERE singleton = 1',
        )
        if (state.rows.length === 0) {
          // Fresh database: stamp identity and version in one transaction.
          await client.query(
            'INSERT INTO persistence_state (singleton, store_id, schema_version) VALUES (1, $1, $2)',
            [randomUUID(), SCHEMA_VERSION],
          )
        } else {
          const row = state.rows[0]
          if (row.schema_version === null || row.schema_version === 0) {
            throw new Error('session database has an unversioned schema or store identity')
          }
          if (row.schema_version !== SCHEMA_VERSION) {
            throw new Error(
              `session database has schema version ${row.schema_version}, incompatible with this build (${SCHEMA_VERSION})`,
            )
          }
        }
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {})
        throw error
      }
      const me = await client.query<{ host: string; port: number; current_database: string }>(
        'SELECT inet_server_addr() AS host, inet_server_port() AS port, current_database() AS current_database',
      )
      const identity = await client.query<{ store_id: string }>(
        'SELECT store_id FROM persistence_state WHERE singleton = 1',
      )
      const host = me.rows[0]?.host ?? 'local'
      const port = me.rows[0]?.port ?? 0
      const database = me.rows[0]?.current_database ?? '?'
      this.storeIdentity = `pg:${host}:${port}:${database}:store:${identity.rows[0]?.store_id}`
    } finally {
      client.release()
    }
  }

  // --- SessionPersistence service API (delegated to the coordinator) ---

  /** PostgreSQL has one database, not an independent local artifact per session. */
  locate(_meta: SessionHeader): SessionLocation | undefined {
    return undefined
  }

  create(meta: SessionHeader): Promise<void> {
    return this.coordinator.create(meta)
  }

  append(id: SessionId, events: readonly SessionEvent[]): Promise<void> {
    return this.coordinator.append(id, events)
  }

  override prepare(id: SessionId, signal?: AbortSignal): Promise<SessionPreparation> {
    return this.coordinator.prepare(id, signal)
  }

  load(id: SessionId): Promise<SessionInspection> {
    return this.coordinator.load(id)
  }

  inspect(id: SessionId, signal?: AbortSignal): Promise<SessionInspection> {
    return this.coordinator.inspect(id, signal)
  }

  readFrom(id: SessionId, fromSeq: number, signal?: AbortSignal): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    return this.coordinator.readFrom(id, fromSeq, signal)
  }

  // --- PersistenceBackend hooks (the PostgreSQL storage primitives) ---

  /** Read a stored prefix by id. Select `*::text` so JSONB arrives as text. */
  async loadStored(id: SessionId, signal?: AbortSignal): Promise<StoredPrefix<number> | undefined> {
    await this.guard(signal)
    const snapshot = await this.readPrefix(id)
    return snapshot
  }

  /** Read one row's revision without loading its events. */
  async readStoredRevision(id: SessionId, signal?: AbortSignal): Promise<PersistenceRevision | undefined> {
    await this.guard(signal)
    const row = await this.rowFor(id)
    return row === undefined ? undefined : this.revisionFor(row)
  }

  /**
   * Seek-capable suffix read: PostgreSQL selects `seq >= fromSeq` directly, so
   * the read scales with the suffix, not the log. Non-mutating.
   */
  async loadStoredFrom(id: SessionId, fromSeq: number, signal?: AbortSignal): Promise<StoredSuffix | undefined> {
    await this.guard(signal)
    const row = await this.rowFor(id)
    if (row === undefined) return undefined
    const eventRows = await this.eventRowsFor(id, `seq >= ${fromSeq}`)
    const { preserved } = scanRows(eventRows, fromSeq)
    return { meta: rowToMeta(row), events: preserved }
  }

  /**
   * Durably append a batch in ONE transaction: materialize the sessions row (if
   * lazy) and INSERT every event, or roll back entirely. The transaction is the
   * atomicity + durability boundary.
   */
  async appendBatch(meta: SessionHeader, events: readonly SessionEvent[], isMaterialized: boolean): Promise<void> {
    await this.ready
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      if (!isMaterialized) await this.writeRow(client, meta)
      for (const event of events) {
        const [surfaceSeqs, surfaceOp, ignorable] = envelopeBindings(event)
        await client.query(
          `INSERT INTO events (session_id, seq, type, time, data, source_event_seqs, surface_op, ignorable)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8)`,
          [meta.id, event.seq, event.type, event.time, JSON.stringify(escapeNulText(event.data)), surfaceSeqs, surfaceOp, ignorable],
        )
      }
      await client.query('UPDATE sessions SET revision = revision + 1 WHERE id = $1', [meta.id])
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  /**
   * Make a crash repair durable in ONE transaction: DELETE the torn tail (from
   * `tornMarker`) and INSERT the synthetic `closers`. After COMMIT the stored
   * rows == the balanced log.
   */
  async commitRepair(meta: SessionHeader, tornMarker: number | undefined, closers: readonly SessionEvent[]): Promise<void> {
    await this.ready
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      if (tornMarker !== undefined) {
        await client.query('DELETE FROM events WHERE session_id = $1 AND seq >= $2', [meta.id, tornMarker])
      }
      if (closers.length > 0) {
        for (const event of closers) {
          const [surfaceSeqs, surfaceOp, ignorable] = envelopeBindings(event)
          await client.query(
            `INSERT INTO events (session_id, seq, type, time, data, source_event_seqs, surface_op, ignorable)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8)`,
            [meta.id, event.seq, event.type, event.time, JSON.stringify(event.data), surfaceSeqs, surfaceOp, ignorable],
          )
        }
      }
      if (tornMarker !== undefined || closers.length > 0) {
        await client.query('UPDATE sessions SET revision = revision + 1 WHERE id = $1', [meta.id])
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  /** List all materialized sessions' metadata. */
  async list(signal?: AbortSignal): Promise<SessionHeader[]> {
    await this.guard(signal)
    const result = await this.pool.query<SessionRow>('SELECT * FROM sessions')
    return result.rows.map(rowToMeta)
  }

  /** List metadata with a source-qualified monotonic revision per session. */
  async listSnapshots(signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]> {
    await this.guard(signal)
    const result = await this.pool.query<SessionRow>('SELECT * FROM sessions')
    return result.rows.map(row => ({
      header: rowToMeta(row),
      revision: this.revisionFor(row),
    }))
  }

  /** Close the connection pool (awaited by the coordinator's dispose, post-drain). */
  async close(): Promise<void> {
    await this.ready
    await this.pool.end()
  }

  // --- helpers ---

  /** Read a session's row + ordered events into a StoredPrefix. */
  private async readPrefix(id: SessionId): Promise<StoredPrefix<number> | undefined> {
    const row = await this.rowFor(id)
    if (row === undefined) return undefined
    const eventRows = await this.eventRowsFor(id)
    const { preserved, tornFrom } = scanRows(eventRows)
    return {
      meta: rowToMeta(row),
      events: preserved,
      revision: this.revisionFor(row),
      ...tornFrom !== undefined ? { tornMarker: tornFrom } : {},
    }
  }

  private revisionFor(row: SessionRow): PersistenceRevision {
    return SessionPersistenceRevision(
      `${this.storeIdentity}:incarnation:${row.incarnation}:revision:${row.revision}`,
    )
  }

  private async guard(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    await this.ready
    signal?.throwIfAborted()
  }

  /** Fetch a session's row, or undefined if absent. */
  private async rowFor(id: SessionId): Promise<SessionRow | undefined> {
    const result = await this.pool.query<SessionRow>('SELECT * FROM sessions WHERE id = $1', [id])
    return result.rows[0]
  }

  /** Fetch one session's event rows, ordered by seq ascending, JSONB cast to text. */
  private async eventRowsFor(id: SessionId, where = 'TRUE'): Promise<EventRow[]> {
    const result = await this.pool.query<EventRow>(
      `SELECT seq, type, time, data::text AS data, source_event_seqs::text AS source_event_seqs,
              surface_op::text AS surface_op, ignorable
       FROM events WHERE session_id = $1 AND ${where} ORDER BY seq`,
      [id],
    )
    return result.rows
  }

  /**
   * Insert-or-replace a session's metadata row (lazy materialization).
   * The only caller is the first materializing `appendBatch`.
   */
  private async writeRow(client: pg.PoolClient, meta: SessionHeader): Promise<void> {
    await client.query(
      `INSERT INTO sessions
         (id, version, created_at, cwd, parent_session, seed_length, origin, delegation_depth, agent_preset, incarnation, revision)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0)
       ON CONFLICT (id) DO UPDATE SET
         version = EXCLUDED.version,
         created_at = EXCLUDED.created_at,
         cwd = EXCLUDED.cwd,
         parent_session = EXCLUDED.parent_session,
         seed_length = EXCLUDED.seed_length,
         origin = EXCLUDED.origin,
         delegation_depth = EXCLUDED.delegation_depth,
         agent_preset = EXCLUDED.agent_preset`,
      [
        meta.id,
        meta.version,
        meta.createdAt,
        meta.cwd ?? null,
        meta.parentSession ?? null,
        meta.seedLength ?? null,
        meta.origin ?? null,
        meta.delegationDepth ?? null,
        meta.agentPreset ?? null,
        randomUUID(),
      ],
    )
  }
}

export default PostgresSessionPersistence

// The `SurfaceEventType` import is used by the envelope typing in schema.ts;
// re-export the schema helpers for tests.
export { SCHEMA_VERSION, DDL, rowToMeta, rowToEvent, scanRows } from './schema.ts'