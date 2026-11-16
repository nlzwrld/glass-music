import { readFile, writeFile } from 'node:fs/promises';
const raw = process.argv[2];
if (!raw) throw new Error('Informe a URL HTTPS do serviço publicado, ou --clear para usar a busca direta incluída.');
let catalogUrl = '';
if (raw !== '--clear') {
  const u = new URL(raw);
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || u.pathname !== '/') throw new Error('Use a origem HTTPS do catálogo, sem caminhos, credenciais ou parâmetros.');
  catalogUrl = u.origin;
}
const file = new URL('../src-tauri/catalog.json', import.meta.url);
await readFile(file, 'utf8');
await writeFile(file, JSON.stringify({ catalogUrl }, null, 2) + '\n');
console.log(catalogUrl ? `Catálogo definido: ${catalogUrl}. Gere o instalador com pnpm dist.` : 'Busca direta incluída selecionada. Gere o instalador com pnpm dist.');
