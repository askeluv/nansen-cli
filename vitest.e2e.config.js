import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.e2e.test.js'],
    testTimeout: 720000, // 12 min — cross-chain bridges can take up to 10 min
  },
});
