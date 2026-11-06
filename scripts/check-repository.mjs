import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';

const root = process.cwd();
const files = [...new Set(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {encoding:'utf8', windowsHide:true}).split('\0').filter(Boolean))].sort();
const failures = [];
const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
const dependencies = new Set(Object.keys({...manifest.dependencies,...manifest.devDependencies,...manifest.peerDependencies}));
const generated = /(^|\/)(?:node_modules|lib|artifacts|coverage|\.local|\.validation|\.cache|\.pnpm-store|\.codegraph)(?:\/|$)|(?:\.log|\.tgz|\.pem|\.key|\.p12|\.pfx|\.tsbuildinfo)$/i;
const credentials = /(^|\/)(?:\.env(?:\..+)?|\.credentials[^/]*|auth\.json|credentials[^/]*\.(?:json|ya?ml))$/i;
const secrets = /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}|\bgh[pousr]_[A-Za-z0-9]{24,}|\bgithub_pat_[A-Za-z0-9_]{30,}|Bearer\s+eyJ[A-Za-z0-9_.-]{40,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/;
const machinePath = /[A-Z]:[\\/](?:Users|pROJECT|DevSoft|DevData)[\\/]|\/(?:Users|home)\/[a-zA-Z0-9_-]+\//;
for (const file of files) {
  if (generated.test(file) || (credentials.test(file) && !file.endsWith('.env.example'))) { failures.push(`${file}: local or generated file`); continue; }
  if (['.png','.jpg','.jpeg','.ico','.webp'].includes(extname(file))) continue;
  const text = readFileSync(file, 'utf8');
  if (secrets.test(text)) failures.push(`${file}: possible credential`);
  if (machinePath.test(text)) failures.push(`${file}: machine-specific path`);
  if (/^(?:src|tests)\//.test(file) && /\.[cm]?[jt]sx?$/.test(file)) for (const match of text.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s*)['"]([^'"]+)['"]/g)) {
    const specifier = match[1];
    if (specifier.startsWith('.') || specifier.startsWith('node:')) continue;
    const name = specifier.startsWith('@') ? specifier.split('/').slice(0,2).join('/') : specifier.split('/')[0];
    if (!dependencies.has(name)) failures.push(`${file}: undeclared direct dependency ${name}`);
  }
  if (file.endsWith('.md')) for (const match of text.matchAll(/!?\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
    const target = match[1].split('#')[0];
    if (!target || /^(?:https?:|mailto:)/.test(target)) continue;
    if (!existsSync(resolve(root, dirname(file), decodeURIComponent(target)))) failures.push(`${file}: missing documentation target ${target}`);
  }
}
for (const file of ['package-lock.json','yarn.lock']) if (files.includes(file)) failures.push(`${file}: keep only pnpm-lock.yaml`);
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
else console.log(`Repository check passed: ${files.length} source/documentation files; no local records or credential markers.`);
