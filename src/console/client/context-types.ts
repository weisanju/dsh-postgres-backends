/**
 * Structural types for the client cordis services this plugin consumes. A
 * third-party plugin resolves outside the DSH monorepo's single cordis
 * instance, so upstream `declare module` augmentations do not reach this
 * Context, and the npm cordis package does not declare the DSH-vendored
 * runtime members (`ctx.effect`, service properties). The members below
 * mirror the actual client runtime shapes this plugin touches:
 * - slots: the client runtime SlotRegistry (register/inject)
 * - locale: the client locale service (register dictionaries)
 * - effect: the DSH-vendored cordis lifecycle helper
 * - provide/get: the service registry face used to publish this plugin's
 *   own service to sibling plugins
 *
 * This file must stay FREE of Node.js types — it is part of the
 * CLIENT-reachable declaration graph.
 */
export interface SlotRegistration {
  name: string
  id: string
  order?: number
  label?: () => string
  inject?: () => Record<string, unknown>
}

/** The client SlotRegistry face (structural subset). */
export interface SlotRegistry {
  register(slotOrRegistration: unknown, componentOrOptions?: unknown, options?: unknown): unknown
  inject(slot: string, factory: () => unknown): unknown
}

/** The client locale service face (structural subset). */
export interface LocaleService {
  register(namespace: string, language: string, dict: Record<string, string>): () => void
}

/** The client Context this plugin consumes (independent of npm cordis types). */
export interface ClientContext {
  /** Register a disposal effect (the DSH-vendored lifecycle helper). */
  effect<T>(callback: () => T | (() => void), name?: string): void
  slots: SlotRegistry
  locale: LocaleService
  /** Read a sibling service by name (cross-plugin). */
  get(name: string): unknown
  /** Provide a service to sibling plugins. */
  provide(name: string, value: unknown): void
  [key: string]: unknown
}

export type Context = ClientContext