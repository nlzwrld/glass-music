> Registro da primeira transformação (1.1). Para a versão atual, consulte [RECUPERACAO-VISUAL.md](RECUPERACAO-VISUAL.md).

# Transformação Glass Music 1.1

## Composição da referência

A interface existente foi reorganizada em três colunas: navegação translúcida à esquerda, conteúdo central e player lateral. Uma barra de reprodução ocupa a base da janela. A identidade foi mantida em azul, violeta e lavanda, com bordas iluminadas, transparência, desfoque, sombras internas e superfícies arredondadas.

A comparação foi feita com capturas do aplicativo Tauri/WebView2 em 1672 × 941, a mesma dimensão da imagem enviada. As principais medidas observadas após as correções foram:

| Elemento | Aplicativo, em pixels | Referência aproximada, em pixels |
| --- | --- | --- |
| Janela | x 44, y 21, largura 1584, altura 896 | x 44, y 22, largura 1584, altura 896 |
| Sidebar | x 45, largura 285 | x 44, largura 286 |
| Conteúdo central | x 364, largura 810 | x 365, largura 809 |
| Player lateral | x 1190, y 82, largura 423, altura 688 | x 1190, y 82, largura 425, altura 688 |
| Barra inferior | x 58, y 799, largura 1556, altura 107 | x 58, y 800, largura 1557, altura 107 |

Foram corrigidos altura mínima das colunas, proporção dos cartões, espaçamentos, sobreposição de pesquisa e controles da janela, acesso às configurações em janelas pequenas e disposição do mini-player. O layout se adapta a 1920 × 1080, 1672 × 941, 1600 × 900, 1366 × 768 e 920 × 650. Em larguras menores, o player lateral pode ser aberto pela barra inferior; um player externo permanece visível durante a reprodução.

## Componentes e comportamento

`src/components/glass/materials.tsx` contém GlassWindow, GlassSidebar, GlassPanel, GlassCard, GlassButton, GlassSlider, GlassContextMenu e LiquidLens. A pesquisa e a navegação ficam em GlassSearch. Os estilos de composição, materiais e variações responsivas estão centralizados em `src/styles/reference.css`.

`liquid-glass-react` 1.1.1 foi integrado às duas superfícies principais de reprodução. Os grandes painéis usam CSS com backdrop-filter para limitar o custo de filtros SVG. O modo de desempenho e a redução de movimento substituem as lentes por uma superfície CSS. Motion anima navegação, capas, diálogos e menus; os eventos registrados pelos componentes têm limpeza ao desmontar.

Os dois players compartilham fila, faixa, posição, volume, curtida e estado de reprodução. Existe um único PlayerEngine e um único elemento de áudio local. Menus de playlists oferecem renomear, exportar e excluir; os menus respondem a setas, Home, End e Escape. Voltar e avançar percorrem a navegação real.

## Diferenças de conteúdo e limites

As músicas, capas, duração e playlists refletem a biblioteca real. Não foram criados falsos históricos ou faixas comerciais para reproduzir os exemplos da imagem. “Recentes” começa vazio e é preenchido ao ouvir. Meu Flow usa faixas disponíveis; Mais Ouvidas usa o histórico; Lançamentos abre uma busca. As recomendações são sugestões de termos, com essa condição indicada na tela.

O item Downloads abre os arquivos locais, sem baixar áudio das plataformas. Credenciais continuam opcionais para arquivos locais e links públicos incorporáveis; a pesquisa autenticada depende da configuração nas preferências. Não há distintivo de qualidade HD inventado para faixas sem essa informação.

As imagens editoriais e o papel de parede são recursos originais; sua descrição está em [ASSETS-UI.md](ASSETS-UI.md). A captura fornecida não é usada como interface ou imagem de fundo. O resultado reproduz a composição e os materiais, mas não é uma cópia pixel a pixel dos conteúdos comerciais da referência.

Resultados funcionais e limitações de verificação estão em [VALIDACAO.md](VALIDACAO.md); capturas reais e arquivos de resultados estão em `evidencias/`.
