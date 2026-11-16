# Validação — Glass Music 1.4.0

Data: 15/11/2026. Ambiente: Windows x64, aplicativo instalado por usuário, Tauri + WebView2. Esta entrega conclui a preparação do catálogo compartilhado, preservando a interface Liquid Glass V2 e a biblioteca existente.

## Estado da entrega

- Instalador 1.4.0 compilado e instalado com código de saída 0.
- Nenhum usuário precisa preencher chaves, tokens ou endereço de servidor nas configurações.
- Serviço de catálogo, limite de consultas, cache, paginação e configuração Docker/Caddy incluídos no código-fonte.
- **Catálogo público ainda não publicado:** a URL embutida está vazia. O aplicativo informa essa pendência; não apresenta faixas simuladas como resultados reais.
- Ativação futura: credenciais no servidor, publicação HTTPS e nova compilação com o domínio real, conforme `INTEGRACOES.md` (ou `Ativar-catalogos.md` na pasta da entrega).

## Verificações executadas

| Área | Resultado |
| --- | --- |
| Produção | TypeScript sem erros; build Vite e instalador NSIS concluídos. |
| Código/servidor | 22 testes Vitest aprovados, incluindo cache, consultas simultâneas, paginação opaca, limites, isolamento de falhas e ausência de credenciais nas respostas. |
| Núcleo Windows | 13 testes Rust aprovados: validação de catálogo, DPAPI, persistência, transações, URLs, histórico, áudio e migração de preferências. |
| Interface instalada | 2 testes Playwright completos aprovados em 41 segundos, com aplicativo Tauri e armazenamento SQLite reais. |
| Catálogo integrado | Servidor HTTP real com respostas de plataformas **simuladas**: nenhuma consulta antes do consentimento; duas fontes na descoberta; pesquisa/paginação de 2 para 4 itens; falha de uma fonte sem derrubar a outra; recuperação imediata; revogação bloqueando novas consultas. |
| Edição sem hospedagem | Nenhum campo de chave/servidor na tela; aviso de catálogo em preparação; links públicos disponíveis após consentimento. |
| Reprodução local | Relógio real, seek, pausa, volume, anterior/próxima e painéis sincronizados. Ativar/desativar o acesso online mantém a música local pausada na mesma posição. |
| Biblioteca e preferências | Playlist, curtida e histórico persistem após encerrar/reabrir no perfil de teste. Banco pessoal comparado integralmente com o backup após os testes: inalterado. |
| Layout | Cinco resoluções: 1920×1080, 1672×941, 1600×900, 1366×768, 920×650; sem sobreposição do player com sidebar/conteúdo. Catálogo também verificado a 920×650 sem overflow horizontal. |
| YouTube ao vivo | Link público reproduzido no player oficial; posição avançou, duração sincronizada e acesso de escrita à ponte nativa bloqueado. |
| SoundCloud ao vivo | Link público reproduzido no widget oficial; posição avançou, duração sincronizada e acesso de escrita à ponte nativa bloqueado. |
| Troca de fonte | Retorno dos players externos para áudio local; iframe externo oculto e um único elemento local de áudio. |
| Serviço standalone | Execução direta no Node 24.22.1 com `/health` e `/v1/discover`; sem credenciais, retorna zero seleções e os avisos corretos. |

## Correções concluídas durante a retomada

1. Respostas de busca com falhas parciais deixam de ficar presas no cache nativo por cinco minutos.
2. A mudança de consentimento online afeta somente players externos; não reinicia nem retoma arquivos locais.
3. Guias e exemplos deixam de orientar cada usuário a fornecer credenciais próprias. Arquivos antigos de broker estão identificados como compatibilidade legada.
4. Instalação, código-fonte e guias entregues correspondem à versão 1.4.0.

## Evidências e limites

Dentro do código-fonte, `docs/evidencias/catalog-1.4/` contém relatórios e capturas desta rodada. `catalog-fixture-home.png` mostra dados de teste, não o catálogo publicado. `installed-home.png`, `live-youtube.png` e `live-soundcloud.png` são capturas do executável instalado. Relatórios anteriores permanecem separados como histórico.

Não foram testados: publicação Docker/Caddy, domínio/TLS real, buscas autenticadas com credenciais definitivas, carga em produção ou instalação em outro computador. Docker não está disponível neste ambiente; os arquivos de implantação foram revisados, mas não executados. As plataformas continuam controlando credenciais, cotas e disponibilidade de mídia.

A integração não oferece sincronização de contas pessoais, downloads de streaming ou reprodução invisível do YouTube. O instalador continua sem assinatura Authenticode e sem atualização automática; essas limitações da distribuição anterior permanecem.

Um backup do executável anterior e do banco pessoal foi mantido na pasta `work` da retomada. Testes usam perfis separados. Credenciais e dados pessoais não entram no ZIP de código-fonte.
