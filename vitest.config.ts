import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // tests/integration is deliberately NOT included here. Those tests load the
    // 11 MB opencv.js, and doing that inside a Vitest worker ran for over seven
    // minutes without reaching a single assertion, while Node's own require
    // path handles the same file in seconds. They run under `node --test`
    // instead: see the test:integration script.
    include: ['tests/unit/**/*.test.ts'],
  },
});
