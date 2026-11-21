# Liquid Hub JAM — Arquitetura Cloud & LAN

O coordenador JAM sincroniza faixa, play/pause e posição com compensação de RTT em milissegundos, proteção anti-replay (`nonce` + `timestamp`), compressão delta/gzip e fallback híbrido automático para a rede local (LAN). Nenhum arquivo local ou fluxo de áudio transita pelo servidor.

## 1. Deploy Gratuito em Cloudflare Workers + Durable Objects (WebSocket Hibernation)

Usa `new_sqlite_classes` (compatível com o plano gratuito da Cloudflare) e `WebSocketRequestResponsePair` para manter conexões hibernadas sem consumo de CPU quando ociosas:

```bash
npx wrangler deploy --config deploy/wrangler.jam.toml
```

## 2. Deploy em Container (Oracle Cloud Free Tier ARM64/AMD64 ou Fly.io)

### Docker / Oracle Cloud Free Tier
```bash
docker build -f server/Dockerfile.jam -t liquid-hub-jam .
docker run -d --read-only --tmpfs /tmp -p 8789:8789 liquid-hub-jam
```

### Fly.io (com auto-suspend)
```bash
fly deploy --config deploy/fly.jam.toml
```

### IP real e proxies confiáveis (Node)

- Em conexão direta, o coordenador usa somente `remoteAddress`; cabeçalhos `X-Liquid-Client-IP`, `X-Glass-Client-IP` e `Fly-Client-IP` enviados pelo cliente são ignorados.
- No Compose, o Caddy tem IP fixo `172.30.0.2` e sobrescreve `X-Liquid-Client-IP`. Somente esse IP consta em `JAM_TRUSTED_PROXY_IPS` (lista separada por vírgulas), seguindo o mesmo modelo do catálogo.
- O perfil da Fly ativa explicitamente `JAM_TRUST_FLY_CLIENT_IP=1`, pois o acesso ocorre pelo proxy da plataforma. Não ative essa opção em exposição direta nem atrás de outro proxy.

### Limites e concorrência

- Node usa cotas HTTP por IP (30 entradas/minuto e 1800 operações ativas/minuto, por padrão), por membro e por sala. Comandos autenticados não descontam duas vezes o IP. Os limites podem ser ajustados com `JAM_ENTRY_REQUESTS_PER_MINUTE`, `JAM_ACTIVE_REQUESTS_PER_MINUTE`, `JAM_ROOM_ENTRY_REQUESTS_PER_MINUTE` e `JAM_ROOM_REQUESTS_PER_MINUTE`.
- WebSocket Node limita conexões globalmente (`JAM_WS_MAX_CONNECTIONS`, padrão 10000), por IP (100), membro (4) e sala (64). Há heartbeat de 30 s, timeout de 90 s, buffer de entrada de 32 KB, frames de até 16 KB e fechamento ao exceder 256 KB de saída pendente. `JAM_WS_HEARTBEAT_MS` e `JAM_WS_TIMEOUT_MS` ajustam os tempos.
- No Cloudflare, somente o Worker lê e valida `CF-Connecting-IP`; ele remove esse cabeçalho e sobrescreve `X-Liquid-Client-IP` antes de chamar o DO. O DO nunca confia em `CF-Connecting-IP` recebido diretamente.
- `create`, `join`, `sync` e `leave` exigem nonce + timestamp como no modo strict do Node. A janela padrão é 60 s (`JAM_REPLAY_WINDOW_MS`). O cache do DO tem expiração, capacidade limitada (`JAM_NONCE_LIMIT`, padrão 4096) e é persistido com a sala para sobreviver à hibernação. O cache de ping do Worker é limitado por isolate.
- O limite de corpo de 16 KB é aplicado durante a leitura do stream, mesmo sem `Content-Length`. Cada DO contém no máximo uma sala e oito membros; sockets são limitados por sala, membro e IP e fechados por tag em leave, prune e alarm.

**Limite best-effort de isolate:** rate limits do Worker, cache anti-replay de `ping` e `JAM_MAX_ROOMS_PER_ISOLATE` (padrão 2500 criações por TTL, por namespace `JAM_ROOMS`) são estado local do isolate e **não formam um contador global consistente entre isolates**. Eles reduzem floods e crescimento descontrolado, mas não devem ser tratados como inventário global de salas. Autorização de token, propriedade da sala, nonces persistidos, limites de membros e cotas de membro/sala são aplicados no Durable Object correspondente. Em Node, `JAM_MAX_ROOMS` continua sendo o limite global daquele processo.

## 3. Fallback Híbrido Cloud / LAN

- Se o endpoint Cloud falhar ou perder conectividade, o **Liquid Hub** aciona automaticamente o coordenador embutido em `src-tauri/src/jam_lan.rs` + descoberta UDP local (`239.255.77.88` / broadcast local) via `src/lib/discovery.ts`, mantendo a sala viva na rede privada sem interromper a música.
- Defina `LIQUID_JAM_URL` (ou `GLASS_JAM_URL`) no build ou configure o endereço HTTPS em **Configurações → JAM**.
