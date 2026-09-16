import { defineConfig } from 'vitest/config'

/**
 * Only the bot's own tests live under `test/`. Without this restriction vitest also collects the
 * Hardhat/Mocha `*.test.js` files vendored under `contracts/lib/**` (OpenZeppelin), which cannot
 * run here.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'contracts/**', 'dist/**'],
  },
})
