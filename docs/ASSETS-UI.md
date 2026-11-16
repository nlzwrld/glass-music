# Recursos visuais da interface 1.3.0

Duas imagens editoriais originais foram criadas com a ferramenta integrada `image_gen`, em modo de geração de novas imagens, sem imagem de entrada. Os comandos abaixo registram a direção visual empregada; a ferramenta não expôs parâmetros de modelo ou qualidade adicionais.

| Arquivo no projeto | Prompt de direção visual |
| --- | --- |
| `public/artwork/releases.png` | Retrato editorial fotográfico de uma mulher adulta de perfil, olhos fechados e cabelos ondulados, iluminação vermelha e carmesim, composição musical dramática, sem texto, logotipos ou interface. |
| `public/artwork/popular.png` | Fotografia editorial de uma multidão em um show, vista por trás, braços levantados, palco com luzes azuis e ciano, atmosfera musical, sem texto, logotipos ou interface. |

O cenário externo e a moldura que simulavam outra janela foram removidos na 1.2.1. A 1.3.0 mantém a janela única e compõe um novo fundo procedural CSS/SVG dentro dela: gradientes, faixas luminosas, sombra e desfoque. Não há imagem estática de background. Os mapas raster gerados por `refraction.ts` contêm normais e máscaras ópticas; não são imagens de cenário. A janela, painéis, menus e controles são componentes reais; a captura da referência só aparece na documentação de comparação. As capas das faixas locais e os instrumentais de demonstração continuam originais, em `public/covers/` e `assets/audio/`, reproduzíveis por `scripts/generate-demo.py`. Detalhes em `LIQUID-GLASS-V2.md`.

As imagens editoriais dos cartões não representam músicas ou resultados de busca. Capas, artistas, playlists e histórico são obtidos dos dados reais da biblioteca ou dos serviços. Nenhuma faixa comercial foi inventada para imitar o conteúdo da referência.
