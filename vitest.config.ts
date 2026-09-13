import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['server/**/*.test.ts', 'api/**/*.test.ts', 'src/**/*.test.{ts,tsx}'],
    // The frontend needs a DOM; the server must not have one, because a server module that
    // reaches for `window` should fail in a test rather than in a serverless function.
    environmentMatchGlobs: [['src/**', 'jsdom']],
    // Every test in this project is offline. Nothing here may open a socket.
    testTimeout: 10_000,
  },
});
