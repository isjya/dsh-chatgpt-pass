import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
mkdirSync('artifacts', { recursive: true });
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = spawnSync(npm, ['pack', '--json', '--pack-destination', 'artifacts', '--ignore-scripts'], { encoding: 'utf8', shell: process.platform === 'win32', windowsHide: true });
if (run.status !== 0) { process.stderr.write(run.stderr); process.exit(run.status ?? 1); }
const result = JSON.parse(run.stdout);
const pack = Array.isArray(result) ? result[0] : result.files ? result : Object.values(result)[0];
const paths = pack.files.map(f => f.path);
const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
for (const path of paths) {
  if (!/^(lib\/|locale\/(?:en|zh)\.json$|icon\.svg$|package.json$|cordis.patch.yml$|README.md$|LICENSE$|THIRD_PARTY_NOTICES.md$|docs\/(?:INSTALL|DEVELOPMENT|ARCHITECTURE|RELEASING)\.md$|docs\/assets\/subscription-dark\.png$)/.test(path) || /node_modules|\.validation|\.cache|credentials/i.test(path)) throw new Error(`Unexpected packaged path: ${path}`);
  const content = path.endsWith('.png') ? '' : readFileSync(path, 'utf8');
  if (/SYNTHETIC_SECRET_DO_NOT_EXPOSE|[A-Z]:[\\/]pROJECT|[?&](?:code|id_token_hint|state)=|Bearer eyJ/.test(content)) throw new Error(`Sensitive/development marker in ${path}`);
}
for (const [name, version] of Object.entries(manifest.dependencies ?? {})) if (/^(?:workspace:|file:|link:)/.test(version)) throw new Error(`Invalid runtime dependency: ${name}`);
for (const name of ['preinstall', 'install', 'postinstall', 'prepare']) if (manifest.scripts?.[name]) throw new Error(`Prebuilt distribution must not run ${name} at install time`);
for (const path of ['lib/index.js', 'lib/client.js', 'icon.svg', 'locale/en.json', 'locale/zh.json', 'cordis.patch.yml']) if (!paths.includes(path)) throw new Error(`Missing runtime asset: ${path}`);
const sha256 = createHash('sha256').update(readFileSync(`artifacts/${pack.filename}`)).digest('hex');
writeFileSync(`artifacts/${pack.filename}.sha256`, `${sha256}  ${pack.filename}\n`);
writeFileSync('artifacts/files.json', JSON.stringify({ package: manifest.name, version: manifest.version, filename: pack.filename, sha256, files: pack.files }, null, 2) + '\n');
process.stdout.write(JSON.stringify({ filename: pack.filename, sha256, files: paths.length, bytes: pack.size }) + '\n');
