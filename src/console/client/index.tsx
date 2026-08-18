/**
 * PG console — client half. Contributes a "PostgreSQL Backends" settings
 * section (slot `settings.section`) to the DSH Settings shell:
 *   - 连接配置: host/port/user/password/database/poolMax, 测试连接 + 保存
 *   - 会话迁移: JSONL → PostgreSQL 和 PostgreSQL → JSONL 双向迁移，支持
 *     dryRun 预览（报告统计，不写）与真实迁移。
 *
 * All writes ride the plugin's own fenced HTTP route (/pg-console/api), the
 * third-party pattern dsh-better-sidebar established (the DSH settings RPC
 * domain does not serve third-party namespaces to configuration clients).
 * The section is declarative: connection state and migration reports live in
 * one local component tree, refreshed from the host on demand.
 */

import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Context } from './context-types.ts'
import {
  API_ROOT,
  DEFAULT_CONNECTION,
  type ConnectionTestResult,
  type MigrationConflictPolicy,
  type MigrationDirection,
  type MigrationSessionResult,
  type MigrationStartResult,
  type PgConnectionConfig,
} from '../shared.ts'
import styles from './index.module.css'

/** Services required before mounting (same runtime contract as other sections). */
export const inject = ['slots', 'locale']

/** One wire failure. */
export class PgConsoleApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

/** One wire envelope. */
interface WireEnvelope<T> {
  ok: boolean
  value?: T
  error?: { code: string; message: string }
}

/** Typed fetch wrapper over the /pg-console JSON API. */
async function call<T>(method: string, payload: unknown): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${API_ROOT}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch (error) {
    throw new PgConsoleApiError('network', error instanceof Error ? error.message : String(error))
  }
  const parsed = (await response.json().catch(() => null)) as WireEnvelope<T> | null
  if (!response.ok || parsed === null || parsed.ok !== true || parsed.value === undefined) {
    throw new PgConsoleApiError(
      parsed?.error?.code ?? 'http',
      parsed?.error?.message ?? `HTTP ${response.status}`,
    )
  }
  return parsed.value
}

/** Connection form model: number fields kept as strings while editing. */
interface FormState {
  host: string
  port: string
  user: string
  password: string
  database: string
  poolMax: string
  connectionTimeoutMillis: string
}

function toForm(config: PgConnectionConfig): FormState {
  return {
    host: config.host,
    port: String(config.port),
    user: config.user,
    password: config.password,
    database: config.database,
    poolMax: String(config.poolMax),
    connectionTimeoutMillis: String(config.connectionTimeoutMillis),
  }
}

function fromForm(form: FormState): PgConnectionConfig {
  return {
    host: form.host.trim(),
    port: Number(form.port) || DEFAULT_CONNECTION.port,
    user: form.user.trim(),
    password: form.password,
    database: form.database.trim(),
    poolMax: Number(form.poolMax) || DEFAULT_CONNECTION.poolMax,
    connectionTimeoutMillis: Number(form.connectionTimeoutMillis) || 0,
  }
}

/** The connection + migration section. */
export function PgConsoleSection(): ReactNode {
  const [touched, setTouched] = useState(false)
  const [form, setForm] = useState<FormState>(() => toForm(DEFAULT_CONNECTION))
  const [test, setTest] = useState<ConnectionTestResult | undefined>()
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | undefined>()
  const [migrating, setMigrating] = useState<MigrationDirection | undefined>()
  const [report, setReport] = useState<MigrationStartResult | undefined>()
  const [migrateError, setMigrateError] = useState<string | undefined>()
  const [onConflict, setOnConflict] = useState<MigrationConflictPolicy>('skip')
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    void call<{ config: PgConnectionConfig }>('connection.get', {})
      .then(({ config }) => {
        if (mounted.current) {
          setForm(toForm({ ...config, password: '' }))
          setTouched(false)
        }
      })
      .catch((error: unknown) => {
        // The saved config is best-effort: fall back to defaults silently.
        if (mounted.current) {
          setSaveError(error instanceof Error ? error.message : String(error))
        }
      })
    return () => { mounted.current = false }
  }, [])

  const config = fromForm(form)
  const dirty = touched

  const runTest = async (): Promise<void> => {
    setTesting(true)
    setTest(undefined)
    try {
      const result = await call<ConnectionTestResult>('connection.test', { config })
      if (mounted.current) setTest(result)
    } catch (error) {
      if (mounted.current) setTest({ ok: false, error: error instanceof Error ? error.message : String(error) })
    } finally {
      if (mounted.current) setTesting(false)
    }
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    setSaveError(undefined)
    try {
      await call<{ saved: boolean }>('connection.save', { config })
      if (mounted.current) {
        setTouched(false)
        setSaveError(undefined)
      }
    } catch (error) {
      if (mounted.current) setSaveError(error instanceof Error ? error.message : String(error))
    } finally {
      if (mounted.current) setSaving(false)
    }
  }

  const runMigration = async (direction: MigrationDirection, dryRun: boolean): Promise<void> => {
    if (migrating !== undefined) return
    setMigrating(direction)
    setMigrateError(undefined)
    setReport(undefined)
    try {
      const result = await call<MigrationStartResult>('migrate.start', { direction, dryRun, onConflict })
      if (mounted.current) setReport(result)
    } catch (error) {
      if (mounted.current) setMigrateError(error instanceof Error ? error.message : String(error))
    } finally {
      if (mounted.current) setMigrating(undefined)
    }
  }

  /** Human-readable conflict policy options. */
  const conflictOptions: { value: MigrationConflictPolicy; label: string; hint: string }[] = [
    { value: 'skip', label: '跳过 (skip)', hint: '目标已有 → 不写；目标更多 → 报告差异' },
    { value: 'overwrite', label: '覆盖 (overwrite)', hint: '删除目标整会话，用源重建（仅 PG 为目标时）' },
    { value: 'clone', label: '新建副本 (clone)', hint: '目标 id 冲突时换新 id 导入，保留目标' },
  ]

  const directionLabel: Record<MigrationDirection, string> = {
    'jsonl-to-pg': 'JSONL → PostgreSQL',
    'pg-to-jsonl': 'PostgreSQL → JSONL',
  }

  const fmtCount = (n: number): string => n.toLocaleString('zh-CN')

  return (
    <div className={styles.section}>
      <p className={styles.intro}>
        PostgreSQL backend 配置与会话迁移。写入走本插件受信的 /pg-console API；迁移只读源、增量写目标，绝不动源数据。
      </p>

      <div className={styles.group}>
        <div className={styles.groupHeading}>
          连接配置
          <span className={styles.count}>host / port / user / database</span>
        </div>
        <div className={styles.grid}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Host</span>
            <input
              className={styles.input}
              value={form.host}
              placeholder="localhost"
              onChange={(e) => { setForm({ ...form, host: e.target.value }); setTouched(true) }}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Port</span>
            <input
              className={`${styles.input} ${styles.number}`}
              type="number"
              value={form.port}
              onChange={(e) => { setForm({ ...form, port: e.target.value }); setTouched(true) }}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>User</span>
            <input
              className={styles.input}
              value={form.user}
              placeholder="postgres"
              onChange={(e) => { setForm({ ...form, user: e.target.value }); setTouched(true) }}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Password</span>
            <input
              className={styles.input}
              type="password"
              value={form.password}
              placeholder="••••••"
              onChange={(e) => { setForm({ ...form, password: e.target.value }); setTouched(true) }}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Database</span>
            <input
              className={styles.input}
              value={form.database}
              placeholder="postgres"
              onChange={(e) => { setForm({ ...form, database: e.target.value }); setTouched(true) }}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Pool 上限</span>
            <input
              className={`${styles.input} ${styles.number}`}
              type="number"
              value={form.poolMax}
              onChange={(e) => { setForm({ ...form, poolMax: e.target.value }); setTouched(true) }}
            />
          </label>
        </div>
        <div className={styles.actions}>
          <button
            className={styles.btn}
            disabled={testing}
            onClick={() => void runTest()}
          >
            {testing ? '测试中…' : '测试连接'}
          </button>
          <button
            className={`${styles.btn} ${styles.primary}`}
            disabled={saving || !dirty}
            onClick={() => void save()}
          >
            {saving ? '保存中…' : '保存配置'}
          </button>
        </div>
        {test !== undefined && (
          <p className={`${styles.status} ${test.ok ? styles.ok : styles.err}`}>
            {test.ok
              ? `✓ 连接成功（${test.latencyMs} ms）`
              : `✗ 连接失败：${test.error ?? 'unknown'}`}
          </p>
        )}
        {saveError !== undefined && (
          <p className={`${styles.status} ${styles.err}`}>{saveError}</p>
        )}
      </div>

      <div className={styles.group}>
        <div className={styles.groupHeading}>
          会话迁移
          <span className={styles.count}>JSONL ⇄ PostgreSQL（源只读，增量写目标）</span>
        </div>
        <div className={styles.row}>
          <div className={styles.rowText}>
            <span className={styles.title}>冲突处理</span>
            <span className={styles.desc}>
              目标已存在同一会话时的行为。默认 skip 最安全；overwrite 重建目标；clone 换新 id 导入。
            </span>
          </div>
          <div className={styles.rowActions}>
            <label className={styles.selectWrap}>
              <select
                className={styles.select}
                value={onConflict}
                disabled={migrating !== undefined}
                onChange={(e) => setOnConflict(e.target.value as MigrationConflictPolicy)}
              >
                {conflictOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </label>
          </div>
        </div>
        <p className={`${styles.status}`}>
          {conflictOptions.find((opt) => opt.value === onConflict)?.hint}
        </p>
        {(Object.keys(directionLabel) as MigrationDirection[]).map((direction) => (
          <div key={direction} className={styles.row}>
            <div className={styles.rowText}>
              <span className={styles.title}>{directionLabel[direction]}</span>
              <span className={styles.desc}>
                扫描源中的全部会话并写入目标；源保持不变，可重复执行。
              </span>
            </div>
            <div className={styles.rowActions}>
              <button
                className={styles.btn}
                disabled={migrating !== undefined}
                onClick={() => void runMigration(direction, true)}
              >
                预览 (dry-run)
              </button>
              <button
                className={`${styles.btn} ${styles.primary}`}
                disabled={migrating !== undefined}
                onClick={() => void runMigration(direction, false)}
              >
                开始迁移
              </button>
            </div>
          </div>
        ))}
        {migrating !== undefined && (
          <p className={`${styles.status}`}>
            正在执行 {directionLabel[migrating]}…（可能耗时较长）
          </p>
        )}
        {migrateError !== undefined && (
          <p className={`${styles.status} ${styles.err}`}>{migrateError}</p>
        )}
        {report !== undefined && (
          <MigrationReport report={report} directionLabel={directionLabel} fmtCount={fmtCount} />
        )}
      </div>
    </div>
  )
}

/** Rendered migration report. */
function MigrationReport({
  report,
  directionLabel,
  fmtCount,
}: {
  report: MigrationStartResult
  directionLabel: Record<MigrationDirection, string>
  fmtCount: (n: number) => string
}): ReactNode {
  const failed = report.sessions.filter((s) => s.error !== undefined)
  const skipped = report.sessions.filter((s) => s.skipped !== undefined && s.error === undefined)
  return (
    <div className={styles.report}>
      <div className={styles.reportHead}>
        <span className={styles.title}>
          {directionLabel[report.direction]} · {report.dryRun ? '预览结果' : '迁移完成'}
        </span>
        <span className={styles.count}>
          {report.dryRun ? '（未写入，仅统计）' : report.ok ? '✓ 完成' : '✗ 有失败'}
        </span>
      </div>
      {report.error !== undefined && (
        <p className={`${styles.status} ${styles.err}`}>{report.error}</p>
      )}
      <p className={styles.summary}>
        源共 {fmtCount(report.sourceTotal)} 个会话 · 迁移 {fmtCount(report.sessions.length - skipped.length - failed.length)} 个 · 事件 {fmtCount(report.eventsTotal)} 条
        {skipped.length > 0 ? ` · 跳过 ${skipped.length} 个` : ''}
        {failed.length > 0 ? ` · 失败 ${failed.length} 个` : ''}
      </p>
      {(failed.length > 0 || skipped.length > 0) && (
        <ul className={styles.failList}>
          {failed.map((s) => (
            <li key={s.sessionId} className={styles.failItem}>
              <code className={styles.code}>{shortId(s.sessionId)}</code>
              <span className={styles.err}>{s.error}</span>
            </li>
          ))}
          {skipped.map((s) => (
            <li key={s.sessionId} className={styles.failItem}>
              <code className={styles.code}>
                {shortId(s.sessionId)}
                {s.clonedTo !== undefined ? ` → ${shortId(s.clonedTo)}` : ''}
              </code>
              <span className={styles.dim}>{s.skipped}</span>
              {s.targetAhead !== undefined && s.targetAhead > 0 && (
                <span className={styles.warn}> · 目标多 {fmtCount(s.targetAhead)} 条</span>
              )}
              {s.overwritten === true && (
                <span className={styles.warn}> · 已整会话重建</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** session-<uuid> → session-<8-4-4-4-12> tail for compact listing. */
function shortId(id: string): string {
  const m = /session-([0-9a-f-]{36})/.exec(id)
  return m !== null ? `session-${m[1]!.slice(0, 8)}…` : id
}

/** The client plugin body: registers the settings section. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'pg-console',
    order: 200,
    label: () => 'PostgreSQL Backends',
    inject: () => ({}),
  }, PgConsoleSection)), 'dsh-postgres-backends: settings section')
}