/**
 * PG console — host half. Registers the `/pg-console/api` HTTP surface
 * (connection test/save + bidirectional session migration between the
 * official JSONL backend and this package's PostgreSQL backend). The
 * connection form values persist in `~/.dsh/pg-console.json`.
 *
 * Design notes:
 * - Both backends are constructed on `ctx.isolate('sessionPersistence')`
 *   child scopes so their `super(ctx, 'sessionPersistence')` registrations
 *   never collide with the mounted runtime backend (or with each other).
 *   Their coordinators install write-path listeners on the child scope,
 *   which receive no events from the parent scope — the isolated instances
 *   are read/write engines only, not a mounted persistence provider.
 * - Migration moves events via the public coordinator surface
 *   (`list`/`readFrom` on the source, `create`+`append` on the target), so
 *   contiguity/validation/versions are enforced by the same code the live
 *   runtime uses. The source is never deleted: a run is additive.
 * - The API fence mirrors dsh-better-sidebar: loopback or LAN-trusted host
 *   plus same-origin browser markers, POST only, JSON bodies.
 */

import { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { dirname, join } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { JsonlSessionPersistence } from '@deepseek-ai/dsh-session-persistence-jsonl'
import { PostgresSessionPersistence } from '../index.ts'
import { SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import {
  API_ROOT,
  DEFAULT_CONNECTION,
  type ConsoleApi,
  type ConnectionTestResult,
  type MigrationConflictPolicy,
  type MigrationDirection,
  type MigrationSessionResult,
  type MigrationStartResult,
  type PgConnectionConfig,
} from './shared.ts'

/** JSONL document root: the harness-home sessions directory (same as the base bundle default). */
function jsonlRoot(): string {
  return join(resolveDshHome(), 'sessions')
}

/** Build an isolated JSONL backend (never registered on the parent scope). */
function isolatedJsonlBackend(ctx: Context): JsonlSessionPersistence {
  const child = ctx.isolate('sessionPersistence')
  return new JsonlSessionPersistence(child, { root: jsonlRoot() })
}

/** Build an isolated PG backend from a connection config. */
function isolatedPgBackend(ctx: Context, config: PgConnectionConfig): PostgresSessionPersistence {
  const child = ctx.isolate('sessionPersistence')
  return new PostgresSessionPersistence(child, {
    host: config.host,
    port: config.port,
    user: config.user,
    // A blank stored password means "not configured yet" → fall back to the
    // same default the overlay uses, so an auto-sync run before the form is
    // saved cannot crash the process with `client password must be a string`.
    password: config.password === '' ? DEFAULT_CONNECTION.password || 'postgres' : config.password,
    database: config.database,
    poolMax: config.poolMax,
    connectionTimeoutMillis: config.connectionTimeoutMillis,
  })
}

/** Test one connection: a minimal round-trip read against the sessions table. */
async function testConnection(ctx: Context, config: PgConnectionConfig): Promise<ConnectionTestResult> {
  let pg: PostgresSessionPersistence | undefined
  try {
    pg = isolatedPgBackend(ctx, { ...config, connectionTimeoutMillis: 3000 })
    const started = performance.now()
    await pg.list()
    return { ok: true, latencyMs: Math.round(performance.now() - started) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    await pg?.close()
  }
}

/** One direction's source and target accessors. */
interface MigrationEndpoints {
  sourceList: () => Promise<SessionHeader[]>
  sourceRead: (id: SessionId) => Promise<{ meta: SessionHeader; events: SessionEvent[] }>
  /** Read the target's committed log for one id (fails with 'not found' when absent). */
  targetRead: (id: SessionId) => Promise<{ meta: SessionHeader; events: SessionEvent[] }>
  targetCreate: (meta: SessionHeader) => Promise<void>
  targetAppend: (id: SessionId, events: SessionEvent[]) => Promise<void>
  /**
   * Delete one target session's rows wholesale (overwrite policy). Only the
   * PostgreSQL target implements this; the JSONL target refuses (the reverse
   * direction must never delete the production side, and the official JSONL
   * backend exposes no delete surface).
   */
  targetReset: (id: SessionId) => Promise<void>
  close: () => Promise<void>
}

/** Whether the overwrite policy can run for this direction (PG must be the target). */
function overwriteSupported(direction: MigrationDirection): boolean {
  return direction === 'jsonl-to-pg'
}

/** The id used when cloning a colliding session under a fresh identity. */
function cloneId(id: string): string {
  return `${id}-clone`
}

/** Build the two isolated backend endpoints for one migration direction. */
async function endpointsFor(
  ctx: Context,
  direction: MigrationDirection,
  config: PgConnectionConfig,
): Promise<MigrationEndpoints> {
  const json = isolatedJsonlBackend(ctx)
  const pg = isolatedPgBackend(ctx, config)
  if (direction === 'jsonl-to-pg') {
    return {
      sourceList: () => json.list(),
      sourceRead: async (id: SessionId) => {
        const { meta, events } = await json.readFrom(id, 0)
        return { meta, events }
      },
      targetRead: async (id: SessionId) => pg.readFrom(id, 0),
      targetCreate: meta => pg.create(meta),
      targetAppend: (id, events) => pg.append(id, events),
      targetReset: async (id) => { await pg.resetSession(id) },
      close: async () => { await pg.close() },
    }
  }
  return {
    sourceList: () => pg.list(),
    sourceRead: async (id: SessionId) => {
      const { meta, events } = await pg.readFrom(id, 0)
      return { meta, events }
    },
    targetRead: async (id: SessionId) => json.readFrom(id, 0),
    targetCreate: meta => json.create(meta),
    targetAppend: (id, events) => json.append(id, events),
    targetReset: async () => {
      throw new Error('overwrite is only supported when PostgreSQL is the migration target')
    },
    close: async () => { await pg.close() },
  }
}

/** Run one migration (or dry-run scan) in the given direction. */
async function migrate(
  ctx: Context,
  direction: MigrationDirection,
  config: PgConnectionConfig,
  dryRun: boolean,
  onConflict: MigrationConflictPolicy = 'skip',
): Promise<MigrationStartResult> {
  const endpoints = await endpointsFor(ctx, direction, config)
  const result: MigrationStartResult = {
    ok: true,
    direction,
    dryRun,
    onConflict,
    sessions: [],
    eventsTotal: 0,
    sourceTotal: 0,
  }
  try {
    const headers = await endpoints.sourceList()
    result.sourceTotal = headers.length
    for (const header of headers) {
      const session: MigrationSessionResult = { sessionId: header.id, events: 0 }
      let meta!: SessionHeader
      let events!: SessionEvent[]
      try {
        const read = await endpoints.sourceRead(header.id)
        meta = read.meta
        events = read.events
        session.events = events.length
        if (!dryRun) {
          // Read the target's committed length for this id. Absent target:
          // full migration. Present target: apply the conflict policy.
          let targetLen = 0
          let targetAhead = 0
          let targetExists = true
          try {
            const targetLog = await endpoints.targetRead(header.id)
            targetLen = targetLog.events.length
          } catch (error) {
            if (!/not found/.test(error instanceof Error ? error.message : String(error))) throw error
            targetExists = false
          }

          if (!targetExists) {
            // Full migration: create the target lazily, append the whole log.
            await endpoints.targetCreate(meta)
            await endpoints.targetAppend(meta.id, events)
            result.eventsTotal += events.length
          } else if (onConflict === 'clone') {
            // Clone policy: the target already holds this id, so import the
            // source content under a fresh identity and leave the target's
            // copy untouched. seq stays 0..N-1 in the new session, so the
            // fresh id accepts the full log directly.
            const cloned = cloneId(header.id)
            const cloneMeta: SessionHeader = { ...meta, id: cloned as SessionId }
            await endpoints.targetCreate(cloneMeta)
            await endpoints.targetAppend(cloned as SessionId, events)
            session.clonedTo = cloned
            session.skipped = `target id existed; imported under ${cloned}`
            result.eventsTotal += events.length
          } else if (targetLen > events.length) {
            // Direction hint: the target holds MORE than the source. The
            // default policy never deletes, so report the gap honestly.
            session.targetAhead = targetLen - events.length
            if (onConflict === 'overwrite') {
              if (!overwriteSupported(direction)) {
                throw new Error('overwrite is only supported when PostgreSQL is the migration target')
              }
              // Rebuild the target wholesale: delete the row (CASCADE events),
              // then recreate from the source so the target is an exact copy.
              await endpoints.targetReset(meta.id)
              await endpoints.targetCreate(meta)
              await endpoints.targetAppend(meta.id, events)
              session.overwritten = true
              session.skipped = 'target rebuilt from source (overwrite)'
              result.eventsTotal += events.length
            } else {
              session.skipped = `target is ahead by ${session.targetAhead} events (not deleted by default)`
            }
          } else if (targetLen < events.length) {
            // Incremental tail-sync: append only the source suffix past the
            // target's committed length.
            const delta = events.slice(targetLen)
            await endpoints.targetAppend(meta.id, delta)
            result.eventsTotal += delta.length
          } else {
            session.skipped = 'target is up to date'
          }
        } else {
          result.eventsTotal += events.length
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // mask single-session conflicts from the aggregate failure flag
        if (/already has a persisted log on disk/.test(message) || /already exists in this backend/.test(message)) {
          if (onConflict === 'clone') {
            // Colliding identity: import the session under a fresh id so the
            // source content is preserved without touching the target's copy.
            const cloned = cloneId(header.id)
            const cloneMeta: SessionHeader = { ...meta, id: cloned as SessionId }
            await endpoints.targetCreate(cloneMeta)
            await endpoints.targetAppend(cloned as SessionId, events)
            session.clonedTo = cloned
            session.skipped = `target id existed; imported under ${cloned}`
            result.eventsTotal += events.length
            result.sessions.push(session)
            continue
          }
          session.skipped = 'target already has this session'
        } else if (/append seq mismatch/.test(message)) {
          session.skipped = 'source changed mid-run; re-run to pick up the tail'
        } else {
          session.error = message
          result.ok = false
        }
      }
      result.sessions.push(session)
    }
  } catch (error) {
    result.ok = false
    result.error = error instanceof Error ? error.message : String(error)
  } finally {
    await endpoints.close()
  }
  return result
}

/** Whether the request host is loopback — same-origin browser requests qualify. */
function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
}

/** Parse the Host header authority (hostname[:port]). */
function parseAuthority(host: string): { hostname: string } | undefined {
  const withoutBrackets = host.startsWith('[') ? host.slice(1) : host
  const hostname = withoutBrackets.split(']')[0]?.split(':')[0]
  if (hostname === undefined || hostname.length === 0) return undefined
  return { hostname }
}

/** The API fence: loopback host or LAN-trusted authority, same-origin, POST. */
function isTrustedRequest(
  req: import('node:http').IncomingMessage,
  trustedHosts: readonly string[],
): boolean {
  const host = req.headers.host
  if (host === undefined) return false
  const parsed = parseAuthority(host)
  if (parsed === undefined) return false
  if (!isLoopbackHostname(parsed.hostname) && !trustedHosts.includes(parsed.hostname)) return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/** Smallest JSON helpers for the webserver handler. */
function readJson(req: import('node:http').IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, rejectBody) => {
    let text = ''
    req.setEncoding('utf8')
    req.on('data', chunk => { text += String(chunk) })
    req.on('end', () => {
      try {
        resolveBody(text.length === 0 ? {} : JSON.parse(text))
      } catch (error) {
        rejectBody(error)
      }
    })
    req.on('error', rejectBody)
  })
}

function writeJson(
  res: import('node:http').ServerResponse,
  status: number,
  body: unknown,
): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(text)
}

/**
 * The console host plugin body. Depends on sessions (isolated backends) and
 * webServer (API routes).
 *
 * Persistence note: connection settings live in a dedicated JSON file
 * (`~/.dsh/pg-console.json`), NOT in the DSH settings document. The
 * settings.yaml top-level is merged into every cordis plugin's config, so a
 * `pg-backends` namespace block there corrupts the mounted PostgreSQL
 * backend's plugin config (password becomes undefined and `pg.Pool` dies
 * with "client password must be a string"). Keeping console state out of
 * the settings document avoids the hazard entirely; the password file is
 * user-owned and mode-0600.
 */
export function apply(ctx: Context): void {
  ctx.inject(['sessions'], async (sctx) => {
    /** Dedicated JSON store on disk (dsh-home; stable across restarts). */
    const storePath = () => join(resolveDshHome(), 'pg-console.json')

    interface StoreDoc {
      config?: PgConnectionConfig
    }

    let store: StoreDoc = {}

    async function loadStore(): Promise<void> {
      try {
        const text = await readFile(storePath(), 'utf8')
        const parsed = JSON.parse(text) as StoreDoc
        // Take the whole file's shape; password may live in it verbatim.
        store = typeof parsed === 'object' && parsed !== null ? parsed : {}
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          sctx.logger?.warn?.('[pg-console] store read failed: %s', error instanceof Error ? error.message : String(error))
        }
        store = {}
      }
    }

    async function saveStore(): Promise<void> {
      const file = storePath()
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 })
    }

    /** Saved connection (password kept in the file, redacted on the wire) or defaults. */
    const savedConfig = (): PgConnectionConfig => ({
      host: String(store.config?.host ?? DEFAULT_CONNECTION.host),
      port: Number(store.config?.port ?? DEFAULT_CONNECTION.port),
      user: String(store.config?.user ?? DEFAULT_CONNECTION.user),
      password: String(store.config?.password ?? ''),
      database: String(store.config?.database ?? DEFAULT_CONNECTION.database),
      poolMax: Number(store.config?.poolMax ?? DEFAULT_CONNECTION.poolMax),
      connectionTimeoutMillis: Number(store.config?.connectionTimeoutMillis ?? DEFAULT_CONNECTION.connectionTimeoutMillis),
    })

    await loadStore()

    const api: ConsoleApi = {
      'connection.test': async req => testConnection(sctx, req.config),
      'connection.get': async () => {
        // Never ship the secret back: blank the password on the wire.
        const { password: _password, ...rest } = savedConfig()
        return { config: { ...rest, password: '' } }
      },
      'connection.save': async req => {
        store = { ...store, config: req.config }
        await saveStore()
        return { saved: true }
      },
      'migrate.start': async req => {
        const config = req.config ?? savedConfig()
        if (config.host === '' || config.user === '') {
          return { ok: false, direction: req.direction, dryRun: req.dryRun, onConflict: req.onConflict ?? 'skip', sessions: [], eventsTotal: 0, sourceTotal: 0, error: 'connection config is incomplete' }
        }
        return migrate(sctx, req.direction, config, req.dryRun, req.onConflict ?? 'skip')
      },
    }

    sctx.inject(['webServer', 'webRuntime'], (wctx) => {
      wctx.effect(() => wctx.webServer.register({
        kind: 'prefix',
        path: API_ROOT,
        handler: async (req, res) => {
          const trustedHosts = wctx.webRuntime?.trustedHosts ?? []
      if (!isTrustedRequest(req, trustedHosts)) {
        writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
        return
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
      const method = pathname.startsWith(`${API_ROOT}/`) ? pathname.slice(API_ROOT.length + 1) : undefined
      if (method === undefined || method.includes('/')) {
        writeJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown API method' } })
        return
      }
      const handler = api[method as keyof ConsoleApi]
      if (handler === undefined) {
        writeJson(res, 404, { ok: false, error: { code: 'not-found', message: `unknown API method "${method}"` } })
        return
      }
      try {
        const payload = (await readJson(req)) as never
        const value = await handler(payload)
        writeJson(res, 200, { ok: true, value })
      } catch (error) {
        writeJson(res, 500, {
          ok: false,
          error: { code: 'internal', message: error instanceof Error ? error.message : String(error) },
        })
      }
    },
      }), 'dsh-postgres-backends: /pg-console/api routes')
    })
  })
}

export default apply

/** Context surface this console consumes (provided by the host bundles). */
declare module '@deepseek-ai/cordis' {
  interface Context {
    webServer: import('@deepseek-ai/dsh-host-webserver').WebServer
    webRuntime?: { trustedHosts: readonly string[] }
  }
}