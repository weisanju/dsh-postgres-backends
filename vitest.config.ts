import { defineConfig } from 'vitest/config'

// Standalone package: all @deepseek-ai/* peers resolve from this repo's own
// node_modules (declared in peerDependencies/devDependencies), no checkout alias.
export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
})