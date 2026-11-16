# Glass Music 2.0.3 — perímetro, materiais e início

Correção instalada e validada no Windows deste computador. A versão física instalada foi confirmada como 2.0.3.0; o código coincide com o build, aceitando somente o marcador de empacotamento NSIS.

O perímetro usa um único recorte nativo por região. O DWM deixa de acrescentar arredondamento e o Acrylic fica restrito ao modo Área de trabalho; os demais fundos desligam o backdrop nativo. A borda externa do material não usa stroke branco. Os reflexos permanecem difusos e respondem nos quatro lados. A tela Início recebeu separação entre seções e remoção dos textos introdutórios redundantes.

Sete cenários passaram no build e sete no executável físico instalado, com zero falhas, zero ignorados e zero instáveis: perímetro/reflexos, aparência global, margens/temas, aparência/persistência, óptica/fallback, áudio local e região/estados da janela. A execução final durou 96.8 segundos. Os registros dos testes antigos mantêm seus nomes e versões de origem; o manifesto de execução e a instalação identificam o executável 2.0.3 efetivamente testado.



O perímetro foi comparado com reflexos desligados e ligados em 2 perfis. Os valores abaixo são diferenças de luminosidade das imagens, não medidas físicas de refletância:

- high: variação de luminosidade por lado (top 18.86, bottom 17.17, left 17.86, right 18.86); razão entre lados 1.098; variação máxima no pixel externo 0.00.
- economy: variação de luminosidade por lado (top 3.95, bottom 3.74, left 3.93, right 3.95); razão entre lados 1.057; variação máxima no pixel externo 18.86.

As margens foram verificadas em 16 combinações de tema/fundo/qualidade. O Início teve espaçamento e ausência de overflow conferidos em 2 larguras. O teste nativo verificou região, cantos, estilo de resize e estados normal/maximizado/mini/restaurado; flags e região não comprovam isoladamente ausência de pixels extras do compositor. Uma captura da janela nativa acompanha a entrega para revisão visual.

O instalador terminou com código 0. Backup recuperável foi feito antes da instalação; todas as linhas e configurações de 6 tabelas e o conjunto de tabelas foram comparados e preservados antes de iniciar o aplicativo. Essa comparação não inclui alterações legítimas posteriores feitas durante o uso.

Não foram repetidos nesta correção os testes de serviços musicais externos da entrega 2.0. Login e sincronização de contas privadas continuam dependendo do cadastro oficial nas plataformas. Validado neste Windows 11/WebView2 e nesta GPU; outros computadores e drivers não foram exercitados. Instalador pessoal sem assinatura Authenticode.

Evidências completas em `docs/evidencias/release-203`. O ZIP contém fontes editáveis, dependências auxiliares redistribuíveis e licenças; exclui perfis, bancos pessoais, credenciais, caches, resultados temporários e produtos intermediários. O fonte oficial do auxiliar yt-dlp é referenciado por URL e hash em `assets/catalog/PROVENANCE.json`.
