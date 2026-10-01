import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative asset paths: the build runs from any folder, e.g. GitHub Pages' /<repo>/.
  base: './',
  server: { port: 5173 },
  // Some tests build the whole real city (physics + meshes); give them room under parallel load.
  test: { include: ['tests/**/*.test.ts'], testTimeout: 30_000, hookTimeout: 30_000 },
});
