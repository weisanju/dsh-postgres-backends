/**
 * PostgreSQL KV storage backend for the storage hub: one database hosts every
 * routed unit, document-per-row (`key TEXT` / `value JSONB`), unit identity
 * and globals in the shared `kv_units` / `kv_unit_globals` tables. Registers
 * as backend `postgres`; the disposer unregisters first, then closes the
 * medium. Mirrors the official `storage-json` / `storage-sqlite` backends
 * without modifying the Harness source tree.
 * @module dsh-storage-postgres
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import pg from 'pg'
import { StorageError, UNIT_NAME_RE, storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import type { KvFacet, KvUnit, KvUnitDescriptor, StorageBackend } from '@deepseek-ai/dsh-storage'
import { DDL, recordTableDdl } from './schema.ts'
import { PostgresKvUnit } from './unit.ts'

const { Pool } = pg

/** Cordis plugin name. */
export const name = 'storage-postgres'
/** The backend registers on the storage hub. */
export const inject = ['storage']

/** Plugin configuration (same shape as the session-persistence backend's). */
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
  /** Maximum number of clients the pool holds. Default: 10 (pg default). */
  poolMax?: number
  /**
   * Milliseconds to wait for a connection before failing; 0 waits forever.
   * Default: 0 (pg default).
   */
  connectionTimeoutMillis?: number
}

/** Schemastery validator for {@link Config}. */
export const Config: z<Config> = z.object({
  connectionString: z.string().default(''),
  host: z.string().default('localhost'),
  port: z.number().default(5432),
  user: z.string().default('postgres'),
  password: z.string().default('postgres'),
  database: z.string().default('postgres'),
  poolMax: z.number().step(1).min(1).default(10),
  connectionTimeoutMillis: z.number().step(1).min(0).default(0),
})

/**
 * The PostgreSQL {@link StorageBackend}. Owns one connection pool and the
 * open-unit table; `kv.open` validates names, enforces the per-unit version
 * stamp in `kv_units`, and ensures the unit's record tables.
 */
export class PostgresStorageBackend implements StorageBackend {
  /** The key-value facet; the only shape this backend serves. */
  readonly kv: KvFacet = { open: descriptor => this.openUnit(descriptor) }

  /**
   * The connection pool. Public so the migration engine can run raw probes
   * (counting records across discovered tables) without opening units, which
   * would stamp versions on a fresh database. Normal callers never need
   * this — they go through the `kv` facet.
   */
  pool!: pg.Pool
  /**
   * Resolves once the pool is open and the metadata tables exist. Migrations
   * and other out-of-band callers that reach into the pool directly await
   * this before probing; normal unit operations await via `materializeUnit`.
   */
  readonly ready: Promise<void>
  /** Open (or still-opening) units by name; presence is the double-open guard. */
  private readonly units = new Map<string, Promise<PostgresKvUnit>>()
  private closing: Promise<void> | undefined
  /** Logger slot; `apply` fills it with the plugin context's logger. */
  logger: { warn: (template: string, ...values: unknown[]) => void } = {
    warn: () => {},
  }

  /**
   * @param config - Validated plugin configuration.
   */
  constructor(private readonly config: Config) {
    // Open asynchronously so connection setup does not block plugin apply;
    // every unit primitive awaits the same readiness promise. Mark the
    // rejection handled so an open failure before the first use cannot crash
    // the process as an unhandled rejection.
    this.ready = this.openDb()
    this.ready.catch(() => {})
  }

  private async openDb(): Promise<void> {
    const base = this.config.connectionString
      ? { connectionString: this.config.connectionString }
      : {
          host: this.config.host ?? 'localhost',
          port: this.config.port ?? 5432,
          user: this.config.user,
          password: this.config.password,
          database: this.config.database,
        }
    this.pool = new Pool({
      ...base,
      max: this.config.poolMax ?? 10,
      connectionTimeoutMillis: this.config.connectionTimeoutMillis ?? 0,
    })
    // pg-pool emits 'error' when an IDLE client is dropped (server restart,
    // network partition); without a listener Node treats it as an uncaught
    // exception. Log and keep serving — the pool heals on the next acquire.
    this.pool.on('error', (error: Error) => {
      this.logger.warn('[storage-postgres] idle pool client error: %s', error.message)
    })
    await this.pool.query(DDL)
  }

  private openUnit(descriptor: KvUnitDescriptor): Promise<KvUnit> {
    if (this.closing !== undefined) {
      return Promise.reject(new StorageError('closed', 'postgres storage backend is closed'))
    }
    if (!UNIT_NAME_RE.test(descriptor.name)) {
      return Promise.reject(new Error(`kv unit name '${descriptor.name}' violates ${UNIT_NAME_RE}`))
    }
    for (const table of descriptor.tables) {
      if (!UNIT_NAME_RE.test(table)) {
        return Promise.reject(
          new Error(`kv table name '${table}' in unit '${descriptor.name}' violates ${UNIT_NAME_RE}`),
        )
      }
    }
    if (this.units.has(descriptor.name)) {
      return Promise.reject(
        new Error(`kv unit '${descriptor.name}' is already open (double-open is a caller bug)`),
      )
    }
    // Reserve the name synchronously so a concurrent second open of the same
    // name rejects instead of racing past the guard during the awaits below.
    const pending = this.materializeUnit(descriptor)
    this.units.set(descriptor.name, pending)
    pending.catch(() => this.units.delete(descriptor.name))
    return pending
  }

  private async materializeUnit(descriptor: KvUnitDescriptor): Promise<PostgresKvUnit> {
    await this.ready
    // One advisory-lock-scoped transaction: insert-or-check the version row
    // and ensure every record table, so concurrent processes cannot race.
    const client = await this.pool.connect()
    try {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['dsh-storage-postgres'])
      await client.query('BEGIN')
      try {
        const row = await client.query<{ version: number }>(
          'SELECT version FROM kv_units WHERE name = $1',
          [descriptor.name],
        )
        if (row.rows.length === 0) {
          await client.query('INSERT INTO kv_units (name, version) VALUES ($1, $2)', [
            descriptor.name,
            descriptor.version,
          ])
        } else if (row.rows[0]!.version !== descriptor.version) {
          throw new StorageError(
            'version-mismatch',
            `kv unit '${descriptor.name}' is stamped version ${row.rows[0]!.version} on the medium, `
              + `incompatible with descriptor version ${descriptor.version}`,
          )
        }
        for (const table of descriptor.tables) {
          await client.query(recordTableDdl(descriptor.name, table))
        }
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {})
        throw error
      }
    } finally {
      client.release()
    }
    return new PostgresKvUnit(this.pool, descriptor, () => {
      this.units.delete(descriptor.name)
    })
  }

  /**
   * Close every open unit and release the pool. Idempotent; concurrent and
   * repeated calls resolve once teardown finishes.
   * @returns resolution after the medium is released.
   */
  close(): Promise<void> {
    this.closing ??= this.doClose()
    return this.closing
  }

  private async doClose(): Promise<void> {
    try {
      await this.ready
    } catch {
      // The medium never opened; that failure already rejected the opener and
      // every unit call, so there is nothing left to release here.
      return
    }
    for (const pending of [...this.units.values()]) {
      const unit = await pending.catch(() => undefined)
      await unit?.close()
    }
    await this.pool.end()
  }
}

/**
 * Register the PostgreSQL backend as `postgres` on the storage hub. The
 * disposer unregisters the name first, then closes the backend.
 * @param ctx - Plugin context (must inject `storage`).
 * @param config - Validated plugin configuration.
 */
export function apply(ctx: Context, config: Config) {
  const backend = new PostgresStorageBackend(config)
  backend.logger = ctx.logger
  ctx.effect(() => {
    const dispose = ctx.storage.backend.register('postgres', backend)
    return async () => {
      dispose()
      await backend.close()
    }
  }, 'storage-postgres.registerBackend')
  ctx.provide(storageBackendServiceKey('postgres'), backend)
}
