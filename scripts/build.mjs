import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
mkdirSync('lib', { recursive: true });
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '--emitDeclarationOnly'], { stdio: 'inherit' });
await build({ entryPoints: ['src/index.ts'], outdir: 'lib', bundle: true, platform: 'node', format: 'esm', target: 'node24', charset: 'utf8', packages: 'external' });
await build({ entryPoints: ['src/client/index.tsx'], outfile: 'lib/client.js', bundle: true, platform: 'browser', format: 'cjs', target: 'es2022', charset: 'utf8', packages: 'external',
  banner: { js: 'window.__ModuleLoader__.load({ id: "dsh-chatgpt-provider", factory: (require) => { var module = { exports: {} }; var exports = module.exports;' },
  footer: { js: 'return module.exports; } });' } });
