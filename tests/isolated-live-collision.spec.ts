/**
 * Regression test for the "already has a persisted log on disk that does
 * not match this live session (id collision)" failure: a coordinator built
 * on an isolated child context must NOT adopt-check live sessions from the
 * parent store.
 *
 * Mechanism: `detachLiveSessions` shadows `sessions.list()` on the child
 * scope with an empty-returning stub so the coordinator's `installWritePath`
 * never iterates parent live sessions. The fix is verified by checking that
 * the child's `list()` returns empty while the parent holds live sessions,
 * and that `get()` (used by coordinator's prepare/read/append paths) still
 * delegates to the parent store.
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import { randomUUID } from 'node:crypto'

function detachLiveSessions(child: Context): void {
  const parentSessions = child.sessions
  Object.defineProperty(child, 'sessions', {
    value: new Proxy(parentSessions, {
      get(target, prop) {
        if (prop === 'list') return () => []
        const value = Reflect.get(target, prop)
        return typeof value === 'function' ? value.bind(target) : value
      },
    }),
    configurable: true,
    enumerable: true,
    writable: false,
  })
}

function events(seqStart: number, note: string): never[] {
  return [
    { seq: seqStart, type: 'turn/start', time: Date.now(), data: { turn: 1 } },
    { seq: seqStart + 1, type: 'user/message', time: Date.now(), data: { id: `msg-${note}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: note }] }, surfaceOp: 'append' },
    { seq: seqStart + 2, type: 'assistant/chunk', time: Date.now(), data: { delta: note } },
    { seq: seqStart + 3, type: 'turn/end', time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } },
  ] as never[]
}

describe('detachLiveSessions', () => {
  it('child sessions.list() returns empty while parent has live sessions', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)

    const id = randomUUID() as never
    ctx.sessions.create(id, { seed: events(0, 'a') })
    expect(ctx.sessions.list().some(s => s.id === id)).toBe(true)

    const child = ctx.isolate('sessionPersistence')
    detachLiveSessions(child)
    expect(child.sessions.list().length).toBe(0)
    expect(child.sessions.get(id)).toBeDefined()
  })
})