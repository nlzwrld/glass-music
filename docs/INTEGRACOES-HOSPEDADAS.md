# Catálogos compartilhados — Glass Music 1.4.0

Quem instala o Glass Music não precisa criar chaves, informar tokens ou hospedar um servidor. O responsável pelo aplicativo configura as credenciais uma única vez no serviço compartilhado. O instalador recebe somente o endereço público HTTPS.

**Esta entrega está preparada, mas ainda não está conectada a um serviço publicado.** `src-tauri/catalog.json` contém `catalogUrl` vazio. Após o consentimento, o aplicativo informa que os catálogos estão em preparação. Links públicos continuam usando os players oficiais, sem chave de pesquisa. Não há resultados fictícios no aplicativo entregue.

## Para quem usa o aplicativo

1. Abra **Configurações → Integrações** e leia a explicação de privacidade e os termos.
2. Ative **Li os termos e quero ativar as integrações**.
3. Use **Abrir um link de música** para ouvir links públicos do YouTube ou SoundCloud.
4. Em uma edição conectada ao serviço, Início e Explorar carregam seleções públicas automaticamente, e a busca consulta as duas fontes.

Não há campos de API ou servidor nessas telas. A disponibilidade final depende da plataforma. Não há login pessoal, sincronização de curtidas/playlists privadas, download ou reprodução offline do streaming.

## Ativação pelo responsável pelo Glass Music

São necessários um servidor com Docker Compose, um domínio apontado para ele e as credenciais de desenvolvedor do projeto. A criação de contas, contratação de hospedagem e publicação não foram feitas nesta entrega.

### 1. Credenciais do projeto

- **YouTube:** crie um projeto, habilite a YouTube Data API v3 e obtenha uma chave conforme o [guia oficial](https://developers.google.com/youtube/data/getting-started). Restrinja a chave à API e, quando possível, ao IP de saída do servidor. Verifique a cota no console do projeto.
- **SoundCloud:** registre um aplicativo de desenvolvedor e obtenha `client_id` e `client_secret`, seguindo o [guia oficial](https://developers.soundcloud.com/docs/api/guide). O serviço usa Client Credentials para recursos públicos; nenhuma conta dos ouvintes é necessária.

Guarde essas três credenciais somente no servidor. Nunca as coloque no frontend, em `catalog.json`, no instalador, no ZIP público ou em uma URL.

### 2. Serviço HTTPS

Copie o projeto para o servidor. Dentro da pasta `deploy`, copie `catalog.env.example` para `.env` e preencha o domínio real e as três credenciais. O arquivo também permite configurar a região e os limites de requisições. Mantenha `.env` fora do controle de versão e dos pacotes de distribuição.

Libere as portas 80/443 do servidor e aponte o DNS do domínio para ele. Na pasta `deploy`, execute:

```sh
docker compose --env-file .env config --quiet
docker compose --env-file .env up -d --build
```

O Caddy fornece HTTPS e encaminha ao catálogo pela rede interna. O catálogo não publica a porta 8788 no host, roda sem root e com sistema de arquivos somente para leitura. Se `172.30.0.0/24` já estiver em uso, ajuste a sub-rede, os dois endereços fixos e `CATALOG_TRUSTED_PROXY_IPS` no Compose.

Teste `https://SEU_DOMINIO/health`: `providers` indica presença da configuração, não comprova credenciais válidas. Teste também `/v1/discover` e `/v1/search?source=youtube&kind=track&q=ambient`, repetindo a busca para `source=soundcloud`. Só considere a ativação concluída depois de receber faixas reais das duas fontes e reproduzi-las no app.

### 3. Vincular o instalador

Na raiz do projeto, em seu computador de desenvolvimento:

```powershell
pnpm configure:catalog https://catalog.seu-dominio.com
pnpm dist
```

O comando salva apenas a origem HTTPS em `src-tauri/catalog.json`; ele não verifica se o serviço está publicado. Distribua o novo instalador gerado em `src-tauri/target/release/bundle/nsis/` (ou em `CARGO_TARGET_DIR`). Todos os usuários dessa edição passam a usar o mesmo serviço depois do consentimento.

**O instalador 1.4.0 entregue com URL vazia precisa ser substituído por uma compilação com a URL real.** Publicar o servidor sozinho não altera instaladores já gerados. Depois de configurar um domínio estável, mudar o servidor por trás desse domínio não exige outro instalador. Atualizações automáticas ainda não estão configuradas.

Para gerar novamente uma edição sem catálogo: `pnpm configure:catalog --clear`.

## Desenvolvimento e limites

Com Node.js 24+, preencha `deploy/.env` e execute `pnpm catalog`. O serviço escuta em `127.0.0.1:8788` por padrão. Não é necessário Node no computador de quem usa o player.

Os testes nativos usam `GLASS_TEST_DATA` com um perfil descartável e `GLASS_TEST_CATALOG_URL` para loopback. A substituição só é aceita com perfil de teste explícito; não aparece nas configurações do usuário.

- `/v1/discover`: YouTube `videos.list` com `mostPopular`, categoria música e região BR; SoundCloud, busca pública por `electronic`. As seleções não usam histórico pessoal. [Referência YouTube](https://developers.google.com/youtube/data/reference/rest/v3/videos/list).
- `/v1/search`: faixas, artistas e playlists; paginação com identificadores opacos vinculados a fonte, termo e tipo. Não aceita URLs arbitrárias como cursor.
- Cache em memória: 5 minutos para buscas e 10 para descoberta; consultas simultâneas idênticas são agrupadas. Respostas parciais/falhas não ficam no cache, permitindo tentar novamente após a recuperação.
- Limites por IP, limite global de consultas não armazenadas e teto local de buscas YouTube. O padrão de 90 buscas/dia é uma escolha conservadora do app, não uma promessa da plataforma. O contador usa a data de Los Angeles e reinicia com o processo. As cotas reais continuam sendo impostas pelos provedores. Configure orçamento/alertas e compartilhe contadores/cache antes de usar várias réplicas.
- Tokens OAuth SoundCloud são reutilizados/renovados no servidor. Chaves e tokens não são devolvidos ao desktop. Respostas têm limite de tamanho e redirecionamentos não são seguidos.
- IP e termo são recebidos para responder e limitar abuso. Contadores de IP ficam em memória por até cerca de 90 segundos; termos podem permanecer no cache por 5 minutos e cursores por até 30 minutos. O código não grava logs de buscas. Verifique também os logs da hospedagem/proxy.
- Histórico, curtidas, playlists e caminhos de arquivos locais não são enviados ao catálogo. Imagens e players podem conectar-se diretamente às plataformas após o consentimento.
- A migração preserva biblioteca/preferências. O consentimento do novo catálogo começa desativado inclusive para quem já havia autorizado os players da edição anterior.

## Players e compatibilidade

YouTube usa a [IFrame Player API](https://developers.google.com/youtube/iframe_api_reference); SoundCloud usa a [Widget API](https://developers.soundcloud.com/docs/api/html5-widget). O vídeo do YouTube permanece visível e é pausado ao ocultar a janela. Não há extração de áudio, remoção de anúncios ou equalizador aplicado ao streaming.

O núcleo Rust valida as respostas; players externos ficam isolados da ponte nativa. Metadados/capas remotos expiram após 28 dias, preservando referências. Credenciais pessoais de edições antigas continuam protegidas pela DPAPI e podem ser usadas como compatibilidade sem catálogo configurado. Elas não são copiadas para o serviço. `server/broker.ts` e `.env.example` permanecem como exemplos legados.

## Validação

Consulte `VALIDACAO-1.4.md`. Descoberta/buscas autenticadas são verificadas com respostas simuladas das plataformas; desktop e servidor HTTP são reais. Publicação Docker/HTTPS e consultas com as credenciais definitivas dependem da infraestrutura do responsável pelo aplicativo.
