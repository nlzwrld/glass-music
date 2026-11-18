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

## 3. Fallback Híbrido Cloud / LAN

- Se o endpoint Cloud falhar ou perder conectividade, o **Liquid Hub** aciona automaticamente o coordenador embutido em `src-tauri/src/jam_lan.rs` + descoberta UDP local (`239.255.77.88` / broadcast local) via `src/lib/discovery.ts`, mantendo a sala viva na rede privada sem interromper a música.
- Defina `LIQUID_JAM_URL` (ou `GLASS_JAM_URL`) no build ou configure o endereço HTTPS em **Configurações → JAM**.
