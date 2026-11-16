import { spawn } from 'node:child_process';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

await mkdir('../../work/profiles', { recursive: true });
const profile = await mkdtemp(resolve('../../work/profiles/optics-'));
const executable = process.env.GLASS_EXE || join(process.env.LOCALAPPDATA, 'Glass Music/glass-music.exe');
const app = spawn(executable, [], { windowsHide: true, env: {
  ...process.env, GLASS_TEST_DATA: profile, WEBVIEW2_USER_DATA_FOLDER: join(profile, 'webview'),
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9340',
} });
try {
  let ready = false;
  for (let i = 0; i < 90; i++) {
    try { ready = (await fetch('http://127.0.0.1:9340/json/version')).ok; } catch {}
    if (ready) break;
    await new Promise(r => setTimeout(r, 150));
  }
  if (!ready) throw new Error('O WebView2 do aplicativo instalado não abriu.');
  const check = spawn(process.execPath, ['scripts/verify-optics.mjs', '9340'], { stdio: 'inherit', windowsHide: true });
  process.exitCode = await new Promise((resolve, reject) => { check.on('error', reject); check.on('exit', code => resolve(code ?? 1)); });
} finally { app.kill(); }
