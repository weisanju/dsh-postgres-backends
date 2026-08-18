/**
 * Schema + name helpers for the PostgreSQL KV storage backend. Unit identity
 * lives in `kv_units` (one row per opened unit, stamped with the unit's
 * descriptor version); each unit's global singleton lives in
 * `kv_unit_globals`; records live one-per-row in `kv_<unit>_<table>` tables
 * created per descriptor. The `kv_` prefix keeps this backend's tables
 * disjoint from the session-persistence tables (`sessions`/`events`) that
 * share the same database.
 * @module dsh-storage-postgres/schema
 */

/**
 * Metadata tables applied to the database on backend open. Record tables are
 * created per descriptor in `index.ts`.
 */
export const DDL = `
CREATE TABLE IF NOT EXISTS kv_units (
  name    TEXT PRIMARY KEY,
  version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kv_unit_globals (
  unit  TEXT PRIMARY KEY REFERENCES kv_units(name),
  value JSONB NOT NULL
);
`

/**
 * Physical table name for one unit table. Both segments are validated against
 * `UNIT_NAME_RE` before reaching this, so the result is safe to interpolate
 * into DDL and statement text.
 * @param unit - Validated unit name.
 * @param table - Validated table name.
 * @returns the `kv_<unit>_<table>` identifier.
 */
export function recordTableName(unit: string, table: string): string {
  return `kv_${unit}_${table}`
}

/**
 * DDL creating one unit's record table. Both name segments are validated, so
 * the identifier is safe to interpolate.
 */
export function recordTableDdl(unit: string, table: string): string {
  return `
    CREATE TABLE IF NOT EXISTS ${recordTableName(unit, table)} (
      key   TEXT PRIMARY KEY,
      value JSONB NOT NULL
    )
  `
}
