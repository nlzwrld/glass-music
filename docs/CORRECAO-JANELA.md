# Correção da janela — Glass Music 1.2.1

A versão anterior tratou a imagem de referência como uma composição inteira: incluiu o cenário externo dentro da janela nativa e desenhou uma segunda moldura com margens. O conteúdo central tinha altura adicional para passar atrás do player inferior, enquanto sidebar e barra praticamente se tocavam. Isso produzia a aparência de janela dentro de janela e de painéis sobrepostos.

O componente GlassWindow agora é a única raiz visual e preenche toda a área da janela nativa. GlassScene, a camada de luz ambiente, a margem externa e a moldura duplicada foram removidos. A superfície do aplicativo tem uma cor uniforme; os reflexos permanecem nos próprios painéis.

O layout usa duas linhas de Grid: conteúdo e player inferior. Entre elas há 16 px. A sidebar, o painel lateral e a área de rolagem ficam na primeira linha, sem altura extra; a barra não é mais posicionada sobre o conteúdo. O mini-player preserva seu layout específico e o mesmo motor de áudio.

A suíte de interface verifica a ausência das camadas decorativas, a ocupação integral da janela e a separação entre conteúdo, sidebar, configurações e player em 1920 × 1080, 1672 × 941, 1600 × 900, 1366 × 768 e 920 × 650. Também exercita um botão ao final da rolagem. Resultados e capturas da versão instalada ficam em `evidencias/` e em [VALIDACAO.md](VALIDACAO.md).

A biblioteca, preferências e histórico do usuário permanecem no mesmo local. Os testes usam um perfil temporário separado.
