# Glass Music 2.0.1 — fundo e temas até o contorno externo

Correção implementada e instalada em 16/11/2026.

A faixa transparente da imagem tinha uma causa de layout: `.app` aplicava 14 px de padding ao redor de `.optical-root`. Os dois canvases, responsáveis pelo ambiente e pelo vidro, pintavam somente essa área interna. O Acrylic do Windows continuava visível na margem externa, enquanto o restante recebia o fundo colorido.

O recuo foi transferido para o conteúdo de `.optical-root`. A camada de fundo agora cobre toda a área cliente, incluindo topo, base e laterais, enquanto sidebar, busca e player mantêm seus espaçamentos. Raiz e canvases compartilham o arredondamento externo; a borda fina usa a cor do tema. O laboratório recebeu margens equivalentes para continuar afastado do player. Não houve alteração nos serviços musicais.

Arquivo visual alterado: `src/styles/design-system.css`. Acrescentado o teste `tests/e2e/edges.spec.ts`; versões e documentação foram atualizadas para 2.0.1.

## Verificação executada

- Build de produção e instalador NSIS concluídos.
- Cinco cenários E2E passaram no executável físico instalado, iniciado fora do redirecionamento MSIX: margens/temas, aparência/persistência, óptica/fallback, áudio local e cantos nativos/estados da janela.
- O teste de margens mediu os quatro lados em 16 combinações: Escuro/Claro × Ambiente/Dinâmico/Cor sólida/Personalizado × WebGL/Performance. Os pixels amostrados ficaram totalmente cobertos e a base clara/escura acompanhou o tema. O retângulo do canvas alcança a área cliente até a borda de 1 px.
- Área de trabalho continua sendo uma escolha transparente aplicada à janela inteira; não há faixa de outro modo ao redor dela.
- Laboratório, menus e diálogos continuaram acessíveis. Os testes de aparência mantiveram os cinco tamanhos de janela, sidebar compacta e persistência.
- O instalador foi executado na instalação física usada pelo atalho e terminou com código 0. Todas as linhas da biblioteca e todas as configurações foram comparadas ao backup e preservadas. O binário instalado corresponde ao build, com apenas o marcador esperado do NSIS.

Capturas e resultados estão em `docs/evidencias/release-201`. Validado neste Windows 11/WebView2. A integração de contas privadas mantém a pendência de cadastro oficial já documentada na 2.0.
