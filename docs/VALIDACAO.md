# Relatório de entrega — 15/11/2026

Este relatório registra a versão 1.3.0. Para a entrega atual e os catálogos compartilhados, consulte [VALIDACAO-1.4.md](VALIDACAO-1.4.md).

## Versão e ambiente

Glass Music 1.3.0, Windows x64. Stack final: Tauri 2, núcleo Rust, React, componentes shadcn/ui (Button, Switch e Input), Tailwind CSS, Motion e liquid-glass-react 1.1.1. O instalador usa NSIS e não inclui Electron ou um processo Node para executar o aplicativo. Node é necessário somente para desenvolvimento ou para o servidor SoundCloud opcional.

Ambiente verificado: Windows 11 Pro, versão 10.0.26200, WebView2 instalado, tela do aplicativo em 1672 × 941. O instalador 1.3.0 por usuário foi executado com código de saída 0. A versão instalada foi testada em perfil isolado; em seguida o aplicativo foi aberto normalmente, com o perfil do usuário. Windows 10 e outros computadores não foram testados nesta sessão.

A V2 atualiza o fundo interno e os materiais: [LIQUID-GLASS-V2.md](LIQUID-GLASS-V2.md). Mantém a correção que removeu o cenário externo e a moldura duplicada e separou o player do conteúdo: [CORRECAO-JANELA.md](CORRECAO-JANELA.md). As seis iterações anteriores permanecem como histórico em [RECUPERACAO-VISUAL.md](RECUPERACAO-VISUAL.md).

## Evidências e resultados

| Área | Resultado observado |
| --- | --- |
| TypeScript e produção | Verificação de tipos e build Vite concluídos. |
| Contratos e servidor | 15 testes Vitest aprovados: quatro testes do campo de refração (centro, bordas opostas, curvas e largura do bisel), além dos contratos de provedores oficiais, paginação, duração, falhas, cancelamento, cache, validação de URLs/dados e proteção/reutilização de tokens do servidor SoundCloud. As respostas de busca autenticada nesses testes são simuladas. |
| Núcleo nativo | 10 testes Rust aprovados na validação da 1.2.1; núcleo sem mudanças funcionais na 1.3.0: SQLite e transações, importação atômica, reordenação, histórico limitado, validação de URLs, proteção DPAPI real do Windows, faixas de bytes para seek, duração e leitura de metadados de um WAV real. |
| Aplicativo real | Suíte Playwright executada contra o WebView2 do executável Tauri, também na versão instalada. Não usa um backend simulado. |
| Reprodução local | Duração real de 48 s exibida antes do primeiro play; seek inicialmente desabilitado. Após play, o motor informou 48 s e o relógio avançou. Seek acima de 13 s, pausa estável, volume 25% refletido no elemento de áudio, próxima/anterior e sincronização dos dois painéis passaram. Um único elemento local de áudio. |
| Biblioteca | Playlist criada pela interface, faixa adicionada, curtida e histórico registrados. A biblioteca permaneceu em SQLite após encerrar o processo e reabrir. |
| Aparência | Temas claro/escuro, player expandido e mini-player exercitados; capturas incluídas. Cinco resoluções verificadas: 1920 × 1080, 1672 × 941, 1600 × 900, 1366 × 768 e 920 × 650. Janela preenchendo toda a área nativa, com fundo procedural interno e sem cenário externo ou janela duplicada. Conteúdo, sidebar e configurações separados do player por pelo menos 12 px (16 px no layout). Sem overflow horizontal; botão ao final da rolagem acessível. |
| Nova interface | Navegação voltar/avançar, busca pelo cartão Lançamentos, menu de playlist por teclado e sincronização entre os dois players passaram. O áudio continuou em um único elemento. O painel lateral abriu e fechou na largura mínima. |
| Segurança | URLs de arquivo/shell e comandos malformados foram rejeitados. Uma tentativa de criar playlist a partir da página do player externo foi bloqueada; a biblioteca permaneceu sem a alteração. A CSP bloqueou a conexão ao IPC. Objetos internos do runtime podem existir no iframe, mas não autorizam a operação. |
| YouTube ao vivo | Vídeo público `M7lc1UVf-VE`, “YouTube Developers Live: Embedded Web Player Customization”, carregado por oEmbed e reproduzido no IFrame Player oficial, com relógio avançando e duração válida sincronizada nos dois painéis. Viewport observado: aproximadamente 383 × 222. |
| SoundCloud ao vivo | Link público `soundcloud.com/forss/flickermood`, “Flickermood by Forss”, carregado e reproduzido no widget oficial, com posição maior que 0,5 s e duração válida sincronizada nos dois painéis. |
| Biblioteca óptica | liquid-glass-react 1.1.1 foi inspecionado antes da adoção: licença MIT, peer React compatível, ausência de scripts de instalação e de dependências de execução próprias. As duas lentes renderizaram no WebView2. Não equivale a uma auditoria completa do produto. |

As capturas e resultados estão em `evidencias/`. Os testes de plataformas públicas usam perfis descartáveis; nenhuma credencial de desenvolvedor foi fornecida ou embutida. O comportamento de uma amostra não garante disponibilidade de todo o catálogo, de todas as regiões ou de conteúdo com restrições.

## Medidas locais

Em uma execução da versão 1.3.0 instalada, a tela ficou disponível em **2.5 s**. A soma dos working sets foi **574 MB**, cerca de **30 MB** no processo nativo. A soma pode contar páginas compartilhadas mais de uma vez; a automação com depuração não representa um benchmark controlado.

A composição por GPU e a rasterização por hardware estavam habilitadas. Em três segundos de rolagem, houve 434 intervalos de rAF, p95 de 7.1 ms e 0 intervalos acima de 33,4 ms. Isso mede agendamento de callbacks, não comprova apresentação de todos os frames.

Após 20 alternâncias entre Início e Configurações, os documentos passaram de 7 para 7, listeners de 454 para 454 e nós DOM de 1114 para 1120. Não comprova ausência de vazamentos em sessões longas. O relatório de erros da suíte de interface ficou vazio; os bloqueios CSP nos testes de providers são esperados das tentativas deliberadas de IPC.

A captura final mostra reprodução local real, com 15.03 s de uma faixa de 48 s, em perfil de teste silenciado.

Há redução de movimento, modo sem blur, listas virtualizadas, importação de metadados fora da thread da interface, busca cancelável e cache limitado. O uso gráfico varia com o tamanho da janela e o conteúdo externo. O aplicativo não faz download ou decodificação própria de streaming remoto.

## Implementado, com verificação parcial

Seletores nativos de arquivo e de exportação, extração de capas embutidas, notificações, inicialização com o Windows, bandeja e registro de atalhos globais estão implementados. A seleção manual em todos os diálogos, todas as combinações de codecs, o comportamento após reboot, notificações sob todas as políticas do Windows e conflitos com teclas globais de outros programas não foram automatizados ou verificados integralmente nesta sessão. A lógica de importação e persistência recebeu testes próprios.

## Dependências externas e pendências de distribuição

- A busca real autenticada do YouTube depende de uma chave pessoal, cota e permissões. A do SoundCloud depende de acesso de desenvolvedor e do servidor OAuth configurado. Sem essas credenciais, não foi possível validar buscas reais de catálogo. Os campos e instruções estão disponíveis no aplicativo e em `INTEGRACOES.md`.
- Players oficiais mantêm anúncios e restrições. Conteúdo privado, regional, etário ou com incorporação desativada pode exigir abertura na plataforma ou não estar disponível.
- O equalizador atua somente nos arquivos locais. YouTube é pausado quando a janela fica oculta; não existe reprodução de vídeo invisível.
- Álbuns vêm dos arquivos locais. Não há sincronização em nuvem, download de streaming, login de conta pessoal nas plataformas ou letras licenciadas.
- O instalador é uma edição pessoal **sem assinatura Authenticode**. Distribuição pública deve receber certificado, revisão de termos e validação em outros computadores.
- Atualização automática está desativada: faltam um canal hospedado e assinatura do autor. O botão informa essa condição, sem simular uma atualização disponível.

## Reprodução dos testes

Veja os comandos no README. A suíte de interface usa a porta local 9336; o verificador de plataformas usa 9337; a medição instalada usa 9338; o teste óptico instalado usa 9340. Essas portas só são ativadas nos processos de teste. O aplicativo iniciado normalmente não habilita depuração remota.


## Prova óptica da V2 instalada

Teste A/B com fundo listrado diagnóstico, ligando/desligando somente o displacement: **6690 pixels alterados nas bordas da sidebar, 0 no centro**, com diferença máxima de canal 160/255. A captura normal é feita com o fundo procedural do produto; as listras existem somente durante esse teste.

Quatro painéis com filtro SVG no layout amplo. Modo de desempenho confirmado sem backdrop-filter. Ausência de suporte a URL simulada por teste: alternativa CSS com blur confirmada. Redução de movimento removeu as lentes; foco da busca aumentou a opacidade especular de 0,48 para aproximadamente 0,63. Erros de página no teste óptico: zero.

As evidências estão em `evidencias/liquid-v2/optics.json`, `bevel-grid-on.png`, `bevel-grid-off.png`, `fallback.png`, `fallback-css.png`, `installed-home.png`, `comparison.png` e `before-after.png`. A interpretação dos seis critérios visuais, licença e limitações técnicas estão em [LIQUID-GLASS-V2.md](LIQUID-GLASS-V2.md).
