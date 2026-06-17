#!/usr/bin/env node
/**
 * Bundle src/opencode/plugin.ts → dist/opencode-plugin.mjs (ESM)
 * and mirror to .opencode/plugins/aws.mjs for npm pack / repo checkout.
 */
import esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outfile = path.join(root, 'dist/opencode-plugin.mjs');
const packagedPlugin = path.join(root, '.opencode/plugins/aws.mjs');

await esbuild.build({
  entryPoints: [path.join(root, 'src/opencode/plugin.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  outfile,
  sourcemap: true,
  external: ['fs', 'path', 'url'],
});

fs.mkdirSync(path.dirname(packagedPlugin), { recursive: true });
fs.copyFileSync(outfile, packagedPlugin);
const mapFile = `${outfile}.map`;
if (fs.existsSync(mapFile)) {
  fs.copyFileSync(mapFile, `${packagedPlugin}.map`);
}

console.log('Built dist/opencode-plugin.mjs');
console.log('Copied bundled plugin to .opencode/plugins/aws.mjs');
