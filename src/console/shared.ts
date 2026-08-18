/**
 * Shared contracts for the PG console: the settings namespace schema values,
 * the HTTP API payload shapes, and the migration report types. Browser-safe
 * (no node imports) so the client bundle can import this file directly.
 */

/** PG connection config surfaced in the console settings section. */
export interface PgConnectionConfig {
  host: string
  port: number
  user: string
  /** Stored in ~/.dsh/pg-console.json (mode 0600); never returned to the client after save. */
  password: string
  database: string
  /** pg.Pool max clients. */
  poolMax: number
  /** Pool connection timeout milliseconds (0 = wait forever). */
  connectionTimeoutMillis: number
}

/** Default connection values shown in the form. */
export const DEFAULT_CONNECTION: PgConnectionConfig = {
  host: 'localhost',
  port: 5432,
  user: 'postgres',
  password: '',
  database: 'postgres',
  poolMax: 10,
  connectionTimeoutMillis: 0,
}

/** The settings namespace the console registers and reads. */
export const SETTINGS_NAMESPACE = 'pg-backends'

/** HTTP API root the host plugin serves (mirrors better-sidebar's /sidebar/api pattern). */
export const API_ROOT = '/pg-console/api'

/** One test-connection request body. */
export interface ConnectionTestRequest {
  config: PgConnectionConfig
}

/** One test-connection response. */
export interface ConnectionTestResult {
  ok: boolean
  /** Round-trip latency in milliseconds, when the connection succeeded. */
  latencyMs?: number
  /** Failure message, when the connection failed. */
  error?: string
}

/** Read-back of saved settings (password always redacted to ''). */
export interface ConnectionSavedResult {
  saved: boolean
  /** Version of the settings document after the write. */
  revision?: number
}

export type MigrationDirection = 'jsonl-to-pg' | 'pg-to-jsonl'

/**
 * Conflict policy for a session whose target already holds events:
 * - `skip` (default): target already synced → report up-to-date, no writes;
 *   target has MORE than source → report the ahead-delta as a hint, no writes.
 * - `overwrite`: rebuild the target session wholesale from the source
 *   (delete the target's rows, then append the full source log). Only
 *   supported when PostgreSQL is the TARGET (jsonl→pg); the reverse
 *   direction never deletes the JSONL side.
 * - `clone`: if inserting under the source id would collide with existing
 *   target content, import under a fresh id (source content preserved,
 *   identity changed) instead of failing.
 */
export type MigrationConflictPolicy = 'skip' | 'overwrite' | 'clone'

/** One migration run request. */
export interface MigrationStartRequest {
  direction: MigrationDirection
  /** Overrides the settings-stored connection; absent uses the saved config. */
  config?: PgConnectionConfig
  /** When true, scan and report without writing anything. */
  dryRun: boolean
  /** Conflict handling when the target already holds this session. Default: 'skip'. */
  onConflict?: MigrationConflictPolicy
}

/** Per-session migration outcome. */
export interface MigrationSessionResult {
  /** Source session id that was (or would be) migrated. */
  sessionId: string
  /** Events read from the source and written (or counted) for this session. */
  events: number
  /** Why the session was skipped; absent = migrated (or would migrate). */
  skipped?: string
  /** Failure message; absent = success. */
  error?: string
  /** When the target held more events than the source (direction hint). */
  targetAhead?: number
  /** The id actually written when a conflict was cloned under a fresh id. */
  clonedTo?: string
  /** Whether the target was rebuilt wholesale (overwrite policy). */
  overwritten?: boolean
}

/** One migration run report. */
export interface MigrationStartResult {
  ok: boolean
  direction: MigrationDirection
  dryRun: boolean
  /** Conflict policy applied. */
  onConflict: MigrationConflictPolicy
  /** Sessions that migrated (or would migrate). */
  sessions: MigrationSessionResult[]
  /** Sum of events across successful sessions. */
  eventsTotal: number
  /** Total sessions the source holds (including skipped). */
  sourceTotal: number
  /** Aggregate failure message when the run itself failed. */
  error?: string
}

/** The console API surface (method name → handler). */
export interface ConsoleApi {
  'connection.test': (req: ConnectionTestRequest) => Promise<ConnectionTestResult>
  'connection.save': (req: { config: PgConnectionConfig }) => Promise<ConnectionSavedResult>
  'connection.get': () => Promise<{ config: PgConnectionConfig }>
  'migrate.start': (req: MigrationStartRequest) => Promise<MigrationStartResult>
  'storage.list': (req: StorageListRequest) => Promise<StorageListResult>
  'storage.migrate': (req: StorageMigrateRequest) => Promise<StorageMigrateResult>
}

// ── Storage-domain migration (JSON ⇄ PostgreSQL KV backend) ─────────────────

/**
 * One side's view of a unit, for the side-by-side comparison the console
 * renders before a migration. `present` is false when this side holds no
 * trace of the unit (e.g. PG has no row in `kv_units` for it).
 */
export interface StorageUnitSide {
  present: boolean
  version?: number
  recordCount?: number
  /** Whether the unit carries a written global singleton. */
  hasGlobal?: boolean
  /** Read failure for this unit on this side (e.g. a corrupt JSON file). */
  error?: string
}

/** One unit row in the storage comparison. */
export interface StorageUnitEntry {
  name: string
  json: StorageUnitSide
  pg: StorageUnitSide
}

/** `storage.list` request body. */
export interface StorageListRequest {
  config?: PgConnectionConfig
}

/** `storage.list` response: both sides' unit inventories joined by name. */
export interface StorageListResult {
  ok: boolean
  units: StorageUnitEntry[]
  /** JSON root directory the file side was read from. */
  jsonRoot: string
  /** Aggregate failure message when the listing itself failed. */
  error?: string
}

/** Storage migration direction. */
export type StorageMigrationDirection = 'json-to-pg' | 'pg-to-json'

/**
 * Conflict policy for a unit the target already holds:
 * - `skip` (default): target already present → report up-to-date, no writes.
 * - `overwrite`: clear the target unit's records + global, then import the
 *   source wholesale. Symmetric — works in both directions.
 */
export type StorageConflictPolicy = 'skip' | 'overwrite'

/**
 * One unit's migration outcome. `skipped` is absent when the unit was
 * imported; `error` is absent on success.
 */
export interface StorageUnitResult {
  name: string
  /** Records written (or counted, in dry-run) for this unit. */
  records: number
  /** Whether this unit carries a global singleton that was (or would be) migrated. */
  hasGlobal: boolean
  /** Why the unit was skipped; absent = imported (or would import). */
  skipped?: string
  /** Failure message; absent = success. */
  error?: string
  /** Present when the target was rebuilt wholesale (overwrite policy). */
  overwritten?: boolean
}

/** `storage.migrate` request body. */
export interface StorageMigrateRequest {
  direction: StorageMigrationDirection
  /** Overrides the settings-stored connection; absent uses the saved config. */
  config?: PgConnectionConfig
  /** When true, scan and report without writing anything. */
  dryRun: boolean
  /** Conflict handling when the target already holds this unit. Default: 'skip'. */
  onConflict?: StorageConflictPolicy
  /**
   * Only applies to `json-to-pg` migration of the `workspace` unit: writes
   * the PostgreSQL side's global with `initialized: false` and an empty
   * `workspaceIds` so the WorkspaceRegistry re-bootstraps `sessionIds` from
   * the (now-PostgreSQL) session store on next startup. This is how the
   * "Ungrouped sessions" symptom is actually resolved after migration.
   * Default: false (preserve the stored global verbatim).
   */
  rebootstrap?: boolean
}

/** `storage.migrate` response: per-unit outcomes plus aggregates. */
export interface StorageMigrateResult {
  ok: boolean
  direction: StorageMigrationDirection
  dryRun: boolean
  onConflict: StorageConflictPolicy
  rebootstrap: boolean
  units: StorageUnitResult[]
  /** Sum of records across imported units. */
  recordsTotal: number
  /** Total units on the source side (including skipped). */
  sourceTotal: number
  /** Aggregate failure message when the run itself failed. */
  error?: string
}