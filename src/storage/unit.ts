/**
 * One opened PostgreSQL KV unit: document-per-row record tables
 * `kv_<unit>_<table>` plus this unit's row in the shared `kv_unit_globals`
 * table. Each primitive is a single statement, so atomicity comes from
 * PostgreSQL itself — no explicit transactions, and no write queue (write
 * ordering is the caller's responsibility per the KV contract, mirroring the
 * SQLite backend).
 *
 * Values travel as JSON text and land in JSONB columns; string values pass
 * through the NUL escape scheme (PostgreSQL text cannot store U+0000) shared
 * with the session-persistence backend.
 * @module dsh-storage-postgres/unit
 */

import type pg from 'pg'
import { StorageError } from '@deepseek-ai/dsh-storage'
import type { KvUnit, KvUnitDescriptor } from '@deepseek-ai/dsh-storage'
import { escapeNulText, unescapeNulText } from '../schema.ts'
import { recordTableName } from './schema.ts'

/**
 * The PostgreSQL {@link KvUnit}. Constructed by the backend AFTER the unit's
 * record tables exist; statements are plain `pool.query` calls (pg has no
 * prepared-statement handle API like node:sqlite's, and the text is constant
 * per table so the server plans once per session).
 */
export class PostgresKvUnit implements KvUnit {
  private closed = false

  /**
   * @param pool - Connection pool owned by the backend (never ended here).
   * @param descriptor - Validated descriptor whose record tables already exist.
   * @param onClose - Backend callback releasing this unit's open-name slot.
   */
  constructor(
    private readonly pool: pg.Pool,
    private readonly descriptor: KvUnitDescriptor,
    private readonly onClose: () => void,
  ) {}

  async loadAll(): Promise<{ tables: Record<string, Record<string, unknown>>; global: unknown }> {
    this.assertOpen()
    const tables: Record<string, Record<string, unknown>> = {}
    for (const table of this.descriptor.tables) {
      // Null prototype: record keys are arbitrary strings, so '__proto__'
      // must land as an own property instead of mutating the prototype.
      const records: Record<string, unknown> = Object.create(null) as Record<string, unknown>
      const result = await this.pool.query<{ key: string; value: unknown }>(
        `SELECT key, value FROM ${recordTableName(this.descriptor.name, table)}`,
      )
      for (const row of result.rows) {
        records[row.key] = this.parseValue(row.value, `table '${table}' key '${row.key}'`)
      }
      tables[table] = records
    }
    let global: unknown = null
    if (this.descriptor.hasGlobal) {
      const result = await this.pool.query<{ value: unknown }>(
        'SELECT value FROM kv_unit_globals WHERE unit = $1',
        [this.descriptor.name],
      )
      if (result.rows.length > 0) global = this.parseValue(result.rows[0]!.value, 'global slot')
    }
    return { tables, global }
  }

  async putRecord(table: string, key: string, value: unknown): Promise<void> {
    this.assertOpen()
    const text = this.encodeValue(value, `table '${table}' key '${key}'`)
    await this.pool.query(
      `INSERT INTO ${recordTableName(this.descriptor.name, this.tableOrThrow(table))}
         (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      [key, text],
    )
  }

  async deleteRecord(table: string, key: string): Promise<void> {
    this.assertOpen()
    await this.pool.query(
      `DELETE FROM ${recordTableName(this.descriptor.name, this.tableOrThrow(table))} WHERE key = $1`,
      [key],
    )
  }

  async setGlobal(value: unknown): Promise<void> {
    this.assertOpen()
    if (!this.descriptor.hasGlobal) {
      throw new Error(`kv unit '${this.descriptor.name}' declared no global slot`)
    }
    const text = this.encodeValue(value, 'global slot')
    await this.pool.query(
      `INSERT INTO kv_unit_globals (unit, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (unit) DO UPDATE SET value = excluded.value`,
      [this.descriptor.name, text],
    )
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true
      this.onClose()
    }
  }

  /** JSON-encode one value with the NUL escape applied to its strings. */
  private encodeValue(value: unknown, slot: string): string {
    try {
      return JSON.stringify(escapeNulText(value))
    } catch (error) {
      if (!(error instanceof Error)) throw error
      throw new StorageError(
        'malformed-medium',
        `kv unit '${this.descriptor.name}' cannot serialize value at ${slot}: ${error.message}`,
        { cause: error },
      )
    }
  }

  /**
   * Parse one stored JSONB value, mapping failure to `malformed-medium`.
   *
   * pg parses JSONB columns itself: objects/arrays/numbers arrive as JS
   * values, but a top-level JSON *string* arrives as its unquoted contents
   * (pg's `jsonb` parser returns the string scalar directly). So a JS string
   * here is ambiguous — it is either a stored top-level string whose quotes
   * were stripped, or (never, for JSONB) raw text. Re-quote and re-parse to
   * recover the exact stored string; anything that still fails to parse was
   * never valid JSON.
   */
  private parseValue(value: unknown, slot: string): unknown {
    const raw = typeof value === 'string' ? this.parseJson(`"${this.escapeQuotes(value)}"`, slot) : value
    return unescapeNulText(raw)
  }

  private parseJson(text: string, slot: string): unknown {
    try {
      return JSON.parse(text)
    } catch (error) {
      throw new StorageError(
        'malformed-medium',
        `kv unit '${this.descriptor.name}' holds unparsable JSON at ${slot}`,
        { cause: error },
      )
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new StorageError('closed', `kv unit '${this.descriptor.name}' is closed`)
    }
  }

  /** Escape the two characters JSON strings quote (for re-quoting a pg-decoded scalar). */
  private escapeQuotes(text: string): string {
    return text.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
  }

  private tableOrThrow(table: string): string {
    if (!this.descriptor.tables.includes(table)) {
      throw new Error(`kv unit '${this.descriptor.name}' declared no table '${table}'`)
    }
    return table
  }
}
