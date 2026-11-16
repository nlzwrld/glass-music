# Recuperação de fidelidade — Glass Music 1.2

> Registro histórico da versão 1.2. O cenário externo e a moldura descritos abaixo foram removidos na versão 1.2.1 após a correção solicitada pelo usuário. O layout atual está em [CORRECAO-JANELA.md](CORRECAO-JANELA.md).

## Causas verificadas

A estrutura geral já estava próxima do conceito em 1672 × 941. As maiores divergências vinham do fundo raster encoberto pela janela, do backdrop-filter no ancestral e da soma de fundos cinza/azul com uma camada branca nos painéis. As capas quadradas de Recentes adicionavam altura; pesos intermediários de fonte produziam títulos mais pesados. A auditoria anterior à edição está em `evidencias/recovery/AUDITORIA.md`.

## Alterações

- GlassScene possui seis camadas independentes: base azul-marinho, radiais de luz, formas SVG curvas, bordas com núcleo/halo, atmosfera difusa e cor da capa com intensidade limitada. O wallpaper PNG foi retirado. A imagem do conceito não participa da renderização do app.
- O desfoque da janela inteira foi removido. A difusão da geometria do cenário é uma camada SVG estática; os painéis aplicam seus próprios materiais. GlassMaterial oferece variantes light, medium e deep, parametrizadas por opacidade, blur, saturação, borda, reflexo, sombra interna/externa e refração simulada. As lentes ópticas continuam limitadas aos botões principais.
- Sidebar com tonalidade violeta e menos camadas opacas; player lateral com 307 × 294 px de capa, luz localizada e profundidade; barra inferior com reflexos direcionais violeta/azul. Bordas e preenchimento deixaram de ser um único cinza leitoso.
- Recentes tem proporção de capa 1,15, margens corrigidas e escala de texto consistente; as recomendações passaram a começar na altura do conceito. Os cartões editoriais existentes receberam correção de cor, sem substituir seus recursos. Os controles de busca, fila, playlists e integração nativa continuam usando a lógica existente.
- Os tokens de layout e de materiais ficam em `reference.css`. Regras do tema antigo foram auditadas; as substituições desta rodada foram feitas nos blocos existentes, sem acrescentar outra folha de sobrescritas. Uma barra horizontal indevida no painel compacto foi removida.

## Duração 0:00: diagnóstico e correção

Antes do primeiro play, a interface mostrava a primeira capa disponível, mas o Seekbar lia a duração da fila, que ainda estava vazia. A duração dos WAVs incluídos já existia nos metadados: 48 segundos. A interface agora apresenta esse valor real enquanto a fila está vazia, mantendo o seek desabilitado. Ao reproduzir, passa a usar a duração e a posição informadas pelo motor. Quando não existe duração conhecida, mostra `—:—`, sem inventar um valor.

## Seis ciclos de comparação

Todas as capturas vieram do Tauri/WebView2 real em 1672 × 941. Cada ciclo foi inspecionado visualmente antes da correção seguinte:

1. Reconstrução do cenário e remoção das superfícies opacas; detectadas faixas muito nítidas e excesso de azul.
2. Difusão das formas atrás da janela, preservando bordas exteriores; detectados centro escuro e sidebar azul demais.
3. Redistribuição de luz, correção de prioridade dos parâmetros das variantes e ajuste de proporções; corrigidos Recentes, busca e largura das recomendações.
4. Reflexos direcionais na barra e no painel, mais luz ambiente central; refinamento dos gradientes das faixas.
5. Ajustes de cor por região, tratamento vermelho/azul dos cartões e espaçamento dos controles do player; depois, correção da rolagem compacta.
6. Luz lavanda diagonal na área superior e reflexos mais localizados. O conteúdo central passou a continuar por trás da barra inferior, permitindo que as capas apareçam difusas no vidro. O espaço ao final da rolagem mantém os últimos botões acessíveis; essa interação foi exercitada na versão instalada.

| Captura | SSIM de luminância ↑ | Erro médio RGB ↓ | Pixels diferentes ↓ |
| --- | ---: | ---: | ---: |
| baseline | 0.7058 | 34.71 | 63.12% |
| cycle-1 | 0.7122 | 29.05 | 53.09% |
| cycle-2 | 0.7285 | 28.24 | 51.28% |
| cycle-3 | 0.7382 | 25.61 | 43.79% |
| cycle-4 | 0.7446 | 24.68 | 42.56% |
| cycle-5 | 0.7526 | 23.93 | 41.15% |
| cycle-6 | 0.7538 | 23.66 | 40.33% |

Métricas calculadas nos mesmos 959.950 pixels, excluindo áreas fixas de conteúdo variável (capas, playlists e metadados). Pixelmatch 8, limiar 0,1, antialiasing ignorado; SSIM de luminância com janela uniforme 11 × 11. Não são porcentagens de fidelidade. A máscara também exclui parte das imagens editoriais; os números não substituem a análise das capturas completas. A geometria é muito próxima, mas os desenhos do cenário, tipografia e conteúdos ainda apresentam diferenças. Não se declara reprodução pixel a pixel.

Sobreposições, diferenças, máscaras e capturas estão em `evidencias/recovery/`. O snapshot `baseline.png` preserva a versão anterior. A referência só é incluída como evidência da comparação.

## Reprodução das comparações

Com Python, Pillow e NumPy instalados, execute:

```powershell
python scripts/compare-visual.py referencia.png captura.png pasta-de-resultados
node scripts/compare-visual.mjs referencia.png captura.png diferencas.png pasta-de-resultados/excluded-mask.png
```

A máscara está definida nas coordenadas da referência 1672 × 941. Para outra composição, ajuste-a explicitamente. Não estique a captura para forçar correspondência; capture na mesma área de comparação.

## Desempenho e limites

No modo de desempenho, o app desabilita blur dos materiais e difusão/reflexos SVG; as lentes viram superfícies CSS. Redução de movimento e a preferência do sistema são respeitadas. Em desenvolvimento, a GPU AMD Radeon RX 580 2048SP apresentou composição e rasterização por hardware habilitadas; uma amostra curta de rAF teve p95 de aproximadamente 7,1 ms. Isso não é garantia de FPS ou ausência de vazamentos em sessões longas. As medições da versão instalada constam em `VALIDACAO.md`.

As faixas e o histórico continuam reais. O conceito usa conteúdo comercial diferente dos instrumentais incluídos; nenhuma música, playlist ou reprodução fictícia foi criada para preencher a tela. Pesquisa autenticada continua dependendo das credenciais nas Configurações. As limitações de serviços, codecs e distribuição permanecem documentadas no README.
