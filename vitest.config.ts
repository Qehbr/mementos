import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['src/__tests__/global-setup.ts'],
    // Windows CI runners pay a heavy process-spawn + cold-file (Defender) tax;
    // the 5s default flake-times-out the git-spawning and fixture-reading
    // tests there. Keep 5s strict elsewhere — a timeout on Linux/macOS
    // usually means a real hang.
    testTimeout: process.platform === 'win32' ? 15_000 : 5_000,
  },
})
