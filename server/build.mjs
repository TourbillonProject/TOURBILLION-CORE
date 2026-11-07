// Bundles the server (and the shared workspace package) into dist/server.js.
// node_modules dependencies stay external and are resolved at runtime.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: 'dist/server.js',
  packages: 'external',
  // @tc/shared is TypeScript source, so it must be bundled rather than left external.
  plugins: [
    {
      name: 'bundle-shared',
      setup(b) {
        b.onResolve({ filter: /^@tc\/shared$/ }, async () => ({
          path: new URL('../shared/src/index.ts', import.meta.url).pathname,
        }));
      },
    },
  ],
  sourcemap: true,
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
console.log('server bundled -> dist/server.js');
