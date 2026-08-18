/**
 * Schema + load-time helpers for the PostgreSQL session-persistence backend:
 * batch-stored events (multiple events per row via JSONB array) to reduce
 * row count and primary-key index size.
 *
 * @module dsh-session-persistence-postgres/schema
 */

import type { SessionEvent, SessionId, SessionHeader, SurfaceOp } from '@deepseek-ai/dsh-session'

/**
 * The on-disk schema version. Bumped only on a breaking change to the table
 * layout; orthogonal to a session's own `version` (which versions the EVENT
 * vocabulary, stored per session in the `sessions` row).
 */
export const SCHEMA_VERSION = 2

/** Events per batch row. */
export const BATCH_SIZE = 100

/** The SQL schema applied to a fresh database. */
export const DDL = `
CREATE TABLE IF NOT EXISTS persistence_state (
  singleton      INTEGER PRIMARY KEY CHECK (singleton = 1),
  store_id       TEXT NOT NULL,
  schema_version INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  id               TEXT PRIMARY KEY,
  version          INTEGER NOT NULL,
  created_at       BIGINT NOT NULL,
  cwd              TEXT,
  parent_session   TEXT,
  seed_length      INTEGER,
  origin           TEXT,
  delegation_depth INTEGER,
  agent_preset     TEXT,
  incarnation      TEXT NOT NULL,
  revision         BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq_start     INTEGER NOT NULL,
  seq_end       INTEGER NOT NULL,
  events_jsonb  JSONB NOT NULL,
  PRIMARY KEY (session_id, seq_start)
);
`

/** A row of the `sessions` table — the out-of-log metadata (SessionHeader). */
export interface SessionRow {
  id: string
  version: number
  created_at: number
  cwd: string | null
  parent_session: string | null
  seed_length: number | null
  origin: 'subagent' | null
  /** Stable identity assigned when this log is materialized. */
  incarnation: string
  /** Monotonic log-change token incremented in each mutating transaction. */
  revision: number
  delegation_depth: number | null
  agent_preset: string | null
}

/** One event inside a batch row's `events_jsonb` array. */
export interface BatchEvent {
  seq: number
  type: string
  time: number
  data: unknown
  sourceEventSeqs?: number[]
  surfaceOp?: SurfaceOp
}

/** Flattened event row consumed by `scanRows`. */
export interface EventRow {
  seq: number
  type: string
  time: number
  data: string
  /** JSON-encoded number[] — the event's sourceEventSeqs, or null. */
  source_event_seqs: string | null
  /** JSON-encoded SurfaceOp — how the event entered the surface, or null. */
  surface_op: string | null
}

/** PG returns BIGINT as string — normalize to a JS safe integer. */
function toInt(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : (value as number)
  if (!Number.isSafeInteger(n)) {
    throw new Error(`stored integer ${String(value)} is not a safe integer`)
  }
  return n
}

/**
 * PostgreSQL text/JSONB cannot store the NUL byte (U+0000) — `jsonb_in`
 * rejects `\u0000` escapes with `22P05 unsupported Unicode escape sequence`
 * (`\u0000 cannot be converted to text`). DSH event data legitimately carries
 * NUL as an internal separator (e.g. agent-instructions `source.changes[].scope`
 * is `".\u0000AGENTS.md"`), and the file backends store it verbatim, so the PG
 * backend must round-trip it.
 *
 * Escape scheme (bijective, applied per string value before JSON encoding):
 *   - U+0000            → the 6-char literal `\u0000`
 *   - literal `\u0000`  → the 7-char literal `\\u0000`
 * Object **keys** are escaped with the same scheme (PG rejects NUL there too).
 * `unescapeNulText` inverts both in one pass, so an original literal
 * `\u0000` cannot be confused with an escaped NUL.
 */
export function escapeNulText(value: unknown): unknown {
  if (typeof value === 'string') {
    if (!value.includes('\\') && !value.includes('\u0000')) return value
    let out = ''
    for (let i = 0; i < value.length; i++) {
      const ch = value[i]
      if (ch === '\\' && value.startsWith('\\u0000', i)) {
        out += '\\\\u0000'
        i += 5
      } else if (ch === '\u0000') {
        out += '\\u0000'
      } else {
        out += ch
      }
    }
    return out
  }
  if (Array.isArray(value)) return value.map(escapeNulText)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      out[String(escapeNulText(key))] = escapeNulText(item)
    }
    return out
  }
  return value
}

/** Inverse of {@link escapeNulText} — applied to data parsed back from JSONB. */
export function unescapeNulText(value: unknown): unknown {
  if (typeof value === 'string') {
    if (!value.includes('\\') && !value.includes('\u0000')) return value
    let out = ''
    for (let i = 0; i < value.length; i++) {
      const ch = value[i]
      if (ch === '\\' && value.startsWith('\\\\u0000', i)) {
        out += '\\u0000'
        i += 6
      } else if (ch === '\\' && value.startsWith('\\u0000', i)) {
        out += '\u0000'
        i += 5
      } else {
        out += ch
      }
    }
    return out
  }
  if (Array.isArray(value)) return value.map(unescapeNulText)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      out[String(unescapeNulText(key))] = unescapeNulText(item)
    }
    return out
  }
  return value
}

// --- Batch <-> EventRow conversion ---

/**
 * Convert a single SessionEvent into a JSON-serializable object for the batch
 * array. Envelope fields (sourceEventSeqs, surfaceOp) are included when present.
 */
export function eventToBatchEvent(event: SessionEvent): BatchEvent {
  const se = event as SessionEvent & { surfaceOp?: unknown; sourceEventSeqs?: unknown }
  const obj: BatchEvent = {
    seq: event.seq,
    type: event.type,
    time: event.time,
    data: escapeNulText(event.data),
  }
  if (se.sourceEventSeqs !== undefined) obj.sourceEventSeqs = se.sourceEventSeqs as number[]
  if (se.surfaceOp !== undefined) obj.surfaceOp = se.surfaceOp as SurfaceOp
  return obj
}

/**
 * Convert a batch event object (parsed from JSONB) to an EventRow consumed by
 * scanRows. The `data` field is JSON-stringified so scanRows can parse it back
 * (mirrors the JSONB::text cast in the old per-row schema).
 */
export function batchEventToEventRow(e: BatchEvent): EventRow {
  return {
    seq: e.seq,
    type: e.type,
    time: e.time,
    data: JSON.stringify(e.data),
    source_event_seqs: e.sourceEventSeqs !== undefined ? JSON.stringify(e.sourceEventSeqs) : null,
    surface_op: e.surfaceOp !== undefined ? JSON.stringify(e.surfaceOp) : null,
  }
}

// --- SessionHeader / scanRows (unchanged, kept for reference) ---

/**
 * Reconstruct the SessionHeader from a `sessions` row.
 * @param row - the `sessions` table row.
 * @returns the header, NULL columns mapped to omitted optional fields.
 */
export function rowToMeta(row: SessionRow): SessionHeader {
  const createdAt = toInt(row.created_at)
  const seedLength = row.seed_length === null ? undefined : toInt(row.seed_length)
  const delegationDepth = row.delegation_depth === null ? undefined : toInt(row.delegation_depth)
  return {
    version: toInt(row.version),
    id: row.id as SessionId,
    createdAt,
    ...row.cwd !== null ? { cwd: row.cwd } : {},
    ...row.parent_session !== null ? { parentSession: row.parent_session as SessionId } : {},
    ...seedLength !== undefined ? { seedLength } : {},
    ...row.origin !== null ? { origin: row.origin } : {},
    ...delegationDepth !== undefined ? { delegationDepth } : {},
    ...row.agent_preset !== null ? { agentPreset: row.agent_preset } : {},
  }
}

/**
 * Reconstruct a SessionEvent from an `events` row (parses JSON columns).
 * @param row - the `events` table row.
 * @returns the reconstructed event.
 */
export function rowToEvent(row: EventRow): SessionEvent {
  return {
    type: row.type as SessionEvent['type'],
    seq: toInt(row.seq),
    time: toInt(row.time),
    data: unescapeNulText(JSON.parse(row.data)) as SessionEvent['data'],
    ...row.source_event_seqs !== null ? { sourceEventSeqs: JSON.parse(row.source_event_seqs) as number[] } : {},
    ...row.surface_op !== null ? { surfaceOp: JSON.parse(row.surface_op) as SurfaceOp } : {},
  } as SessionEvent
}

/**
 * Find the preserved prefix of ordered event rows (same algorithm as the
 * SQLite/JSONL backends). Fully written rows in an interrupted final turn
 * remain in the prefix. The first unparsable row or seq gap after the last
 * `turn/end` marks a tolerated torn tail; the same hole in the committed
 * region rejects.
 *
 * @param rows - one session's event rows, ordered by seq ascending.
 * @param base - the seq the first row is expected to carry; 0 for a whole
 *   log, the requested fromSeq for a suffix read.
 * @returns the preserved event prefix plus tornFrom (seq the physical delete
 *   starts at) when a torn tail exists.
 */
export function scanRows(rows: readonly EventRow[], base = 0): { preserved: SessionEvent[]; tornFrom?: number } {
  interface Parsed { ok: boolean; event?: SessionEvent }
  const parsed: Parsed[] = rows.map((row) => {
    try {
      return { ok: true, event: rowToEvent(row) }
    } catch {
      return { ok: false }
    }
  })

  let lastTurnEnd = -1
  for (let i = parsed.length - 1; i >= 0; i--) {
    if (parsed[i]?.ok && rows[i]?.type === 'turn/end') { lastTurnEnd = i; break }
  }

  const preserved: SessionEvent[] = []
  for (let i = 0; i < rows.length; i++) {
    const p = parsed[i]
    if (!p?.ok || p.event === undefined) {
      if (i <= lastTurnEnd) throw new Error(`corrupt session log: unparsable committed event at seq ${rows[i]?.seq}`)
      break
    }
    if (p.event.seq !== base + i) {
      if (i <= lastTurnEnd) throw new Error(`corrupt session log: seq gap in committed region (expected ${base + i}, got ${p.event.seq})`)
      break
    }
    preserved.push(p.event)
  }

  return preserved.length < rows.length ? { preserved, tornFrom: base + preserved.length } : { preserved }
}