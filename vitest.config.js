import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    env: {
      NANSEN_NO_TELEMETRY: '1',
    },
    include: ['src/**/*.test.js'],
    exclude: ['src/**/*.e2e.test.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.js'],
      exclude: ['src/**/*.test.js']
    },
    testTimeout: 30000
  }
});
