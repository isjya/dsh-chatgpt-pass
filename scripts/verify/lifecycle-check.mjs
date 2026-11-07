import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import assert from 'node:assert/strict';

// Package lifecycle probe: install the delivered tarball into a fresh isolated
// profile, start the installed bundle, then perform a real byte-changing upgrade
// (a version-bumped copy of the same tarball), return to the delivered tarball,
// and finally uninstall. The plugin's stable host id must survive both hops.
const target = process.argv[2];
if (!['source', 'desktop'].includes(target)) throw new Error('Use source or desktop');
const home = resolve(`.validation/lifecycle-${target}-${Date.now()}`), profile = `package-${target}`;
await mkdir(home, { recursive: true });
const patch = resolve('.validation/ready.patch.yml');
await writeFile(patch, `- insert:\n    - id: chatgpt-ready-probe\n      name: ${resolve('scripts/verify/ready-probe.mjs').replaceAll('\\', '/')}\n`);
const env = { ...process.env, DSH_CHATGPT_HOME: home, DSH_CHATGPT_PROFILE: profile, npm_config_offline: 'false', npm_config_minimum_release_age: '0' };
function run(args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, ['scripts/verify/run-host.mjs', target, ...args], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolveRun(output) : reject(new Error(output.slice(-4000))));
  });
}
const manifest = () => readFile(resolve(home, 'profiles', profile, 'package.json'), 'utf8').then(JSON.parse);
const installedVersion = () => readFile(resolve(home, 'profiles', profile, 'node_modules', 'dsh-chatgpt-pass', 'package.json'), 'utf8').then(JSON.parse).then(p => p.version);
const version = JSON.parse(await readFile('package.json', 'utf8')).version;
const artifact = `dsh-chatgpt-pass-${version}.tgz`;
const file = resolve('artifacts', artifact);

// Build a same-code, version-bumped copy so the upgrade replaces bytes instead of
// short-circuiting on an unchanged version string.
const variantRoot = resolve(`.validation/upgrade-variant-${target}-${version}`);
if (!variantRoot.startsWith(resolve('.validation') + sep)) throw new Error('Upgrade fixture must stay inside .validation.');
await rm(variantRoot, { recursive: true, force: true });
await mkdir(variantRoot, { recursive: true });
const untar = spawnSync('tar', ['-xzf', file, '-C', variantRoot], { encoding: 'utf8' });
assert.equal(untar.status, 0, untar.stderr);
const variantPkgDir = join(variantRoot, 'package');
const variant = JSON.parse(await readFile(join(variantPkgDir, 'package.json'), 'utf8'));
variant.version = `${version}-upgrade-probe`;
await writeFile(join(variantPkgDir, 'package.json'), JSON.stringify(variant, null, 2) + '\n');
const pack = spawnSync('npm.cmd', ['pack', '--pack-destination', variantRoot, '--ignore-scripts'], { cwd: variantPkgDir, encoding: 'utf8', shell: process.platform === 'win32', windowsHide: true });
assert.equal(pack.status, 0, String(pack.stderr));
const variantFile = join(variantRoot, `dsh-chatgpt-pass-${variant.version}.tgz`);

await run(['--from-default-profile', 'web', '--dump-config']);
const before = (await manifest()).dsh.profile.bundles;
await run(['plugin', 'add', file]);
assert.equal(await installedVersion(), version);
assert((await manifest()).dsh.profile.bundles.includes('dsh-chatgpt-pass'));
async function ready() {
  const port = target === 'source' ? '3199' : '3200';
  const output = await run(['--patch', patch, '--no-open', '--port', port]);
  const line = output.split(/\r?\n/).find(l => l.startsWith('DSH_CHATGPT_INSTALLED_READY '));
  assert(line, 'Installed plugin did not become ready');
  return JSON.parse(line.slice('DSH_CHATGPT_INSTALLED_READY '.length));
}
const installed = await ready();
await run(['plugin', 'add', '--force', variantFile]);
assert.equal(await installedVersion(), variant.version);
const upgraded = await ready(); assert.equal(installed.hostHash, upgraded.hostHash);
await run(['plugin', 'add', '--force', file]);
assert.equal(await installedVersion(), version);
const restored = await ready(); assert.equal(installed.hostHash, restored.hostHash);
await run(['plugin', 'remove', 'dsh-chatgpt-pass']);
assert.deepEqual((await manifest()).dsh.profile.bundles, before);
const result = {
  target, homePurpose: 'isolated synthetic package lifecycle', profile, package: version, artifact,
  install: 'PASS', load: installed.result, clientAsset: installed.clientAsset, gateway: installed.gateway,
  upgrade: { probeVersion: variant.version, bytesChanged: true, hostPreserved: true, returnedToDelivered: true },
  installedVersions: [version, variant.version, version],
  removePreservesCoreBundles: true, node: installed.node, realAccount: 'NOT RUN', visualUI: 'NOT RUN',
};
await writeFile(`.validation/${target}-lifecycle-result.json`, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
