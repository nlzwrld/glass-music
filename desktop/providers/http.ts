export async function jsonFetch(url: string | URL, init: RequestInit = {}): Promise<any> {
  const timeout = AbortSignal.timeout(15000);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  let response: Response;
  try { response = await fetch(url, { ...init, signal, redirect: 'error' }); }
  catch (e) { if (init.signal?.aborted) throw e; throw new Error('Não foi possível conectar. Verifique sua conexão e tente novamente.'); }
  if (!response.ok) {
    if (response.status === 401) throw new Error('A credencial expirou ou não é válida. Verifique as integrações.');
    if (response.status === 403) throw new Error('Acesso negado, cota esgotada ou conteúdo restrito pela plataforma.');
    if (response.status === 404) throw new Error('Conteúdo não encontrado ou indisponível.');
    if (response.status === 429) throw new Error('Limite de consultas atingido. Aguarde antes de pesquisar novamente.');
    throw new Error(`A plataforma não respondeu como esperado (${response.status}).`);
  }
  return response.json();
}
export function durationISO(value: string): number { const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(value); return m ? Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) : 0; }
export function decodeTitle(t: string): string { return t.replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>'); }
