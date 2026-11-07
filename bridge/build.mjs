// Bundles the bridge into a single executable file (dist/bridge.js). Only `ws` stays external.
import { build } from 'esbuild';
await build({
  entryPoints: ['src/cli.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: 'dist/bridge.js',
  external: ['ws'],
  banner: { js: '#!/usr/bin/env node' },
  plugins: [{ name: 'shared', setup(b) { b.onResolve({ filter: /^@tc\/shared$/ }, () => ({ path: new URL('../shared/src/index.ts', import.meta.url).pathname })); } }],
});
console.log('bridge bundled -> dist/bridge.js');
