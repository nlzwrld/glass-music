import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export function resolveLiquidHubExe(): string {
  if (process.env.GLASS_EXE && existsSync(process.env.GLASS_EXE)) {
    return process.env.GLASS_EXE;
  }
  const candidates = [
    resolve('src-tauri/target/release/liquid-hub.exe'),
    resolve('src-tauri/target/debug/liquid-hub.exe'),
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Liquid Hub/liquid-hub.exe') : '',
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Glass Music/glass-music.exe') : '',
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return process.env.GLASS_EXE || candidates[0];
}
