import { defineConfig } from 'vitest/config';

// The underpass/bridge harness (tests/underpass): `npm run test:underpass`. Includes the slow
// physics suites (*.slow.test.ts) that `npm test` leaves out.
export default defineConfig({
  test: {
    include: ['tests/underpass/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
