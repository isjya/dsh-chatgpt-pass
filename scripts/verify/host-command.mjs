// Single source of truth for launching a target Harness host through its public
// CLI carrier. Kept separate so the human-facing runner can scrub the launch URL
// while automation can read it in-memory without persisting it.
import { delimiter, resolve } from 'node:path';

export function hostCommand(target, extra = []) {
  if (!['source', 'desktop'].includes(target)) throw new Error('Use source or desktop');
  const root = process.cwd();
  const sourceRoot = process.env.DSH_CHATGPT_SOURCE_ROOT;
  const desktopRoot = process.env.DSH_CHATGPT_DESKTOP_ROOT;
  if (target === 'source' && !sourceRoot) throw new Error('Set DSH_CHATGPT_SOURCE_ROOT to a built Harness checkout.');
  if (target === 'desktop' && !desktopRoot) throw new Error('Set DSH_CHATGPT_DESKTOP_ROOT to the Harness Desktop installation directory.');
  const command = target === 'source' ? process.execPath : resolve(desktopRoot, 'DeepSeek Harness.exe');
  // Same arguments as the verified public runtime/cli/bin/dsh.cmd carrier.
  const args = target === 'source' ? ['--import', 'tsx/esm', 'apps/cli/src/bin.ts'] : ['--expose-internals', resolve(desktopRoot, 'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js')];
  const profile = process.env.DSH_CHATGPT_PROFILE ?? `chatgpt-${target}`;
  if (extra[0] === 'plugin') args.push('plugin', '--profile', profile, ...extra.slice(1));
  else args.push('--profile', profile, ...extra);
  const env = {
    ...process.env,
    DSH_HOME: process.env.DSH_CHATGPT_HOME ?? resolve(root, `.validation/${target}-home`),
    PATH: `${resolve(root, 'node_modules/.bin')}${delimiter}${process.env.PATH ?? ''}`,
    ...(target === 'desktop' ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
  };
  return { command, args, env, cwd: target === 'source' ? sourceRoot : root };
}
