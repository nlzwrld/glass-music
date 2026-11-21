import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TextDecoder } from 'node:util';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const catalogAssetsDir = join(rootDir, 'assets', 'catalog');
const catalogJsonPath = join(rootDir, 'src-tauri', 'catalog.json');
const archiveManagedEntries = new Set(['yt-dlp']);

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

const textMetadataNames = new Set([
  'license',
  'notice',
  'metadata',
  'record',
  'wheel',
  'installer',
  'requested',
  'delvewheel',
  'py.typed',
]);

function isRecognizedTextResource(declared) {
  const name = declared.split('/').pop().toLowerCase();
  return /\.(?:py|txt|js)$/.test(name) ||
    textMetadataNames.has(name) ||
    name.endsWith('-license') ||
    name.endsWith('_licenses');
}

function textEolHashes(bytes) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const lf = text.replace(/\r\n/g, '\n');
    // Old-Mac/lone-CR data is not an LF/CRLF variant and remains raw-only.
    if (lf.includes('\r')) return null;
    return {
      LF: sha256Bytes(Buffer.from(lf, 'utf8')),
      CRLF: sha256Bytes(Buffer.from(lf.replace(/\n/g, '\r\n'), 'utf8')),
    };
  } catch {
    return null;
  }
}

function validHash(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

function declaredPath(assetsDir, declared) {
  if (
    typeof declared !== 'string' ||
    !declared ||
    declared.includes('\\') ||
    declared.includes('\0') ||
    declared.startsWith('/') ||
    /^[A-Za-z]:/.test(declared)
  ) {
    throw new Error(`Caminho inválido em PROVENANCE: ${declared}`);
  }
  const segments = declared.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw new Error(`Caminho inseguro em PROVENANCE: ${declared}`);
  }
  const path = resolve(assetsDir, ...segments);
  const rel = relative(resolve(assetsDir), path);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Caminho fora do catálogo em PROVENANCE: ${declared}`);
  }
  return path;
}

export async function readCatalogProvenance(assetsDir = catalogAssetsDir) {
  const provenance = JSON.parse(await readFile(join(assetsDir, 'PROVENANCE.json'), 'utf8'));
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) {
    throw new Error('PROVENANCE.json deve conter um objeto.');
  }
  if (typeof provenance.version !== 'string' || !provenance.version.trim()) {
    throw new Error('PROVENANCE.version é obrigatório.');
  }
  if (
    typeof provenance.asset !== 'string' ||
    !provenance.asset ||
    basename(provenance.asset) !== provenance.asset ||
    /[\\/]/.test(provenance.asset)
  ) {
    throw new Error('PROVENANCE.asset deve ser um nome de arquivo simples.');
  }
  if (!validHash(provenance.sha256)) {
    throw new Error(`SHA-256 do arquivo ${provenance.asset} ausente ou inválido em PROVENANCE.`);
  }
  if (provenance.sourceSha256 !== undefined && !validHash(provenance.sourceSha256)) {
    throw new Error('PROVENANCE.sourceSha256 inválido.');
  }
  if (!provenance.files || typeof provenance.files !== 'object' || Array.isArray(provenance.files)) {
    throw new Error('PROVENANCE.files deve ser um objeto de caminhos e hashes.');
  }
  const entries = Object.entries(provenance.files);
  if (!entries.length) throw new Error('PROVENANCE.files não pode estar vazio.');
  const canonical = new Set();
  for (const [path, hash] of entries) {
    declaredPath(assetsDir, path);
    const key = path.toLowerCase();
    if (canonical.has(key)) throw new Error(`Caminho duplicado em PROVENANCE: ${path}`);
    canonical.add(key);
    if (!validHash(hash)) throw new Error(`SHA-256 ausente ou inválido para ${path}.`);
  }
  return provenance;
}

function failureReason(missing, mismatched) {
  const details = [
    ...missing.map(path => `${path} (ausente)`),
    ...mismatched.map(({ path, actual, expected }) => `${path} (${actual} !== ${expected})`),
  ];
  const shown = details.slice(0, 12);
  if (details.length > shown.length) shown.push(`… e mais ${details.length - shown.length} falha(s)`);
  return `${details.length} recurso(s) nativo(s) inválido(s): ${shown.join('; ')}`;
}

export async function verifyCatalogBinaries({ assetsDir = catalogAssetsDir, provenance } = {}) {
  const manifest = provenance || (await readCatalogProvenance(assetsDir));
  const missing = [];
  const mismatched = [];
  const eolNormalized = [];
  for (const [path, expectedValue] of Object.entries(manifest.files)) {
    const filePath = declaredPath(assetsDir, path);
    let bytes;
    try {
      bytes = await readFile(filePath);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'EISDIR') {
        missing.push(path);
        continue;
      }
      throw error;
    }
    const actual = sha256Bytes(bytes);
    const expected = expectedValue.toLowerCase();
    if (actual === expected) continue;

    const variants = isRecognizedTextResource(path) ? textEolHashes(bytes) : null;
    const variant = variants && Object.keys(variants).find(key => variants[key] === expected);
    if (variant) {
      eolNormalized.push({ path, variant });
    } else {
      mismatched.push({ path, actual, expected });
    }
  }
  if (missing.length || mismatched.length) {
    return { ok: false, reason: failureReason(missing, mismatched), missing, mismatched, eolNormalized, provenance: manifest };
  }
  return { ok: true, provenance: manifest, verified: Object.keys(manifest.files).length, eolNormalized };
}

async function copyCatalogMetadata(assetsDir, stagedCatalog) {
  if (!existsSync(assetsDir)) return;
  for (const entry of await readdir(assetsDir)) {
    if (archiveManagedEntries.has(entry)) continue;
    await cp(join(assetsDir, entry), join(stagedCatalog, entry), { recursive: true });
  }
}

async function activateStagedCatalog(assetsDir, stagedCatalog, stagingRoot) {
  const parent = dirname(assetsDir);
  const backup = join(parent, `.catalog-backup-${basename(stagingRoot)}`);
  const hadActive = existsSync(assetsDir);
  if (hadActive) await rename(assetsDir, backup);
  try {
    await rename(stagedCatalog, assetsDir);
  } catch (error) {
    if (hadActive && !existsSync(assetsDir)) await rename(backup, assetsDir);
    throw error;
  }
  await rm(backup, { recursive: true, force: true }).catch(() => {});
}

export async function ensureCatalogBinaries({
  force = false,
  allowOfflinePlaceholder = false,
  assetsDir = catalogAssetsDir,
  fetchImpl = fetch,
  spawnSyncImpl = spawnSync,
} = {}) {
  // Validate structure and every declared path before any early return, including E2E skip mode.
  const provenance = await readCatalogProvenance(assetsDir);
  if (process.env.LIQUID_SKIP_YTDLP_DOWNLOAD === '1') {
    await mkdir(join(assetsDir, 'yt-dlp'), { recursive: true });
    return { skipped: true };
  }
  const check = await verifyCatalogBinaries({ assetsDir, provenance });
  if (!force && check.ok) {
    return { verified: true, downloaded: false, version: provenance.version };
  }

  const { version, asset, sha256: expectedZipHash } = provenance;
  const downloadUrl = `https://github.com/yt-dlp/yt-dlp/releases/download/${encodeURIComponent(version)}/${encodeURIComponent(asset)}`;
  const parent = dirname(assetsDir);
  await mkdir(parent, { recursive: true });
  const stagingRoot = await mkdtemp(join(parent, '.catalog-staging-'));
  const stagedCatalog = join(stagingRoot, 'catalog');
  const tempZip = join(stagingRoot, asset);
  await mkdir(stagedCatalog, { recursive: true });

  console.log(`[Liquid Hub] Baixando auxiliar yt-dlp ${version} (${asset})…`);
  try {
    const response = await fetchImpl(downloadUrl, {
      redirect: 'follow',
      signal: AbortSignal.timeout(120_000),
      headers: { 'User-Agent': 'LiquidHub-Build/2.2' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} ao baixar ${downloadUrl}`);
    const zipBuffer = Buffer.from(await response.arrayBuffer());
    const actualZipHash = createHash('sha256').update(zipBuffer).digest('hex');
    if (actualZipHash !== expectedZipHash.toLowerCase()) {
      throw new Error(`Integridade do arquivo ${asset} reprovada (esperado ${expectedZipHash}, recebido ${actualZipHash}).`);
    }

    await copyCatalogMetadata(assetsDir, stagedCatalog);
    const stagedYtDlpDir = join(stagedCatalog, 'yt-dlp');
    await mkdir(stagedYtDlpDir, { recursive: true });
    await writeFile(tempZip, zipBuffer);
    // Use bsdtar on Windows too: avoids Windows PowerShell 5.1 Expand-Archive crashing
    // when invoked from PowerShell 7 (pwsh) steps with PS7 modules on PSModulePath.
    const extract = spawnSyncImpl('tar', ['-xf', tempZip, '-C', stagedYtDlpDir], {
      stdio: 'inherit',
      windowsHide: true,
    });
    if (extract.error) throw extract.error;
    if (extract.status !== 0) throw new Error(`Falha ao extrair ${asset} (status ${extract.status}).`);

    const postCheck = await verifyCatalogBinaries({ assetsDir: stagedCatalog, provenance });
    if (!postCheck.ok) throw new Error(`Validação pós-extração falhou: ${postCheck.reason}`);
    await activateStagedCatalog(assetsDir, stagedCatalog, stagingRoot);
    console.log(`[Liquid Hub] ${postCheck.verified} recursos nativos verificados com SHA-256.`);
    return { verified: true, downloaded: true, version };
  } catch (error) {
    if (allowOfflinePlaceholder) {
      await mkdir(join(assetsDir, 'yt-dlp'), { recursive: true });
      console.warn(`[Liquid Hub] Aviso: download dinâmico ignorado (${error.message}).`);
      return { verified: false, downloaded: false, warning: error.message };
    }
    throw error;
  } finally {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function runCli() {
  const raw = process.argv[2];
  if (!raw) {
    throw new Error('Uso: node scripts/configure-catalog.mjs <https://catalogo.exemplo | --clear | --ensure-binaries | --verify>');
  }
  if (raw === '--ensure-binaries') {
    await ensureCatalogBinaries({ force: process.argv.includes('--force') });
    return;
  }
  if (raw === '--verify') {
    const status = await verifyCatalogBinaries();
    if (!status.ok) throw new Error(`Binários inválidos: ${status.reason}`);
    console.log(`Catálogo local íntegro: ${status.verified} arquivos (yt-dlp ${status.provenance.version}).`);
    return;
  }

  let catalogUrl = '';
  if (raw !== '--clear') {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || u.pathname !== '/') {
      throw new Error('Use a origem HTTPS do catálogo, sem caminhos, credenciais ou parâmetros.');
    }
    catalogUrl = u.origin;
  } else {
    await ensureCatalogBinaries({ allowOfflinePlaceholder: true });
  }

  await readFile(catalogJsonPath, 'utf8');
  await writeFile(catalogJsonPath, JSON.stringify({ catalogUrl }, null, 2) + '\n');
  console.log(catalogUrl
    ? `Catálogo definido: ${catalogUrl}. Gere o instalador do Liquid Hub com pnpm dist.`
    : 'Busca direta incluída selecionada. Gere o instalador do Liquid Hub com pnpm dist.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
