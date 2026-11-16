# Busca automática — Glass Music 1.9.0

O instalador inclui a busca pública do YouTube e SoundCloud. Não é necessário criar uma conta do Glass Music, fornecer chaves, copiar tokens ou hospedar um servidor.

1. Abra **Configurações → Integrações**, leia os termos e ative o acesso online uma vez.
2. **Início** e **Explorar** passam a mostrar resultados públicos das duas plataformas.
3. Use a barra superior para pesquisar; filtre por **Músicas**, **Artistas**, **Playlists** ou por plataforma. **Carregar mais resultados** busca a página seguinte.

Os resultados de busca chegam diretamente das plataformas. As seleções da página inicial correspondem a buscas por “música brasileira lançamentos” e “electronic music”; não são rankings oficiais nem recomendações baseadas em sua conta. “Todos” reúne as faixas locais e músicas das fontes online; artistas e playlists têm filtros próprios. Álbuns continuam agrupados pelos arquivos locais.

A busca usa o **yt-dlp 2026.10.26**, incluído no aplicativo, e um pequeno adaptador do Glass Music para os filtros públicos do SoundCloud. Não é preciso instalar Python ou outro aplicativo. O adaptador usa o identificador público do site, obtido automaticamente pelo yt-dlp; não usa credenciais pessoais. Não importa cookies do navegador, não acessa contas privadas e não salva arquivos de músicas. O SoundCloud usa seu widget oficial de áudio. Músicas do YouTube usam um fluxo público de áudio resolvido pelo yt-dlp e transmitido pelo núcleo do app, sem vídeo e sem abrir o navegador.

As plataformas recebem seu IP e os termos consultados. Biblioteca, arquivos, curtidas e histórico ficam no computador. A desativação das integrações cancela buscas em andamento e limpa o cache de resultados; não interfere na reprodução local. O cache em memória dura até cinco minutos. Cada fonte retorna até vinte itens por página, até dez páginas por pesquisa. As consultas têm limites de tempo e tamanho, e no máximo dois auxiliares de busca executam simultaneamente.

**Limites:** acesso público não oficial pode parar quando o site muda, limita consultas ou bloqueia um IP. Conteúdo privado, regional, removido ou que exige login pode não funcionar. O player do SoundCloud pode oferecer somente uma prévia em certas faixas; o YouTube pode restringir fluxos de áudio públicos. A sincronização de contas pessoais tem fluxo preparado, mas depende do cadastro oficial ainda pendente; veja `CONTAS-E-PLAYLISTS.md`. Não há remoção de anúncios ou promessa de reprodução de todo resultado.

O componente é fixado nesta versão e não se atualiza sozinho. Atualizações exigem uma nova edição do Glass Music. A opção de catálogo hospedado continua disponível para quem distribui o aplicativo: veja `INTEGRACOES-HOSPEDADAS.md`. A configuração vazia de `src-tauri/catalog.json` agora seleciona a busca direta incluída; não significa catálogo desativado.

Origem, versão, hashes e licenças: `assets/catalog/PROVENANCE.json`, `assets/catalog/yt-dlp-LICENSE` e `assets/catalog/yt-dlp-THIRD_PARTY_LICENSES.txt`. O arquivo de fontes correspondente do yt-dlp acompanha a entrega separadamente; os arquivos originais do Glass Music continuam editáveis no ZIP do projeto.

## Links sem abrir navegador

Adicionar uma faixa inicia a reprodução interna. Links Spotify e Deezer identificam a faixa e buscam uma versão correspondente no YouTube. Título, artista e duração são verificados; remixes, covers e versões ao vivo são rejeitados quando não pedidos. O ID original `link:` é preservado nas playlists e no histórico; somente o identificador público do áudio correspondente é acrescentado aos metadados. Nenhum arquivo de áudio, cookie ou credencial Spotify/Deezer é usado.

A identificação Spotify usa o oEmbed documentado e, quando disponível, os metadados públicos do embed para artista/duração. Esse segundo formato não é uma API estável e pode mudar. O áudio continua vindo do YouTube, indicado na linha da faixa. Referência: [Spotify oEmbed](https://developer.spotify.com/documentation/embeds/reference/oembed). Um link ou busca que não encontre versão compatível mostra erro local com tentativa de novo; reprodução nunca aciona abertura automática do navegador. Playlists públicas agora são expandidas em faixas; álbuns e artistas continuam sem expansão.
