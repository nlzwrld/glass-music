# Changelog

Registro objetivo de alterações técnicas, arquiteturais e funcionais do **Liquid Hub** (anteriormente *Glass Music*).

---

## [2.3.x] — Liquid Hub (Pulse 2.0, Vídeo de Fundo, Stream Resolver & Anti-Spam)

### Pulse 2.0, Vídeo de Fundo & Downloads
- **Pulse 2.0 (Análise Musical DSP)**: separação temporal harmônico/percussiva (HPSS) com classificação de graves em 3 modos (`bass_sustain`, `bass_one_shot`, `bass_sequence`), detecção de bateria/percussão (`kick`, `snare`, `hi_hat`, `cymbal`, `tom`, `percussion`) e supressão vocal multi-sinal, compartilhada via `src/lib/musicEvents.ts`.
- **Vídeo de Fundo Sincronizado à Batida**: seleção segura de vídeo local com streaming HTTP `206 Partial Content` (`/bg-video/<id>`), áudio silenciado automaticamente, modulação suave de `playbackRate` orientada pelos eventos musicais e controles dedicados em Aparência.
- **Interface de Downloads Simplificada**: remoção de filtros redundantes, badges de status/contagem e descrições textuais excessivas para uma visualização mais limpa.

### Rebranding & Arquitetura Desktop
- **Identidade Liquid Hub (`com.nlzwrld.liquidhub`)**: renomeação completa de metadados, empacotamento Tauri/NSIS, crate Rust (`liquid-hub`), títulos de janela, bandeja do sistema, cabeçalhos de serviços (`server/`) e plugins de catálogo (`assets/catalog/plugins/liquid_hub/`).
- **Migração Automática de Perfil**: importação transparente de bancos SQLite, capas e arquivos offline legados (`com.glassmusic.desktop`) na inicialização quando o novo diretório de dados ainda não possui biblioteca.
- **Ótica WebGL2 Reativa ao Áudio (`u_bass`)**: extração em tempo real das bandas de grave e sub-grave (`20–185 Hz`) em `AudioGraph` conectada ao shader óptico (`OpticalEngine` / `renderer.ts`) para modulação opcional de refração e brilho sincronizada com a faixa em reprodução.

### Motor de Resolução Multi-Plataforma (`Cross-Platform Stream Resolver`)
- **Desacoplamento entre Catálogo e Stream**: separação explícita no contrato `Track` entre `catalogSource` (`spotify`, `deezer`, `ytmusic`, `youtube`, `soundcloud`, `local`) e `streamProvider`, preservando metadados ricos originais (`title`, `artist`, `album`, `artwork`, `isrc`, `durationMs`) em faixas e playlists importadas do Spotify.
- **Busca Paralela & Ranking Determinístico (`0–100`)**: resolução simultânea em **YouTube Music (Topic / Official Audio)**, **Deezer**, **SoundCloud** e **YouTube** (`src-tauri/src/resolver.rs`, `desktop/providers/resolver.ts` e `GET /v1/resolve` em `server/catalog.ts`).
- **Filtragem Estrita de Fidelidade**: validação de delta de duração (`<= 2 s` ideal; rejeição automática de vídeos com introduções/outros longos `> 18 s` e prévias DRM de `30 s`) e bloqueio de versões `Live`, `Ao Vivo`, `Cover`, `Remix`, `Slowed`, `Reverb`, `Karaoke` ou `Instrumental` quando ausentes no título original.
- **Fallback em Cascata**: tentativa ordenada entre provedores (`YT Music -> SoundCloud -> YouTube`) em caso de indisponibilidade, bloqueio regional ou link expirado.
- **Cache Persistente SQLite (`track_stream_mappings`)**: gravação local do vínculo `catalogId -> resolvedExternalId / streamProvider` com hidratação imediata na abertura do app e invalidação automática quando o link de áudio expira.
- **Prefetch Gapless & Transparência na UI**: pré-resolução em segundo plano da próxima faixa da fila, estado `"Sincronizando fonte de áudio..."`, badge duplo (`Importado do Spotify • Tocando via YT Music`) e modal **"Trocar fonte de áudio"** no menu de contexto da faixa.

### Política Anti-Spam de Notificações
- **Separação entre Sessão de Mídia do SO e Pop-ups**: atualização em tempo real dos controles nativos de mídia (`navigator.mediaSession`, Windows SMTC, tooltip da bandeja) desacoplada do disparo de notificações visuais.
- **Supressão Inteligente em Foco**: bloqueio integral de notificações externas de troca de faixa quando a janela principal está visível ou em foco (`document.visibilityState === 'visible'` / `window.is_focused()`).
- **Proteção contra Skip-Spam**: *debounce* de `3000 ms` somado à exigência de reprodução estável (`currentTime > 2.5 s` e `isPlaying === true`) e deduplicação por `lastNotifiedTrackId` (`TrackNotificationController` + `NotificationGate`).
- **Substituição Silenciosa em Slot Único**: reutilização de identificador fixo (`id: 1001`, `tag: 'liquid-hub-now-playing'`, `renotify: false`, `silent: true`) sem alertas sonoros nem empilhamento na central do Windows.
- **Preferência Explícita em Configurações**: seletor **"Notificações ao trocar de faixa"** com 3 modos: `Desativado (Silencioso)` (padrão), `Apenas em segundo plano (Sem spam)` e `Sempre`.

### Player, Biblioteca & Letras
- **Shuffle Play (`Fisher-Yates`)**: botão **Aleatório** em Biblioteca e Playlists com sorteio sem viés e início imediato da reprodução.
- **Botão de Letras Condicional**: sondagem assíncrona via LRCLIB (`probeLyrics`) que oculta o controle de letras em faixas instrumentais ou sem letra catalogada.
- **Janela de Letras Destacada**: botão **Fixar no topo** (*Always on Top*) integrado à barra superior da janela independente de letras.
- **Indicadores Visuais**: badges compactos de plataforma em listas/cards, indicador de faixa disponível offline, ponto indicador de fila ativa e selo `JAM` ao vivo na barra lateral.

### Infraestrutura JAM Híbrida (Cloud + LAN)
- **Deploy Edge & Containers Gratuitos**: suporte nativo a Cloudflare Workers + Durable Objects (`JamRoomDO` com *WebSocket Hibernation* em `deploy/wrangler.jam.toml`) e containers leves (`server/Dockerfile.jam`, `deploy/fly.jam.toml`), com delta sync por `sinceSequence` e compressão gzip.
- **Sincronização de Relógio & Compensação de Drift**: medição periódica de RTT (`ping`/`pong`) e microajuste suave de `playbackRate` para corrigir desvios de tempo entre participantes sem cortes audíveis.
- **Failover Automático `Cloud -> LAN`**: reconexão com *exponential backoff* e migração transparente para descoberta local via UDP (`43879`) em caso de queda do servidor remoto.

### Segurança Zero-Trust & Build
- **Autenticação Endurecida**: fluxo OAuth2 + PKCE (`S256`) obrigatório no broker, hashing de senhas com `Argon2id`, Access Tokens JWT `Ed25519` de 15 minutos verificados via `/.well-known/jwks.json` e rotação estrita de Refresh Tokens com revogação imediata da família em caso de reuso.
- **Proteção de Fronteira e Armazenamento**: validação anti-replay (`nonce` + `timestamp`) nos comandos de JAM, schemas Zod `.strict()` nas fronteiras IPC/HTTP e armazenamento exclusivo de segredos no cofre DPAPI do Windows com limpeza ativa de `localStorage`/`sessionStorage` (`purgeSensitiveWebStorage()`).
- **Higiene de Repositório**: remoção dos binários pesados de `assets/catalog/yt-dlp/` do controle de versão Git, substituídos por download sob demanda no build com verificação criptográfica SHA-256 (`scripts/configure-catalog.mjs --ensure-binaries`).

---

## [2.2.0] — Interface Matte, Biblioteca & Atualizações

### Alterado
- **Redesign Minimalista Matte**: superfícies foscas sólidas, tipografia compacta, listas densas e hierarquia objetiva inspirada em *Sleek*, *Matte* e *Feishin*, mantendo o motor Liquid Glass selecionável em Configurações.
- **Menu Unificado na Barra Lateral (`+`)**: consolidação das ações **Nova playlist**, **Importar por link** e **Adicionar arquivos** diretamente no botão `+` de Playlists.

### Adicionado
- **Aviso de Atualização Integrado**: barra superior não intrusiva com botão **Atualizar agora**, backup automático do SQLite antes da aplicação do instalador assinado e verificação periódica via manifesto `latest.json`.
- **Áudio Offline, Transições Dual-Deck & JAM Local**: armazenamento local seguro em `profile/offline/`, crossfade/fade entre faixas, janelas destacadas de letras e salas JAM em rede local.

### Corrigido
- **Capas Individuais em Playlists Importadas**: correção do mapeamento de metadados que replicava a capa da coleção sobre todas as faixas importadas de uma playlist externa.
- **Ciclo de Embaralhamento e Buffering Inicial**: prevenção de repetições antes do término do ciclo completo da fila e redução da latência inicial de áudio com *ranges* HTTP delimitados e pré-buffer InnerTube.
