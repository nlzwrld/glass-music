# Liquid Glass Engine V3 — Glass Music 1.8

## Decisão

A preferência final do usuário é mantida: **Área de trabalho transparente como padrão**, sem cenário colorido atrás da biblioteca. O ambiente colorido está no laboratório e na opção Ambiente. A janela possui recorte nativo arredondado, além do border-radius CSS, e reaplica o recorte ao redimensionar, mudar DPI ou entrar no mini-player.

Base selecionada: shader do [el-gladiador/liquid-glass-react](https://github.com/el-gladiador/liquid-glass-react), MIT, revisão `21e5c3a7ba1316c5ab679fbeeabe29e447c0b736`. O shader foi adaptado; o pacote React e a captura de DOM `html-to-image` não foram instalados. O compositor, a cena e a integração React são locais. Há um contexto WebGL2 compartilhado, um programa, uma textura de ambiente com mipmaps e um VAO. A segunda superfície canvas é apenas a fonte 2D, não outro contexto WebGL.

O protótipo comparativo foi executado no WebView2 antes de ativar os materiais nos painéis principais. A captura original está em `docs/evidencias/engine-v3/laboratory-prototype.png`. O laboratório permanece acessível por **Configurações → Glass Laboratory**. A navegação original e os motores musicais foram preservados.

## Estudo dos cinco candidatos

Revisões examinadas em 15/11/2026; clones sem executar instalação, scripts ou builds dos projetos.

| Projeto e revisão | Licença / dependências | Arquitetura encontrada | Avaliação para este aplicativo |
| --- | --- | --- | --- |
| [ptu14/liquid-glass](https://github.com/ptu14/liquid-glass), `c90ff9f098aea4b9705edf3ac83dabf3d98704d7` | MIT, core e adaptador React 0.0.1; `@zumer/snapdom`; React >=18 | Primeiro candidato estudado. WebGL1, SDF, composição/blur e registro compartilhado com limite de 16 superfícies. SnapDOM para DOM ou renderer de fundo fornecido pelo app; loops rAF contínuos no host e renderer. | Boa integração React e conteúdo DOM interativo, mas captura no thread principal e loops contínuos precisariam de adaptação. Não se adotou o pacote. |
| [el-gladiador/liquid-glass-react](https://github.com/el-gladiador/liquid-glass-react), `21e5c3a7ba1316c5ab679fbeeabe29e447c0b736` | MIT, 0.1.1; React >=17; `html-to-image` no caminho de DOM | WebGL2 compartilhado, refração em três camadas, Gaussian de 13 amostras, tint ambiental e invalidação sob demanda; caminho rápido para canvas/imagem. | **Selecionado o shader**, usando a cena canvas direta. Modelo de base configurado com intensidade zero para manter o centro estável; refração convertida para pixels nas bordas. |
| [ybouane/liquidglass](https://github.com/ybouane/liquidglass), `59af227103795f06421a96e2c7d3dceb081decd2` | `package.json` declara MIT, mas o clone examinado não contém LICENSE na raiz; 1.0.3, `html-to-image`/patch-package em devDependencies e postinstall | Refração, dispersão, iluminação, caches FBO e restauração do contexto; captura HTML, mídia dinâmica e loop próprio. | Exige cuidado adicional com a distribuição/captura e licenciamento concreto da cópia. Nenhum código reutilizado. |
| [Schwarzerbaum/liquid-glass-react](https://github.com/Schwarzerbaum/liquid-glass-react), `f0562cc2487f173a59c761ce1da7a3a7ca1c4a41` | MIT, 0.1.0; React >=18; sem dependências de runtime declaradas | CSS/SVG, displacement map, canais RGB e modos de filtro; detecção de limitações de navegador. | Referência para controles/fallback. O app usa seu próprio mapa SDF existente, agora aplicado ao **backdrop**, sem filtrar texto e ícones internos. |
| [StarKnightt/liquid-glass](https://github.com/StarKnightt/liquid-glass), `5ed54a1a2c38390034121a79e1b81afeaf709e53` | MIT; componente WebGL2 sem biblioteca gráfica; demo depende de Next/React | Lente interativa, magnificação, ripple e bordas; conteúdo de texto desenhado em textura e rAF contínuo. | Referência para interação e formato de lente, mas uma lente móvel não resolve os múltiplos painéis persistentes. Nenhum código reutilizado. |

Os adaptadores React declaram versões compatíveis com React 19; isso não substitui testes. Nenhum dos repositórios foi tomado como garantia de compatibilidade com Tauri/Windows. A integração escolhida foi testada no Tauri/WebView2 real deste PC. Os projetos têm históricos modestos; a revisão selecionada fica incorporada ao código e não atualiza automaticamente.

## Motor incorporado

- `v3/vendor/shaders.ts`: shader MIT adaptado, com licença ao lado e uma cópia no diretório público que acompanha o aplicativo compilado.
- `v3/renderer.ts`: recursos compartilhados, desenho de retângulos arredondados com SDF, normais, refração em pixels, dispersão sutil, blur com mipmaps/kernel, saturação e highlights direcionais com atenuação espacial.
- `v3/scene.ts`: ambiente original em canvas com regiões violeta/azul/magenta, contraste e iluminação pela capa em reprodução. A capa passa pelo proxy de imagens já existente, com CORS; não há URL arbitrária adicional de rede.
- `v3/OpticalEngine.tsx`: invalidação, resize, pausa quando o documento fica oculto e quando eventos nativos sinalizam janela minimizada/oculta, texturas atualizadas apenas quando muda a fonte, qualidade/DPR limitado, tratamento de perda/restauração de contexto e fallback CSS.
- `GlassMaterial`: Crystal Thin (controles/cards), Regular (busca/sidebar) e Deep (player/painéis). Parâmetros são separados por variante e podem ser substituídos por superfície.
- `v3/SVGPlane.tsx`: refração do backdrop real para laboratório, menus e painéis flutuantes sobre conteúdo DOM. Mapas reaproveitam o cache limitado existente.

O shader não recebe texto nem ícones dos controles. Eles permanecem DOM normal, acessível e interativo. A refração WebGL amostra a **mesma cena viva exibida atrás dos painéis**, incluindo a imagem/texto/movimento do laboratório. Não se apresenta screenshot estático do DOM como conteúdo dinâmico.

Foram reduzidos o tint escuro e as camadas cinzentas. O material inicial usa tint claro de 4,5%, blur base de 12 px, saturação de 150%, refração base de 5,5 px, especular de 0,38 e dispersão de 0,035. Variantes escalam esses valores. O núcleo amplo de deformação fica desligado; as bordas têm profundidade óptica própria. O reflexo possui direção e falloff, evitando uma faixa de intensidade uniforme na superfície inteira.

## Laboratório e custo

CSS, SVG e WebGL2 mostram o mesmo cenário de teste. Há uma imagem SVG local original, texto de fundo e uma esfera que se move, além de botão, card e painel grande. Controles: blur, refração, opacidade, saturação, especular, dispersão, espessura, tint e qualidade. As escolhas ficam no armazenamento local da interface, sob a chave versionada `glass-optics-v3`; não mudam o formato da biblioteca SQLite.

No app normal a cena não anima continuamente. Resize, mudança de capa/tema/material e interação pedem atualização. Uma curta janela de assentamento acompanha transições. O laboratório atualiza a cena a aproximadamente 30 Hz; reduzir animações congela o movimento. Não existe canvas WebGL por card. Texturas mantêm alocação e recebem `texSubImage2D` quando o tamanho não muda. Cache de mapas SVG tem no máximo 16 entradas. A qualidade limita DPR a 0,75 / 1,15 / 1,75 e a econômica desliga dispersão.

As medições finais estão em `VALIDACAO-1.8.md`. O tempo de submissão JS do desenho não é apresentado como tempo de GPU. Contadores de DOM, memória JS, frames e renderização em repouso foram obtidos pelo protocolo DevTools/Playwright. Pixelmatch confirma alterações e localização da refração; diferença de pixels sozinha não é prova de qualidade visual.

## Segurança, compatibilidade e limites

Nenhum script remoto, CDN, novo plugin, runtime gráfico ou captura de tela/área de trabalho foi adicionado. O CSP não foi relaxado. O shader e a imagem de laboratório são locais. O arquivo de licença MIT acompanha fonte e build. Não há novos cookies, credenciais ou permissões de integração. A reprodução preserva o motor de áudio da versão 1.7 e acrescenta correspondência interna de links Spotify/Deezer, descrita em INTEGRACOES.md.

WebGL não lê o fundo de outras janelas por trás da transparência nativa. Em **Ambiente**, ele refrata o fundo interno controlado pelo app. Em **Área de trabalho**, o ambiente interno fica oculto e o Windows fornece Acrylic; nesse modo o app usa material CSS e **não promete refração óptica da área de trabalho**. SVG filtra pixels que o navegador realmente compõe atrás da superfície, respeitando as fronteiras de backdrop e a compatibilidade do WebView2. Não é um capturador universal de DOM/iframes. O conteúdo interno do widget SoundCloud não é capturado nem filtrado.

Validado em Windows 11 Pro, WebView2 e AMD RX 580 2048SP via ANGLE/D3D11. Windows 10, GPUs diferentes e aceleração totalmente indisponível não foram testados neste computador. Há fallback ao não obter contexto e em perda simulada do contexto; aparência e custo variam com GPU, DPI, tamanho de janela e WebView2. O efeito nativo depende da transparência do Windows. Capturas WebView2 comprovam o conteúdo do app e os shaders, não o fundo composto pelo Windows.

## Referências técnicas consultadas

- [MDN — SVG Filters](https://developer.mozilla.org/en-US/docs/Web/SVG/Guides/Filters) e [feDisplacementMap](https://developer.mozilla.org/en-US/docs/Web/SVG/Reference/Element/feDisplacementMap): deslocamento dos pixels da entrada selecionada; aplicado ao backdrop, não à camada de controles.
- [MDN — backdrop-filter](https://developer.mozilla.org/en-US/docs/Web/CSS/backdrop-filter): filtragem do conteúdo pintado atrás e fronteiras de backdrop root. Evitou-se aplicar opacity global abaixo de 1 nos painéis persistentes.
- [MDN — WebGL](https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API), [perda](https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/webglcontextlost_event) e [restauração](https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/webglcontextrestored_event): recursos recriados ao restaurar o contexto.
- [Three.js](https://threejs.org/docs/): avaliado, sem instalar; uma cena 3D/scene graph não é necessária para este compositor de superfícies 2D.
- [WebGL Fundamentals](https://webglfundamentals.org/) e [texturas](https://webglfundamentals.org/webgl/lessons/webgl-render-to-texture.html): coordenadas, composição e amostragem de textura.
- [Playwright — snapshots](https://playwright.dev/docs/test-snapshots), [Pixelmatch](https://github.com/mapbox/pixelmatch), [Chrome DevTools](https://developer.chrome.com/docs/devtools/) e [memória](https://developer.chrome.com/docs/devtools/memory-problems): capturas do aplicativo real, diferenças e contadores.

## Contorno e visibilidade nativos

`src-tauri/src/corners.rs` aplica uma região arredondada ao HWND da própria janela usando [CreateRoundRectRgn](https://learn.microsoft.com/en-us/windows/win32/api/wingdi/nf-wingdi-createroundrectrgn) e [SetWindowRgn](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowrgn). O raio é 20 unidades lógicas, ajustado ao DPI; na versão 1.8.1, a região acompanha a área cliente visível inclusive maximizada. Margens de redimensionamento que ficam fora da tela não são usadas como origem dos cantos. Uma guarda atômica evita reentrada; a região real é comparada antes de atualizar, sem confiar em um cache de tamanho. Em sucesso a região pertence ao Windows; handles de consulta e de falha são liberados.

A escolha por região é explícita: a [preferência DWM de cantos](https://learn.microsoft.com/en-us/windows/apps/desktop/modernize/apply-rounded-corners) não garante arredondamento em janelas com certas customizações/transparência. O teste consulta a região efetiva do HWND e verifica que os quatro cantos ficam fora, e centro/laterais dentro. O mesmo caminho funciona com as APIs disponíveis no Windows 10, mas só foi executado neste Windows 11. Regiões podem alterar a sombra nativa.

O WebView2 deste computador não mudou `document.hidden` ao minimizar. Por isso o núcleo informa a visibilidade real por evento local, sem novas permissões de sistema. A renderização usa tanto esse sinal quanto a visibilidade da página. O teste minimiza o laboratório animado, verifica parada dos desenhos e retoma ao restaurar a janela. A ação Restaurar agora também desminimiza/mostra a janela.

O sombreado nativo foi desativado (`shadow: false`): no Windows, ele acrescentava uma moldura à janela sem decoração. O highlight exterior de `.app::before` também foi removido. A consulta Win32 mede os insets do cliente como `[0,0,0,0]`, tanto no tamanho normal quanto no mini-player; assim o recorte do vidro coincide com o limite real da janela, sem uma segunda borda deslocada.

A abertura agora tem entrada gradual do símbolo, digitação em duas etapas (saudação conforme horário local e relógio), pausa curta e saída com fade. A preferência de redução de movimento e o modo de desempenho usam uma versão curta. A cena colorida continua opcional; o fundo padrão é a área de trabalho transparente.

## Correção 1.8.1: contorno externo

A versão 1.8.0 removia a região ao maximizar e verificava os cantos do retângulo externo do HWND, que pode ficar parcialmente fora da tela. Isso não comprovava os cantos efetivamente visíveis. A 1.8.1 mantém o raio de 20 unidades lógicas e ancora a região ao retângulo cliente em coordenadas da janela, incluindo as margens de maximização.

O Tao mantém `WS_CAPTION` em janelas sem decoração, apesar de calcular insets nulos. A correção remove esse estilo e pede ao DWM que não desenhe a borda (`DWMWA_BORDER_COLOR = DWMWA_COLOR_NONE`). `WS_THICKFRAME` é preservado para o redimensionamento. O Windows pode manter `WS_EX_WINDOWEDGE` junto dele; o código não tenta removê-lo repetidamente, evitando ciclos de mudança de moldura. Referência: [atributos DWM](https://learn.microsoft.com/en-us/windows/win32/api/dwmapi/ne-dwmapi-dwmwindowattribute).

A geometria é reaplicada ao mudar tamanho, posição, DPI, foco e tema, além das ações da janela. O teste específico verifica cantos do cliente e do HWND em janela normal, maximizada, desmaximizada, mini-player, restaurada e após minimizar/restaurar. A consulta de cor DWM não é suportada neste ambiente; a aceitação do pedido usa o HRESULT de DwmSetWindowAttribute e há conferência visual separada da janela.

## Correção 1.9.0: mudanças de moldura e foco

Além da região arredondada, um subclass da janela impede o framework de recolocar `WS_CAPTION` e bordas estendidas nas próximas alterações de estilo. O recorte é mantido também nos eventos nativos de posição/DPI/exibição. `WM_NCPAINT` não desenha uma segunda moldura; `WM_NCACTIVATE` segue para o framework com o parâmetro que suprime apenas a pintura, preservando seus eventos de foco e estado. Não se desativa a composição DWM/Acrylic. A região continua comparada antes de alterar e `WS_THICKFRAME` continua presente.

A captura de janela do Windows pode restaurar uma janela maximizada durante a ativação. A conferência manual precisa considerar esse efeito; a captura é acompanhada da consulta Win32 do estado e dos cantos visíveis. O relatório final da 1.9.0 registra a validação do executável instalado.
