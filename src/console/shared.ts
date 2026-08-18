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
  /** Stored in settings.yaml with role('secret') masking; never returned to the client after save. */
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

/**
 * Automatic incremental sync (JSONL → PostgreSQL) configuration. When
 * enabled, the console host re-runs the incremental migration on an
 * interval, so the PG copy stays near the live JSONL source without manual
 * runs. The source is read-only and the target write is a contiguous
 * append, so this is safe alongside a running instance; a run that is
 * still in flight when the next tick fires is skipped (no overlap).
 */
export interface AutoSyncConfig {
  /** Master switch. */
  enabled: boolean
  /** Interval between sync runs, in minutes (>= 1). */
  intervalMinutes: number
}

/** The autoSync settings values as stored (with defaults applied). */
export const DEFAULT_AUTO_SYNC: AutoSyncConfig = {
  enabled: false,
  intervalMinutes: 5,
}

/** Latest automatic-sync outcome, surfaced by autosync.status. */
export interface AutoSyncStatus {
  /** Whether auto sync is armed (enabled + interval > 0). */
  armed: boolean
  /** Interval in minutes. */
  intervalMinutes: number
  /** When the last run started, as epoch ms; absent = never ran. */
  lastRunAt?: number
  /** When the last run finished, as epoch ms. */
  lastFinishedAt?: number
  /** True when a run was skipped because the previous one was still going. */
  skippedOverlap?: boolean
  /** Result of the last run (reports are transient, memory-only). */
  lastResult?: MigrationStartResult
  /** Free-form failure from the last attempt. */
  lastError?: string
}

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
  'autosync.set': (req: { config: AutoSyncConfig }) => Promise<{ saved: boolean }>
  'autosync.get': () => Promise<{ config: AutoSyncConfig }>
  'autosync.status': () => Promise<AutoSyncStatus>
}