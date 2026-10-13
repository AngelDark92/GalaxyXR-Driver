import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Node-environment unit tests for the framework-free domain/state layer.
// (The component layer is verified by the production build gate; these tests
// cover the pure logic that has no DOM dependencies.)
export default defineConfig({
  cacheDir: path.resolve(__dirname, '../../builds/GalaxyXR-Driver/gui/cache/vitest'),
  test: {
    environment: 'node',
    include: ['src-lit/**/*.test.ts'],
    setupFiles: ['./scripts/vitest.setup.mjs'],
    root: __dirname,
  },
});
