import { defineConfig } from 'vitest/config'

// Standalone package: all @deepseek-ai/* peers resolve from this repo's own
// node_modules (declared in peerDependencies/devDependencies), no checkout alias.
export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30000,
    hookTimeout: 30000,
    // Specs share one isolated test database (`dsh_test`, or the connection
    // string in DSH_PG_TEST_CONN — see tests/helpers/db.ts); parallel files
    // would drop each other's tables mid-test. Run files serially — within a
    // file, beforeEach still isolates each test. The production database is
    // never touched.
    fileParallelism: false,
  },
})