# Liquid Glass Engine V2 — Glass Music 1.3.0

Atualização dos materiais e da iluminação, preservando a estrutura e as funções da versão 1.2.1. O fundo procedural existe **dentro da janela nativa**, preenchendo sua área. Não foi recriada a janela arredondada sobre um cenário externo. Sidebar e conteúdo continuam em uma linha da grade, e a barra inferior em outra, separadas por 16 px.

## Pesquisa e decisão técnica

| Técnica | Avaliação e uso |
| --- | --- |
| Blur CSS e gradientes | Transmissão difusa, tint, luz e alternativa de compatibilidade. Sozinhos não produzem a distorção pedida. |
| SVG `feDisplacementMap` no backdrop | Escolhido para quatro superfícies permanentes. Amostra o fundo realmente renderizado, usando um mapa normal de borda; os filhos React ficam em uma camada separada. |
| WebGL / GLSL | Adequados a uma cena óptica própria. Aqui exigiriam recriar ou capturar o conteúdo subjacente para uma textura, com sincronização adicional com o DOM. Não foram necessários para o efeito localizado. |
| Three.js / transmissão física | `MeshPhysicalMaterial` oferece transmissão e espessura para objetos de uma cena 3D. Não refrata automaticamente os elementos HTML atrás de um painel. Uma cena 3D paralela acrescentaria custo e complexidade sem resolver esse requisito diretamente. |
| `rdev/liquid-glass-react` | Referência técnica e dependência já usada nas duas lentes dos botões principais. Mantida apenas nessas áreas pequenas; o mapa dos painéis foi implementado no projeto. |

Fontes consultadas: [repositório e limitações declaradas](https://github.com/rdev/liquid-glass-react), [licença MIT](https://github.com/rdev/liquid-glass-react/blob/master/LICENSE), [backdrop-filter](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/backdrop-filter), [feDisplacementMap](https://developer.mozilla.org/en-US/docs/Web/SVG/Reference/Element/feDisplacementMap), [MeshPhysicalMaterial](https://threejs.org/docs/pages/MeshPhysicalMaterial.html) e [WebView2](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/overview-features-apis).

A versão instalada de `liquid-glass-react`, 1.1.1, foi inspecionada: MIT, Copyright 2025 MAX ROVENSKY, React peer >=19 compatível com o React 19 do projeto, sem dependências próprias de execução ou scripts de instalação. A licença integral está em `licenses/liquid-glass-react.txt`. A biblioteca declara limitações de displacement em Safari/Firefox. Seu modo denominado `shader` gera um mapa em canvas; isso não significa que seja necessário manter uma cena WebGL animada. O código novo dos mapas de borda não foi copiado do pacote.

## Composição e material

`LiquidBackdrop.tsx` compõe uma base azul, gradientes radiais assimétricos, faixas diagonais SVG curvas, halos violetas/magenta/azuis, sombra central e desfoque atmosférico. Não usa arquivo de imagem para o background. Uma pequena contribuição da cor da capa respeita a preferência existente de destaque.

`GlassMaterial` reúne transmissão, tint, reflexos direcionais, sombra interna e profundidade. O reflexo superior é amplo e suave; a borda usa um gradiente cônico mascarado que alterna regiões claras, coloridas e apagadas. As curvas e o lado iluminado recebem intensidades diferentes. Hover, foco de teclado e pressionamento alteram os destaques, sem rastrear o ponteiro a cada frame.

O filtro de `GlassOptics` tem duas saídas combinadas:

1. Fundo deslocado por normais calculadas a partir da distância à borda do retângulo arredondado.
2. Fundo desfocado na área interna, com uma máscara complementar à faixa refrativa.

O canal R/G do mapa representa as normais; B guarda a máscara da borda. A máscara é zero no centro. Os filtros processam somente o backdrop: texto, ícones, capas e controles continuam fora da entrada do filtro. As imagens de mapa geradas em canvas são dados ópticos, não capturas nem substitutos do fundo procedural.

O SVG precisa ter um viewport válido: o primeiro teste com viewport zero não produziu deslocamento no WebView2. Após usar as dimensões reais, o teste A/B confirmou deslocamento localizado. Isso foi corrigido antes da entrega.

## API de configuração

```tsx
<GlassMaterial
  variant="thick"
  opacity={0.24}
  blur={12}
  refraction={18}
  specularIntensity={0.5}
  borderIllumination={0.72}
  saturation={130}
  depth={0.23}
  tint="38 43 79"
>
  {children}
</GlassMaterial>
```

| Parâmetro | Unidade / comportamento |
| --- | --- |
| `variant` | `thin`, `regular` ou `thick`; define valores iniciais e largura do bisel. |
| `opacity` | 0–1, opacidade do tint, sem reduzir a opacidade do texto. |
| `blur` | Pixels de desfoque do fundo. Se omitido, usa a preferência multiplicada pelo fator do material. |
| `refraction` | Escala em pixels do displacement SVG; 0 desativa a etapa avançada. |
| `specularIntensity` | Intensidade dos reflexos; default 0,48 / 0,52 / 0,50. |
| `borderIllumination` | Intensidade da borda direcional; default 0,50 / 0,65 / 0,72. |
| `saturation` | Percentual de saturação do fundo transmitido; 125 / 125 / 130. |
| `depth` | 0–1, intensidade da sombra externa. |
| `tint` | Três componentes RGB separados por espaços, por exemplo `38 43 79`. |
| `refractive` | `false` aplica o material CSS sem mapa SVG; usado nos cards. |

| Superfície | Material | Refração / bisel / fator de blur |
| --- | --- | --- |
| Busca | Thin | 7 px / 7 px / 0,12 |
| Sidebar | Regular | 12 px / 16 px / 0,34 |
| Player lateral e barra inferior | Thick | 18 px / 22 px / 0,48 |
| Cards principais | Regular com refração desativada | Transmissão CSS e reflexos, sem multiplicar filtros avançados nos itens de conteúdo. |
| Botões | Thin | Estilo leve; somente os dois botões grandes usam as lentes de `liquid-glass-react`. |

Os painéis ajustam tint e opacidade de acordo com sua posição e a preferência de transparência existente. Esses ajustes podem ser sobrescritos pelos parâmetros do componente. As opções avançadas são uma API de composição; não foi adicionado um novo painel de configurações ao produto.

## Eficiência e alternativas

- Quatro mapas SVG persistentes na janela ampla; nenhum shader WebGL contínuo.
- Mapas gerados no tamanho necessário, com maior dimensão limitada a 1024 pixels e cache LRU de 16 entradas.
- `ResizeObserver` com espera de 90 ms; mapas são refeitos quando a geometria muda. Observer e timer são limpos ao desmontar.
- Fundo estático procedural, sem loop JavaScript de animação; gradientes e filtros são compostos pelo navegador.
- Nenhum filtro de refração por faixa da biblioteca ou linha virtualizada.
- Detecção de suporte sintático a `backdrop-filter: url(...)` e runtime Chromium. Fora desse caminho, aplica CSS blur, tint e reflexos.
- Sem suporte a backdrop-filter, mantém uma superfície mais opaca para legibilidade. Modo de desempenho desativa os filtros e as faixas atmosféricas; redução de movimento remove as lentes animadas e transições.

A detecção de suporte não é uma garantia universal de implementação correta. Por isso foi feito teste de pixels no WebView2 real desta máquina. Outros navegadores e GPUs não foram certificados. Os intervalos de `requestAnimationFrame` relatados na validação medem agendamento, não apresentação física de todos os frames.

## Validação visual

Capturas reais do executável instalado, provas A/B e JSON de resultados estão em `evidencias/liquid-v2/`. `comparison.png` reúne a versão anterior, V2 e o conceito fornecido. A captura do conceito é usada somente para comparação, nunca como background do aplicativo.

| Critério | Resultado da comparação visual |
| --- | --- |
| Background | A superfície uniforme da 1.2.1 foi substituída por iluminação assimétrica, diagonais suaves, violeta no alto/esquerda, azul à direita e magenta em regiões baixas. Mantida uma região central escura para leitura, como na referência. |
| Transparência | As faixas e manchas luminosas continuam visíveis dentro da sidebar, player lateral e barra, com blur e tint diferentes. O painel lateral recebe magenta no centro e azul embaixo. |
| Refração | Bordas e curvas alteram a amostragem do fundo. Teste controlado liga/desliga apenas o displacement sobre listras, mantendo blur e reflexos iguais; exige pixels alterados no bisel e centro estável. |
| Reflexos | Luz superior, brilho lateral e contorno descontínuo substituem borda branca uniforme. Teste de foco verifica aumento do reflexo da busca. |
| Profundidade | Sombra interna, centro difuso, bisel mais nítido, tint e sombras externas diferenciam espessuras. Sidebar, busca e players não usam todos o mesmo material. |
| Iluminação | Variação espacial acompanha o fundo transmitido. Brilhos não são uma camada branca uniforme sobre a interface. A intensidade foi reduzida após a primeira captura para evitar excesso de neon. |

A V2 reproduz a direção dos materiais e da iluminação, não uma cópia pixel a pixel do conceito. O conceito mostra capas e catálogo comercial; o aplicativo usa sua biblioteca real. A refração é uma aproximação de interface por displacement 2D, não simulação física completa de raios ou vidro volumétrico. O layout atual aprovado foi mantido.

## Reproduzir

Com o aplicativo normal fechado e a versão desejada instalada:

```powershell
pnpm test
$env:GLASS_EXE = "$env:LOCALAPPDATA\Glass Music\glass-music.exe"
pnpm test:e2e
node scripts/verify-providers.mjs
node scripts/measure-installed.mjs
node scripts/verify-optics-installed.mjs
```

Os testes abrem instâncias Tauri reais em perfis separados. `verify-optics-installed.mjs` inicia a porta local 9340 somente no processo de teste e o encerra ao terminar. O script `verify-optics.mjs` também pode se conectar a uma instância de desenvolvimento já aberta na porta informada. A suíte e2e limpa `test-results`, portanto deve preceder as demais capturas.
