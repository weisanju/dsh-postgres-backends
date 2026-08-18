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

/** One migration run request. */
export interface MigrationStartRequest {
  direction: MigrationDirection
  /** Overrides the settings-stored connection; absent uses the saved config. */
  config?: PgConnectionConfig
  /** When true, scan and report without writing anything. */
  dryRun: boolean
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
}

/** One migration run report. */
export interface MigrationStartResult {
  ok: boolean
  direction: MigrationDirection
  dryRun: boolean
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
}