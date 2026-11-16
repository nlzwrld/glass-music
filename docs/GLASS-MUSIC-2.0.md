# Glass Music 2.0 — implementação e validação

Reformulação implementada no projeto Tauri existente, instalada neste Windows e validada em 15–16/11/2026. Trabalho integrado com o chat de correção crítica do Liquid Glass, conforme autorização do usuário.

## O que mudou

- Sistema central de materiais Clear, Frosted, Floating e Subtle, com presets de opacidade, blur, refração, IOR aparente, Fresnel, reflexão especular, espessura, borda, tonalidade, raio, sombra e resposta ao cursor. Componentes pequenos usam material local; o WebGL fica concentrado nas superfícies permanentes.
- Shader WebGL2 compartilhado, refração nas bordas, reflectância de Schlick e highlights direcionais. Recorte considera ancestrais, rolagem, opacidade e cantos arredondados; nenhuma faixa diagonal global permanece no ambiente.
- Fundo dinâmico com extração de três cores por capa, cache de até 64 paletas e transição de 900 ms. Não processa imagens continuamente. Mantém fundos personalizados, cor sólida, ambiente neutro e transparência original do desktop.
- Sidebar Frosted, cápsula de navegação animada, recolhimento com ícones e escolha persistente. Playlists, importação por link, biblioteca, curtidas e histórico mantidos.
- Busca Clear com foco visível, atalho Ctrl+K, limpeza e indicador de consulta. Não foram inventadas sugestões que os serviços não fornecem.
- Cards priorizam capas quadradas, com hover, controles flutuantes, menu com curtida/fila/biblioteca, loading e fallback para capas indisponíveis. Imagens continuam lazy loaded.
- Player Floating em três áreas: faixa/favorito, transporte com timeline abaixo e ferramentas/volume. Área de interação da timeline tem 24 px; a faixa visual cresce no hover. Mini-player, fila, player lateral e expandido preservados.
- Segoe UI Variable, tokens de espaçamento, raios, cores e duração de animações. Grades adaptativas, fontes secundárias maiores e escala de 90–125%.
- Aparência centralizada até 1120 px, controles em duas colunas nas janelas largas e grupos independentes de configurações. Temas claro/escuro/sistema, intensidade de vidro/desfoque/reflexos, qualidade automática/Performance/Balanced/Ultra, escala, redução de animações e restauração visual. Restaurar mantém a imagem personalizada.

## Arquitetura e persistência

Tauri 2, React 19, Vite 8, Zustand, SQLite e Windows DPAPI mantidos. Nenhuma migração de framework. Preferências ópticas antigas de localStorage são lidas na migração; as escolhas passam a ficar em `preferences.appearance` no SQLite, com normalização, validação nativa e preservação dos demais ajustes. Bibliotecas pessoais não são substituídas por demonstrações.

A textura é o próprio canvas do ambiente visível. O shader refrata essa textura sincronizada; texto, ícones e controles permanecem em DOM real por cima. Ele **não captura o DOM arbitrário, capas de cards ou pixels de outras janelas/desktop**. O modo Área de trabalho continua com Acrylic nativo e material local. Fallback CSS é um fallback explícito, e não refração WebGL.

Há um contexto compartilhado, shader/textura reutilizados, buffers com resolução limitada, renderização sob demanda e pausa de efeitos ao minimizar. Qualidade automática consulta WebGL2, limite de textura, identificação de renderizador por software quando disponível e capacidade de CPU. Performance dispensa o WebGL; Balanced e Ultra alteram resolução e detalhe. Respeita a redução de movimento do sistema. As listas longas continuam virtualizadas por TanStack Virtual.

## Bibliotecas e referências

Nenhuma nova dependência de produção foi necessária. Foram aproveitados Motion 14.14, Lucide React 1.73, Zustand 5.1 e TanStack React Virtual 3.14 já presentes. A janela já usa Acrylic pela integração do Tauri com window-vibrancy. O shader adaptado existente mantém sua licença MIT e atribuição em `vendor/LICENSE`.

- [Hla-aung/liquid-glass](https://github.com/Hla-aung/liquid-glass): estudados o contexto compartilhado, Snell/IOR e mapas ópticos. A implementação traz Three.js e captura DOM; preferiu-se ampliar o WebGL2 existente, sem incorporar esse custo ou copiar código novo.
- [window-vibrancy](https://github.com/tauri-apps/window-vibrancy): Acrylic mantido; Mica não foi aplicado porque alteraria o fundo transparente pedido. O próprio projeto documenta diferenças de suporte e custo de redimensionamento.
- [Motion](https://motion.dev/docs/react) e [Lucide](https://github.com/lucide-icons/lucide): componentes e animações existentes estendidos.
- [Appllama/liquid-glass-screens](https://github.com/Appllama/liquid-glass-screens): referência visual React Native/Expo/Skia, GPL-3.0-only; nenhum código incorporado.
- [react-three-fiber](https://github.com/pmndrs/react-three-fiber), [drei](https://github.com/pmndrs/drei) e [vanilla-extract](https://github.com/vanilla-extract-css/vanilla-extract) avaliados; não agregados, pois duplicariam infraestrutura para este caso 2D.

## Testes executados

| Verificação | Resultado |
|---|---|
| TypeScript + produção Vite | Compilação concluída |
| Testes TypeScript | 31 passaram, incluindo cores/migração e recortes |
| Testes Rust | 27 passaram |
| Instalador NSIS | Criado; instalação silenciosa terminou com código 0; ProductVersion 2.0.0 |
| Nove E2E no executável instalado | 9 passaram, 0 falhas, 0 ignorados |
| Tamanhos 1280×720, 1366×768, 1600×900, 1920×1080 e 2560×1440 | Sem overflow horizontal ou sobreposição das três áreas do player |
| Sidebar compacta, escala 125%, Ctrl+K | Interação e persistência passaram |
| Fundo personalizado/solid/dinâmico/desktop e temas | Troca e persistência passaram; restauração preservou imagem; endereço local arbitrário foi rejeitado |
| Cores das capas | Paletas diferentes por faixa, extração cacheada |
| Reprodução | YouTube e SoundCloud reais; pausa, retomada, seek, troca, volume, fila e favoritos |
| Spotify/Deezer | Links tocando internamente pelo mecanismo de correspondência já existente; sem abertura automática de navegador |
| Playlists públicas | Importação nos quatro provedores e reimportação sem duplicatas |
| Busca/catálogo | Cliente e servidor reais com respostas externas controladas; paginação, falha parcial e recuperação |
| Cantos nativos | Normal, maximizado, desmaximizado, mini, restaurado e após minimizar |
| WebGL perdido/restaurado e Performance | Fallback funcionou e áudio continuou |
| Invisível/minimizado | Efeitos param e retomam ao restaurar |
| Navegação repetida | Teste de contagem de listeners/DOM passou sem crescimento além do limite de regressão |
| Erros JavaScript | Nenhum nos cenários aprovados; teste óptico específico também verificou console sem erros |

O teste óptico específico alterou **22.712 pixels dentro** de um recorte de teste, **zero fora** e **zero nos cantos excluídos**. Ao comparar refração 0 versus 10 no laboratório, 14,06% dos pixels de borda mudaram e 0% no centro. O ajuste padrão é mais sutil. As imagens de laboratório e as faixas locais de QA são fixtures isoladas, não dados adicionados à biblioteca do usuário.

Na RX 580 2048SP, a amostra óptica do instalado registrou zero redesenhos em dois segundos de repouso, 14.84 MB de heap JavaScript e 558.73 MB de working set da árvore de processos. O tempo de submissão de desenho medido é CPU, não tempo de execução da GPU. O contador de GPU estava em 0% na amostra de repouso; isso não é uma garantia de consumo nulo em toda situação. Testes de estresse curtos não provam ausência de vazamentos em sessões de vários dias.

## Preservação e pendências reais

Backup feito antes da edição e da instalação. A conferência da janela nativa detectou um redirecionamento do MSIX: a primeira instalação feita pelo ambiente do Codex atualizou sua cópia virtualizada, enquanto os atalhos comuns ainda abriam a 1.9 física. As duas bibliotecas eram distintas. Foram feitos backups SQLite consistentes de ambas, sem mesclá-las. O instalador foi então executado fora desse redirecionamento para atualizar também a instalação física.

A instalação física passou a ter exatamente o mesmo hash do executável 2.0 validado. Os atalhos da Área de trabalho e do Menu Iniciar apontam para ela e foram conferidos como versão 2.0.0. A biblioteca física original manteve suas 28 faixas, uma playlist e uma curtida; todas as linhas de músicas, associações, curtidas e histórico foram comparadas ao backup e preservadas. Todos os campos antigos de preferências e as demais configurações foram preservados. Apenas a migração esperada acrescentou a seção de aparência, mantendo Área de trabalho, qualidade Balanced, escala 100% e volume 7. A segunda biblioteca virtualizada permaneceu separada e preservada. A janela reaberta usa a instalação e a biblioteca físicas.

Login e sincronização de contas privadas continuam dependendo do cadastro oficial do Glass nas plataformas, ainda não fornecido; não foram apresentados como ativos. As integrações existentes foram preservadas. Resultados de busca, disponibilidade e correspondência de faixas dependem dos serviços. Não foi adicionado seletor de dispositivo de saída, pois esse recurso não existia no motor atual.

Validado neste Windows 11/WebView2 e nesta GPU. Outros computadores, Windows 10 e drivers diferentes não foram testados. Fallback foi exercitado por perda de contexto e perfil Performance. Instalador pessoal sem assinatura Authenticode.

## Arquivos criados

- `src/styles/design-system.css`
- `src/components/glass/Appearance.tsx`
- `src/components/glass/v3/ambient.ts`
- `src/components/glass/v3/clipping.ts`
- `tests/e2e/appearance.spec.ts`
- `tests/unit/appearance.test.ts`
- `tests/unit/clipping.test.ts`
- `scripts/capture-critical-baseline.mjs`
- `scripts/verify-critical-glass.mjs`

## Arquivos modificados

- `src/main.tsx`
- `src/pages/Home.tsx`
- `src/pages/Search.tsx`
- `src/pages/Settings.tsx`
- `src/stores/app.ts`
- `src/components/glass/Cover.tsx`
- `src/components/glass/GlassSearch.tsx`
- `src/components/glass/materials.tsx`
- `src/components/library/OnlineCatalog.tsx`
- `src/components/library/TrackCard.tsx`
- `src/components/player/GlassPlayer.tsx`
- `src/components/player/Player.tsx`
- `src/components/sidebar/Sidebar.tsx`
- `src/components/glass/v3/model.ts`
- `src/components/glass/v3/OpticalEngine.tsx`
- `src/components/glass/v3/renderer.ts`
- `src/components/glass/v3/scene.ts`
- `src/components/glass/v3/vendor/shaders.ts`
- `src-tauri/src/db.rs`
- `shared/types.ts`
- `tests/e2e/audio.spec.ts`
- `tests/e2e/catalog.spec.ts`
- `tests/e2e/collections.spec.ts`
- `tests/e2e/desktop.spec.ts`
- `tests/e2e/links.spec.ts`
- `tests/e2e/local.spec.ts`
- `tests/e2e/optics.spec.ts`
- `tests/e2e/window.spec.ts`
- `package.json`
- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.lock`
- `src-tauri/tauri.conf.json`
- `README.md`

O relatório de auditoria e as evidências completas acompanham o código em `docs/evidencias/release-200`. A implementação continua no projeto original; o ZIP contém o fonte editável e os recursos necessários, sem credenciais, bancos pessoais, node_modules ou produtos intermediários de build.
