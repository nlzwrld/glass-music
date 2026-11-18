import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { ensureCatalogBinaries } from './configure-catalog.mjs';

await ensureCatalogBinaries({
  allowOfflinePlaceholder: process.env.CI !== 'true',
});

for (const [cli, args] of [
  ['typescript/bin/tsc', ['--noEmit']],
  ['vite/bin/vite.js', ['build']],
]) {
  const result = spawnSync(process.execPath, [resolve('node_modules', cli), ...args], {
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
