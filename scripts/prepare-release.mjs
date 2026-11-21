import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function numericVersion(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(String(version || ''));
  if (!match) throw new Error(`Versão SemVer inválida (esperado MAJOR.MINOR.PATCH): ${version}`);
  const parts = match.slice(1).map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new Error(`Versão fora do intervalo seguro: ${version}`);
  return parts;
}

export function resolveReleaseVersion({ baseVersion, explicitVersion = '', runNumber = '' } = {}) {
  const [major, minor, patch] = numericVersion(baseVersion);
  if (explicitVersion) {
    numericVersion(explicitVersion);
    return explicitVersion;
  }
  if (runNumber !== '' && runNumber !== undefined && runNumber !== null) {
    if (!/^[1-9]\d*$/.test(String(runNumber))) {
      throw new Error(`GITHUB_RUN_NUMBER inválido: ${runNumber}`);
    }
    const offset = Number(runNumber);
    const nextPatch = patch + offset;
    if (!Number.isSafeInteger(nextPatch)) throw new Error('Versão de release fora do intervalo seguro.');
    return `${major}.${minor}.${nextPatch}`;
  }
  return `${major}.${minor}.${patch}`;
}

function validRepository(repository) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error(`Repositório GitHub inválido: ${repository}`);
  }
  return repository;
}

async function writeIfChanged(path, content) {
  let previous;
  try {
    previous = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (previous !== content) await writeFile(path, content, 'utf8');
}

export async function prepareRelease({
  root = rootDir,
  version,
  repository = process.env.GITHUB_REPOSITORY || 'nlzwrld/glass-music',
} = {}) {
  numericVersion(version);
  validRepository(repository);
  const packagePath = join(root, 'package.json');
  const tauriPath = join(root, 'src-tauri', 'tauri.conf.json');
  const cargoPath = join(root, 'src-tauri', 'Cargo.toml');
  const pkg = JSON.parse(await readFile(packagePath, 'utf8'));
  const config = JSON.parse(await readFile(tauriPath, 'utf8'));
  const cargo = await readFile(cargoPath, 'utf8');
  if (!/^version = "[^"]+"/m.test(cargo)) throw new Error('Versão do pacote não encontrada em Cargo.toml.');

  pkg.version = version;
  config.version = version;
  await writeIfChanged(packagePath, JSON.stringify(pkg, null, 2) + '\n');
  await writeIfChanged(tauriPath, JSON.stringify(config, null, 2) + '\n');
  await writeIfChanged(cargoPath, cargo.replace(/^(version = ")[^"]+/m, `$1${version}`));
  await writeIfChanged(
    join(root, 'src-tauri', 'release.json'),
    JSON.stringify({ repository, endpoint: `https://github.com/${repository}/releases/latest/download/latest.json` }) + '\n',
  );
  return { version, repository };
}

function argument(name, envValue = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || '' : envValue;
}

async function runCli() {
  const pkg = JSON.parse(await readFile(join(rootDir, 'package.json'), 'utf8'));
  const version = resolveReleaseVersion({
    baseVersion: pkg.version,
    explicitVersion: argument('--version', process.env.RELEASE_VERSION),
    runNumber: process.env.GITHUB_RUN_NUMBER,
  });
  if (process.argv.includes('--print-version')) {
    process.stdout.write(version + '\n');
    return;
  }
  await prepareRelease({ version });
  process.stdout.write(`Versão de release preparada: ${version}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
