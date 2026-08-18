/**
 * PG console — host half. Registers the `/pg-console/api` HTTP surface
 * (connection test/save + bidirectional session migration between the
 * official JSONL backend and this package's PostgreSQL backend) and a
 * `pg-backends` settings namespace for the connection form.
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
import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { join } from 'node:path'
import { JsonlSessionPersistence } from '@deepseek-ai/dsh-session-persistence-jsonl'
import { PostgresSessionPersistence } from '../index.ts'
import { SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import {
  API_ROOT,
  DEFAULT_CONNECTION,
  SETTINGS_NAMESPACE,
  type ConsoleApi,
  type ConnectionTestResult,
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
    password: config.password,
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
  targetCreate: (meta: SessionHeader) => Promise<void>
  targetAppend: (id: SessionId, events: SessionEvent[]) => Promise<void>
  close: () => Promise<void>
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
      targetCreate: meta => pg.create(meta),
      targetAppend: (id, events) => pg.append(id, events),
      close: async () => { await pg.close() },
    }
  }
  return {
    sourceList: () => pg.list(),
    sourceRead: async (id: SessionId) => {
      const { meta, events } = await pg.readFrom(id, 0)
      return { meta, events }
    },
    targetCreate: meta => json.create(meta),
    targetAppend: (id, events) => json.append(id, events),
    close: async () => { await pg.close() },
  }
}

/** Run one migration (or dry-run scan) in the given direction. */
async function migrate(
  ctx: Context,
  direction: MigrationDirection,
  config: PgConnectionConfig,
  dryRun: boolean,
): Promise<MigrationStartResult> {
  const endpoints = await endpointsFor(ctx, direction, config)
  const result: MigrationStartResult = {
    ok: true,
    direction,
    dryRun,
    sessions: [],
    eventsTotal: 0,
    sourceTotal: 0,
  }
  try {
    const headers = await endpoints.sourceList()
    result.sourceTotal = headers.length
    for (const header of headers) {
      const session: MigrationSessionResult = { sessionId: header.id, events: 0 }
      try {
        const { meta, events } = await endpoints.sourceRead(header.id)
        session.events = events.length
        if (!dryRun) {
          await endpoints.targetCreate(meta)
          await endpoints.targetAppend(meta.id, events)
        }
        result.eventsTotal += events.length
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // A target that already holds this session is an idempotent skip
        // (the coordinator refuses duplicate ids), not a failure — re-running
        // a migration after a partial success must not count as an error.
        if (/already has a persisted log on disk/.test(message) || /already exists in this backend/.test(message)) {
          session.skipped = 'target already has this session'
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

/** The console host plugin body. Depends on settings (connection form) and webServer (API routes). */
export function apply(ctx: Context): void {
  ctx.inject(['settings', 'sessions'], (sctx) => {
    // Settings namespace for the connection form.
    const settings = sctx.settings.register(settingsNamespace(SETTINGS_NAMESPACE), z.object({
      host: z.string(),
      port: z.natural(),
      user: z.string(),
      password: z.string(),
      database: z.string(),
      poolMax: z.natural(),
      connectionTimeoutMillis: z.natural(),
    }))

    /** Saved connection (password kept in the document, redacted on the wire) or defaults. */
    const savedConfig = (): PgConnectionConfig => {
      const value = settings.get()
      return {
        host: String(value.host ?? DEFAULT_CONNECTION.host),
        port: Number(value.port ?? DEFAULT_CONNECTION.port),
        user: String(value.user ?? DEFAULT_CONNECTION.user),
        password: String(value.password ?? ''),
        database: String(value.database ?? DEFAULT_CONNECTION.database),
        poolMax: Number(value.poolMax ?? DEFAULT_CONNECTION.poolMax),
        connectionTimeoutMillis: Number(value.connectionTimeoutMillis ?? DEFAULT_CONNECTION.connectionTimeoutMillis),
      }
    }

    const api: ConsoleApi = {
      'connection.test': async req => testConnection(sctx, req.config),
      'connection.get': async () => {
        // Never ship the secret back: blank the password on the wire.
        const { password: _password, ...rest } = savedConfig()
        return { config: { ...rest, password: '' } }
      },
      'connection.save': async req => {
        await settings.update(req.config)
        return { saved: true }
      },
      'migrate.start': async req => {
        const config = req.config ?? savedConfig()
        if (config.host === '' || config.user === '') {
          return { ok: false, direction: req.direction, dryRun: req.dryRun, sessions: [], eventsTotal: 0, sourceTotal: 0, error: 'connection config is incomplete' }
        }
        return migrate(sctx, req.direction, config, req.dryRun)
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
    settings: import('@deepseek-ai/dsh-settings').SettingsProvider
    webServer: import('@deepseek-ai/dsh-host-webserver').WebServer
    webRuntime?: { trustedHosts: readonly string[] }
  }
}