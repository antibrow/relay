import { defineConfig } from 'vitest/config'

export default defineConfig({
  // These are integration tests over real TCP listeners and real AEAD handshakes.
  // The default 5s budget is too tight for them under the parallel pool.
  test: { environment: 'node', include: ['tests/**/*.test.ts'], testTimeout: 20000 },
})
