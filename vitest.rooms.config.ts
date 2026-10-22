import { defineConfig } from 'vitest/config';

// Online-rooms integration tests (tests/rooms): `npm run test:rooms`. The global setup starts
// `wrangler dev` (the Worker + Durable Object in local workerd) on 127.0.0.1:8787.
export default defineConfig({
  test: {
    include: ['tests/rooms/**/*.test.ts'],
    globalSetup: ['tests/rooms/globalSetup.ts'],
    testTimeout: 30_000,
    hookTimeout: 90_000,
    fileParallelism: false,
  },
});
