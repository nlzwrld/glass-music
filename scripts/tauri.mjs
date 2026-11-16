import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, delimiter, dirname } from 'node:path';
// Prefer the developer's installed toolchain. Also support the isolated toolchain
// prepared beside this workspace without changing the Windows system PATH.
const env = { ...process.env };
const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH';
env[pathKey] = dirname(process.execPath) + delimiter + (env[pathKey] || '');
const localTools = resolve('../../work');
if (!env.CARGO_HOME && existsSync(resolve(localTools, 'cargo/bin/cargo.exe'))) {
  env.CARGO_HOME = resolve(localTools, 'cargo');
  env.RUSTUP_HOME = resolve(localTools, 'rustup');
  env[pathKey] = resolve(env.CARGO_HOME, 'bin') + delimiter + (env[pathKey] || '');
}
const child = spawn(process.execPath, [resolve('node_modules/@tauri-apps/cli/tauri.js'), ...process.argv.slice(2)], { env, stdio: 'inherit', windowsHide: true });
child.on('error', e => { console.error(e.message); process.exitCode=1; });
child.on('exit', code => { process.exitCode=code ?? 1; });
