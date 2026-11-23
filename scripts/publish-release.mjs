import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function remoteDigest(asset) {
  const digest = String(asset?.digest || '').toLowerCase();
  return digest.startsWith('sha256:') ? digest.slice(7) : digest;
}

async function readLocalAssets(inventory) {
  const entries = [
    ['installer', inventory.installer],
    ['signature', inventory.signature],
    ...(Array.isArray(inventory.extraAssets)
      ? inventory.extraAssets.map((item, idx) => [`extra:${idx}`, item])
      : []),
    ['manifest', inventory.manifest],
  ];
  const result = [];
  for (const [key, declared] of entries) {
    if (!declared?.path || !declared?.name) throw new Error(`Inventário sem ${key}.`);
    const bytes = await readFile(declared.path);
    if (!bytes.length) throw new Error(`Artefato vazio: ${declared.path}`);
    const actual = sha256(bytes);
    if (declared.sha256 && declared.sha256.toLowerCase() !== actual) {
      throw new Error(`Artefato mudou após a geração do inventário: ${declared.name}`);
    }
    if (basename(declared.path) !== declared.name) {
      throw new Error(`Nome de artefato divergente no inventário: ${declared.name}`);
    }
    result.push({ key, path: declared.path, name: declared.name, bytes, sha256: actual, size: bytes.length });
  }
  return result;
}

function matchingRemote(release, name) {
  return release.assets?.filter(asset => asset.name === name) || [];
}

function verifyRemoteAsset(asset, local, { allowPendingDigest = false } = {}) {
  if (!asset) return 'missing';
  if (asset.size !== undefined && asset.size !== local.size) {
    throw new Error(`Conflito no asset remoto ${local.name}: conteúdo/tamanho difere do inventário local. Ação necessária: recuperar os artefatos originais ou reparar manualmente a release; nenhum clobber será feito.`);
  }
  const digest = remoteDigest(asset);
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    if (allowPendingDigest && asset.size === local.size) {
      return 'pending_digest';
    }
    throw new Error(`Não foi possível verificar o asset remoto ${local.name}: digest SHA-256 ausente. Ação necessária: inspecionar o asset no GitHub; nenhum clobber será feito.`);
  }
  if (digest !== local.sha256) {
    throw new Error(`Conflito no asset remoto ${local.name}: conteúdo/tamanho difere do inventário local. Ação necessária: recuperar os artefatos originais ou reparar manualmente a release; nenhum clobber será feito.`);
  }
  return 'verified';
}

function assertUniqueAssets(release, assets) {
  for (const local of assets) {
    const matches = matchingRemote(release, local.name);
    if (matches.length > 1) throw new Error(`Release contém assets duplicados chamados ${local.name}.`);
  }
}

async function assertTagCommit(github, tag, expectedCommit) {
  const actual = await github.resolveTag(tag);
  if (actual && actual.toLowerCase() !== expectedCommit.toLowerCase()) {
    throw new Error(`Tag ${tag} aponta para ${actual}, não para o commit validado ${expectedCommit}. A tag não será movida.`);
  }
  return actual;
}

export async function reconcileRelease({
  github,
  inventory,
  commit,
  title = `Liquid Hub ${inventory?.version}`,
  notesPath = inventory?.notes?.path,
  makeLatest = true,
  log = () => {},
  retryDelayMs = 1500,
} = {}) {
  if (!github) throw new Error('Adaptador GitHub ausente.');
  if (!/^[a-f0-9]{40}$/i.test(commit || '')) throw new Error(`Commit Git válido é obrigatório: ${commit}`);
  if (!inventory?.tag || !inventory?.version) throw new Error('Inventário sem tag/versão.');
  if (!notesPath) throw new Error('Arquivo de notas ausente no inventário.');
  const assets = await readLocalAssets(inventory);
  const tag = inventory.tag;
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  let release = await github.getRelease(tag);
  if (release) {
    await assertTagCommit(github, tag, commit);
    assertUniqueAssets(release, assets);
  } else {
    await assertTagCommit(github, tag, commit);
    await github.createDraft({ tag, commit, title, notesPath });
    for (let attempt = 0; attempt < 5; attempt++) {
      release = await github.getRelease(tag);
      if (release) break;
      await wait(retryDelayMs);
    }
    if (!release) throw new Error(`Draft ${tag} não pôde ser lido após a criação.`);
  }

  // Detect every known conflict before the first mutation.
  for (const local of assets) {
    verifyRemoteAsset(matchingRemote(release, local.name)[0], local, { allowPendingDigest: true });
  }

  // Manifest is deliberately last: it is the updater's commit point.
  let uploaded = 0;
  for (const local of assets) {
    const remote = matchingRemote(release, local.name)[0];
    if (verifyRemoteAsset(remote, local, { allowPendingDigest: true }) === 'missing') {
      await github.uploadAsset({ tag, path: local.path, name: local.name });
      uploaded += 1;
      log(`upload: ${local.name}`);
    } else {
      log(`inalterado: ${local.name}`);
    }
  }

  for (let attempt = 0; attempt < 6; attempt++) {
    release = await github.getRelease(tag);
    if (release) {
      assertUniqueAssets(release, assets);
      const states = assets.map(local =>
        verifyRemoteAsset(matchingRemote(release, local.name)[0], local, {
          allowPendingDigest: true,
        }),
      );
      if (states.every(s => s === 'verified')) break;
      if (attempt === 5 && states.every(s => s === 'verified' || s === 'pending_digest')) break;
    }
    if (attempt < 5) await wait(retryDelayMs);
  }
  if (!release) throw new Error(`Release ${tag} desapareceu durante a reconciliação.`);
  assertUniqueAssets(release, assets);
  for (const local of assets) {
    const state = verifyRemoteAsset(matchingRemote(release, local.name)[0], local, {
      allowPendingDigest: true,
    });
    if (state === 'missing') {
      throw new Error(`Asset ${local.name} não apareceu na release ${tag} após o upload.`);
    }
  }

  if (!release.draft) {
    return { status: uploaded ? 'repaired' : 'no-op', tag, assets: assets.map(asset => asset.name) };
  }
  await github.publishDraft({ tag, latest: makeLatest });
  log(`publicada: ${tag}`);
  return { status: 'published', tag, assets: assets.map(asset => asset.name) };
}

function sanitized(message, env) {
  let text = String(message || 'erro desconhecido');
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN']) {
    if (env[key]) text = text.split(env[key]).join('[REDACTED]');
  }
  return text;
}

export function createGitHubCliAdapter({ repository, env = process.env, spawn = spawnSync } = {}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '')) {
    throw new Error(`Repositório GitHub inválido: ${repository}`);
  }
  const run = args => {
    const result = spawn('gh', args, { env, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    if (result.error) throw new Error(`Falha ao executar gh: ${sanitized(result.error.message, env)}`);
    if (result.status !== 0) {
      const stderr = sanitized(result.stderr || result.stdout, env);
      const error = new Error(`gh ${args[0]} ${args[1] || ''} falhou (status ${result.status}): ${stderr}`);
      if (/HTTP\s*404|Not Found/i.test(stderr)) error.status = 404;
      throw error;
    }
    return result.stdout || '';
  };
  const apiJson = async (args, allowMissing = false) => {
    try {
      return JSON.parse(run(args));
    } catch (error) {
      if (allowMissing && error.status === 404) return null;
      throw error;
    }
  };
  return {
    async getRelease(tag) {
      const published = await apiJson(
        ['api', `repos/${repository}/releases/tags/${encodeURIComponent(tag)}`],
        true,
      );
      if (published) return published;
      // GitHub's /releases/tags/{tag} endpoint returns 404 for draft releases; list includes drafts.
      const list = await apiJson(['api', `repos/${repository}/releases?per_page=100`], false);
      return Array.isArray(list) ? list.find(item => item?.tag_name === tag) || null : null;
    },
    async resolveTag(tag) {
      const ref = await apiJson(
        ['api', `repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`],
        true,
      );
      if (!ref?.object?.sha) return null;
      if (ref.object.type === 'commit') return ref.object.sha;
      const payload = await apiJson(
        ['api', `repos/${repository}/commits/${encodeURIComponent(tag)}`],
        true,
      );
      return payload?.sha || null;
    },
    async createDraft({ tag, commit, title, notesPath }) {
      run(['release', 'create', tag, '--repo', repository, '--draft', '--target', commit, '--title', title, '--notes-file', notesPath]);
    },
    async uploadAsset({ tag, path }) {
      // No --clobber: a race/conflict must fail and be diagnosed on the next rerun.
      run(['release', 'upload', tag, path, '--repo', repository]);
    },
    async publishDraft({ tag, latest }) {
      const args = ['release', 'edit', tag, '--repo', repository, '--draft=false'];
      if (latest) args.push('--latest');
      run(args);
    },
  };
}

function arg(name, envName) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || '' : process.env[envName] || '';
}

async function runCli() {
  const inventoryPath = resolve(arg('--inventory', 'RELEASE_INVENTORY') || 'src-tauri/target/release/release-artifacts.json');
  const inventory = JSON.parse(await readFile(inventoryPath, 'utf8'));
  const repository = arg('--repository', 'GITHUB_REPOSITORY') || inventory.repository;
  const commit = arg('--commit', 'GITHUB_SHA');
  if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) throw new Error('GH_TOKEN é obrigatório para publicar.');
  const github = createGitHubCliAdapter({ repository });
  const result = await reconcileRelease({
    github,
    inventory,
    commit,
    title: arg('--title', 'RELEASE_TITLE') || `Liquid Hub ${inventory.version}`,
    makeLatest: !process.argv.includes('--no-latest'),
    log: message => console.log(`[Liquid Hub] ${message}`),
  });
  console.log(`[Liquid Hub] Resultado: ${result.status} (${result.tag}).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
