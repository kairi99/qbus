import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative asset paths: the build runs from any folder, e.g. GitHub Pages' /<repo>/.
  base: './',
  server: { port: 5173 },
  build: {
    rolldownOptions: {
      output: {
        // The engines change far less often than the game: their own chunks stay cached
        // across deploys. (Rapier inlines its WebAssembly, hence its size.)
        codeSplitting: {
          groups: [
            { name: 'rapier', test: /node_modules[\\/]@dimforge/ },
            { name: 'three', test: /node_modules[\\/]three/ },
          ],
        },
      },
    },
    // Rapier (inlined WebAssembly) and a city's data are big by nature and load on demand.
    chunkSizeWarningLimit: 3000,
  },
  // Some tests build the whole real city (physics + meshes); give them room under parallel load.
  test: { include: ['tests/**/*.test.ts'], testTimeout: 30_000, hookTimeout: 30_000 },
});
