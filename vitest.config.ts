import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

const checkout = '/home/weisanju/gitrepos/deepseek-harness'

export default defineConfig({
  resolve: {
    alias: {
      '@deepseek-ai/dsh-session-persistence/coordinator': resolve(checkout, 'packages/session/session-persistence/src/coordinator.ts'),
      '@deepseek-ai/dsh-session-persistence/revision': resolve(checkout, 'packages/session/session-persistence/src/revision.ts'),
      '@deepseek-ai/dsh-session-persistence/preparations': resolve(checkout, 'packages/session/session-persistence/src/preparations.ts'),
      '@deepseek-ai/dsh-session-persistence/write-behind': resolve(checkout, 'packages/session/session-persistence/src/write-behind.ts'),
      '@deepseek-ai/dsh-session-persistence': resolve(checkout, 'packages/session/session-persistence/src/index.ts'),
      '@deepseek-ai/dsh-session': resolve(checkout, 'packages/core/session/src/index.ts'),
      '@deepseek-ai/dsh-invariants': resolve(checkout, 'packages/runtime-diagnostics/invariants/src/index.ts'),
      '@deepseek-ai/cordis': resolve(checkout, 'vendor/cordis/src/index.ts'),
      '@deepseek-ai/schemastery': resolve(checkout, 'vendor/schemastery/src/index.ts'),
    },
  },
  test: {
    globals: true,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
})