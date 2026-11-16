# Glass Music 1.9.0 — validação

Instalado e conferido neste Windows 11 em 15/11/2026. A instância pessoal foi reaberta com a biblioteca preservada.

## Contorno da janela

O framework podia recolocar a moldura nativa após mudanças de estilo/foco, por cima do raio interno. A correção intercepta essas alterações, preserva os eventos de foco, suprime a pintura da segunda moldura e mantém uma região nativa arredondada alinhada à área cliente, com raio de 20 unidades lógicas. O recorte permanece também maximizado e após minimizar/restaurar. Acrylic e o redimensionamento continuam ativos.

O teste consulta os cantos reais do cliente e do HWND em seis estados: normal, maximizado, desmaximizado, mini-player, restaurado e após minimizar. Em todos, os quatro cantos ficam fora da região, o centro dentro, WS_CAPTION ausente, redimensionamento presente e a supressão da borda DWM aceita. O Windows pode manter o bit estrutural WS_EX_WINDOWEDGE; a pintura da moldura é interceptada. A conferência visual separada mostra a janela Windows instalada. Capturas de WebView isoladas não são tratadas como prova do contorno externo.

## Playlists

Importação real, sem contas/chaves, testada com quatro serviços:

- spotify: 50 faixas de “Today’s Top Hits”.
- youtube: 29 faixas de “Team Fortress 2 [2010 Version]”.
- soundcloud: 11 faixas de “Soulhack”.
- deezer: 50 faixas de “En mode 60”.

O teste verificou a playlist local, faixas individuais, ausência de duplicatas ao reimportar, preservação da ordem e rejeição de endereço local sem criar uma playlist vazia. Spotify público pode limitar a lista; o aviso foi verificado. Não é uma promessa de cópia completa de toda playlist Spotify sem autorização. Faixas importadas usam o motor interno existente.

## Contas: implementado e pendente

Interface, autorização oficial com PKCE, retorno local validado, armazenamento Windows DPAPI, renovação, importação de curtidas/playlists, atualização a cada 30 minutos e desconexão foram implementados. O cadastro do Glass nas plataformas ainda não existe. As três conexões mostram essa pendência e ficam desativadas. **Login e sincronização privados reais não foram ativados nem validados.** SoundCloud para distribuir a terceiros exige um serviço seguro para trocar seu segredo; esse serviço OAuth não foi implantado. O arquivo de exemplo vazio e as instruções estão em CONTAS-E-PLAYLISTS.md.

## Verificação

- **8 cenários E2E passaram no executável instalado**, usando perfis isolados: áudio YouTube, catálogo, playlists, interface/biblioteca/SoundCloud, links Spotify/Deezer, arquivos antigos, óptica e janela. O catálogo foi executado separadamente após corrigir seu caminho de teste que ainda apontava a um build antigo; os sete cenários já aprovados foram preservados. `installed-tests.json` registra a consolidação e os relatórios originais.
- **27 testes Rust e 22 testes TypeScript passaram.** Incluem validação OAuth/estado/rotação, DPAPI, identificadores SoundCloud atuais, mesclagem sem duplicatas e rollback por dados inválidos.
- Reprodução Spotify/Deezer foi verificada com áudio e avanço de tempo dentro do Glass; YouTube sem vídeo; SoundCloud com widget oficial. Não houve abertura automática de navegador na reprodução/importação.
- Todas as linhas da biblioteca pessoal foram comparadas ao backup anterior à instalação e permaneceram iguais. As preferências visuais existentes foram preservadas.
- Instalador pessoal sem assinatura Authenticode. Testado neste Windows 11/WebView2; não validado em outros computadores ou Windows 10. APIs, disponibilidade das plataformas, cotas e correspondência de áudio podem mudar.

Código, licença e evidências em docs/evidencias/release-190/. A sincronização acrescenta faixas e curtidas; não espelha exclusões ou descurtidas remotas, nem escreve dados de volta nos serviços.
