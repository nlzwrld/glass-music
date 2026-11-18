# Liquid Hub 2.2

Hub centralizado de músicas, catálogos multiplataforma e sessões JAM ao vivo para Windows, com arquitetura Zero-Trust, design Matte compacto e motor óptico Liquid Glass opcional reativo aos graves.

## Recursos

- **Hub Multiplataforma**: biblioteca local, catálogos públicos e importação direta de links (YouTube, SoundCloud, Spotify, Deezer, Apple Music, Bandcamp e Tidal) com badges de origem.
- **Áudio & Ótica Reativa**: Dual-Deck com crossfade/fade, equalizador de 5 bandas, booster até +12 dB com limiter e modulação opcional de refração/brilho WebGL2 sincronizada aos graves em tempo real.
- **Shuffle Play & Fila Inteligente**: embaralhamento Fisher-Yates com início imediato em faixa aleatória, ciclo sem repetição e recomendações automáticas fora da playlist.
- **Letras Sincronizadas Condicionais**: verificação assíncrona via LRCLIB (exibindo o controle apenas quando há letras válidas) e janela destacada com fixação no topo (*Always on Top*).
- **JAM Híbrida Cloud + LAN**: sincronização de relógio com compensação de RTT em milissegundos, reconexão com *exponential backoff*, proteção anti-replay (`nonce` + `timestamp`), suporte a Cloudflare Workers + Durable Objects (WebSocket Hibernation) / Docker e fallback automático para rede local.
- **Segurança Zero-Trust**: OAuth2 com PKCE (`S256`) obrigatório, credenciais com `Argon2id`, Access Tokens JWT `Ed25519` de 15 minutos, rotação estrita de Refresh Tokens com invalidação de família em caso de reuso e armazenamento exclusivo no cofre DPAPI do Windows (zero tokens sensíveis em `localStorage`).

## Instalação e Dados

Use o instalador Windows publicado nas releases. Os dados locais ficam em `%APPDATA%\com.nlzwrld.liquidhub` (com migração automática de bibliotecas anteriores). Downloads offline permanecem acessíveis sem conexão.

## Compilação e Testes

Requisitos: Node.js 24+, pnpm 10, Rust estável (MSVC), C++ Build Tools e WebView2.

```powershell
pnpm install --frozen-lockfile
pnpm catalog:binaries
pnpm build
pnpm test
pnpm test:native
```

Os binários auxiliares em `assets/catalog/yt-dlp/` são desacoplados do Git e provisionados/verificados via SHA-256 automaticamente no build por `scripts/configure-catalog.mjs`.

Código original sob licença MIT. Veja [CHANGELOG.md](CHANGELOG.md), [docs/TERCEIROS.md](docs/TERCEIROS.md), [deploy/jam.md](deploy/jam.md) e [deploy/updates.md](deploy/updates.md).
