import { spawn } from 'node:child_process';
import { hostCommand } from './host-command.mjs';
// Launch a target Harness host through its public CLI carrier for manual use.
// The process launch token is redacted from inherited output.
const target = process.argv[2];
const { command, args, env, cwd } = hostCommand(target, process.argv.slice(3));
const child = spawn(command, args, { cwd, windowsHide: true, env, stdio: ['inherit', 'pipe', 'pipe'] });
const scrub = data => process.stdout.write(String(data).replace(/([?&](?:token|code|state|id_token_hint)=)[^\s&]+/g, '$1[redacted]'));
child.stdout.on('data', scrub); child.stderr.on('data', scrub);
child.once('error', () => { console.error('Host launch failed'); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
process.on('SIGINT', () => child.kill());
