import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const catalogAssetsDir = join(rootDir, 'assets', 'catalog');
const provenancePath = join(catalogAssetsDir, 'PROVENANCE.json');
const catalogJsonPath = join(rootDir, 'src-tauri', 'catalog.json');

async function sha256File(filePath) {
  const bytes = await readFile(filePath);
  return createHash('sha256').update(bytes).digest('hex');
}

export async function verifyCatalogBinaries() {
  const provenance = JSON.parse(await readFile(provenancePath, 'utf8'));
  const exePath = join(catalogAssetsDir, 'yt-dlp', 'yt-dlp.exe');
  if (!existsSync(exePath)) return { ok: false, reason: 'yt-dlp.exe ausente', provenance };
  const expectedExeHash = provenance.files?.['yt-dlp/yt-dlp.exe'];
  if (expectedExeHash) {
    const actual = await sha256File(exePath);
    if (actual !== expectedExeHash) {
      return {
        ok: false,
        reason: `Hash SHA-256 divergente para yt-dlp.exe (${actual} !== ${expectedExeHash})`,
        provenance,
      };
    }
  }
  return { ok: true, provenance };
}

export async function ensureCatalogBinaries({ force = false, allowOfflinePlaceholder = false } = {}) {
  if (process.env.LIQUID_SKIP_YTDLP_DOWNLOAD === '1') {
    await mkdir(join(catalogAssetsDir, 'yt-dlp'), { recursive: true });
    return { skipped: true };
  }
  const check = await verifyCatalogBinaries();
  if (!force && check.ok) {
    return { verified: true, downloaded: false, version: check.provenance.version };
  }

  const { version, asset, sha256: expectedZipHash } = check.provenance;
  const downloadUrl = `https://github.com/yt-dlp/yt-dlp/releases/download/${encodeURIComponent(version)}/${encodeURIComponent(asset)}`;
  const targetDir = join(catalogAssetsDir, 'yt-dlp');
  const tempZip = join(catalogAssetsDir, `${asset}.tmp`);

  console.log(`[Liquid Hub] Baixando auxiliar yt-dlp ${version} (${asset})…`);
  try {
    const response = await fetch(downloadUrl, {
      redirect: 'follow',
      signal: AbortSignal.timeout(120_000),
      headers: { 'User-Agent': 'LiquidHub-Build/2.2' },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ao baixar ${downloadUrl}`);
    }
    const zipBuffer = Buffer.from(await response.arrayBuffer());
    const actualZipHash = createHash('sha256').update(zipBuffer).digest('hex');
    if (expectedZipHash && actualZipHash !== expectedZipHash) {
      throw new Error(
        `Integridade do arquivo ${asset} reprovada (esperado ${expectedZipHash}, recebido ${actualZipHash}).`,
      );
    }

    await rm(targetDir, { recursive: true, force: true });
    await mkdir(targetDir, { recursive: true });
    await writeFile(tempZip, zipBuffer);

    const extract =
      process.platform === 'win32'
        ? spawnSync(
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              `Expand-Archive -LiteralPath '${tempZip.replace(/'/g, "''")}' -DestinationPath '${targetDir.replace(/'/g, "''")}' -Force`,
            ],
            { stdio: 'inherit', windowsHide: true },
          )
        : spawnSync('tar', ['-xf', tempZip, '-C', targetDir], { stdio: 'inherit' });

    await rm(tempZip, { force: true });
    if (extract.status !== 0) {
      throw new Error(`Falha ao extrair ${asset} (status ${extract.status}).`);
    }

    const postCheck = await verifyCatalogBinaries();
    if (!postCheck.ok) {
      throw new Error(`Validação pós-extração falhou: ${postCheck.reason}`);
    }
    console.log(`[Liquid Hub] yt-dlp ${version} verificado com SHA-256 em assets/catalog/yt-dlp/.`);
    return { verified: true, downloaded: true, version };
  } catch (err) {
    await rm(tempZip, { force: true }).catch(() => {});
    if (allowOfflinePlaceholder) {
      await mkdir(targetDir, { recursive: true });
      console.warn(`[Liquid Hub] Aviso: download dinâmico ignorado (${err.message}).`);
      return { verified: false, downloaded: false, warning: err.message };
    }
    throw err;
  }
}

async function runCli() {
  const raw = process.argv[2];
  if (!raw) {
    throw new Error(
      'Uso: node scripts/configure-catalog.mjs <https://catalogo.exemplo | --clear | --ensure-binaries | --verify>',
    );
  }
  if (raw === '--ensure-binaries') {
    await ensureCatalogBinaries({ force: process.argv.includes('--force') });
    return;
  }
  if (raw === '--verify') {
    const status = await verifyCatalogBinaries();
    if (!status.ok) throw new Error(`Binários inválidos: ${status.reason}`);
    console.log(`Catálogo local íntegro (yt-dlp ${status.provenance.version}).`);
    return;
  }

  let catalogUrl = '';
  if (raw !== '--clear') {
    const u = new URL(raw);
    if (
      u.protocol !== 'https:' ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      u.pathname !== '/'
    ) {
      throw new Error('Use a origem HTTPS do catálogo, sem caminhos, credenciais ou parâmetros.');
    }
    catalogUrl = u.origin;
  } else {
    await ensureCatalogBinaries({ allowOfflinePlaceholder: true });
  }

  await readFile(catalogJsonPath, 'utf8');
  await writeFile(catalogJsonPath, JSON.stringify({ catalogUrl }, null, 2) + '\n');
  console.log(
    catalogUrl
      ? `Catálogo definido: ${catalogUrl}. Gere o instalador do Liquid Hub com pnpm dist.`
      : 'Busca direta incluída selecionada. Gere o instalador do Liquid Hub com pnpm dist.',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
