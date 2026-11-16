# Contas e playlists — 1.9.0

## Importar por link

**Playlists → Importar playlist** aceita o endereço completo de uma playlist pública YouTube, SoundCloud, Spotify ou Deezer. **Adicionar link** também reconhece esses endereços. O Glass importa faixas reais para uma playlist local; clicar numa faixa usa o player interno. YouTube toca áudio, SoundCloud usa o widget oficial, e faixas Spotify/Deezer procuram uma versão correspondente no YouTube. Nenhuma importação abre o navegador automaticamente.

Reimportar o mesmo endereço acrescenta faixas novas à mesma playlist, preservando a ordem e as músicas locais já existentes. Não remove faixas que desapareceram na origem. Links encurtados devem ser substituídos pelo endereço completo da playlist. Álbuns e páginas de artista não são expandidos.

Limite por importação: 1000 faixas. Faixas privadas, removidas ou sem metadados compatíveis são ignoradas, com aviso. O Spotify sem autorização fornece os metadados públicos do embed, que frequentemente limita a lista a 50 itens. A interface informa essa limitação; não apresenta o resultado como uma cópia completa. O formato do embed e a busca pública não oficial podem mudar.

## Conectar uma conta

**Configurações → Contas** contém YouTube, SoundCloud e Spotify. O fluxo de autorização, retorno local, renovação de sessão e leitura de playlists/curtidas foi implementado. A sincronização começa após conectar e volta a ocorrer a cada 30 minutos com o aplicativo aberto. Há atualização manual e desconexão. As curtidas importadas aparecem também em Curtidas e numa playlist por serviço. A sincronização acrescenta dados, sem apagar modificações locais nem desfazer curtidas locais.

**O cadastro do aplicativo ainda não existe. Por isso as conexões estão desativadas com “Cadastro do Glass pendente”. A autorização e sincronização com contas reais não foram validadas.** Os testes verificam o estado pendente, validação do retorno, rotação de tokens, armazenamento criptografado e mesclagem sem duplicatas; não substituem uma autorização real das três plataformas.

O registro é feito uma vez por aplicativo, pelo responsável pelo Glass. Cada usuário final apenas autoriza sua conta na página oficial. O navegador abre somente nessa ação explícita de conectar; a reprodução continua dentro do Glass. O app não coleta senhas nem importa cookies do navegador.

## Preparação do cadastro

1. Google: criar um projeto, ativar YouTube Data API v3, configurar a tela de consentimento e um cliente OAuth do tipo **Desktop app**. Permissão solicitada: `https://www.googleapis.com/auth/youtube.readonly`. Respeitar usuários de teste/verificação, cotas e a validade de autorizações em modo de teste.
2. Spotify: cadastrar o aplicativo e o retorno **exato** `http://127.0.0.1:43871/callback`. Permissões: `playlist-read-private`, `playlist-read-collaborative`, `user-library-read`. Usa Authorization Code com PKCE. As restrições de modo de desenvolvimento, usuários permitidos e acesso a playlists dependem da configuração/aprovação do Spotify.
3. SoundCloud: cadastrar o aplicativo e o mesmo retorno. A API atual exige OAuth 2.1 com PKCE e também `client_secret` na troca/renovação. Esta implementação pode usar o cadastro do proprietário neste computador, protegido pelo Windows. **Para distribuir o app com SoundCloud para terceiros, a troca que usa o segredo precisa de um serviço próprio seguro; não incluir esse segredo no executável ou no ZIP. Esse serviço de OAuth não foi implantado nesta entrega.** O catálogo público incluído é independente disso.
4. Preencher uma cópia de `oauth.clients.example.json` com o cadastro real e carregar em **Ativar conexões do Glass → Carregar cadastro do aplicativo…**. O arquivo é limitado a 16 KB. Não incluir a cópia preenchida no projeto/ZIP. É uma configuração do desenvolvedor, não uma solicitação para cada usuário criar chaves.

As sessões e o cadastro local ficam em `%APPDATA%\com.glassmusic.desktop\accounts.dpapi`, criptografados para o usuário Windows atual. A interface recebe apenas estado, nome e data da última sincronização. Desconectar remove a sessão local; a revogação no provedor pode ser feita no painel da própria conta.

O retorno OAuth escuta apenas `127.0.0.1`, verifica método, host, caminho, estado aleatório e parâmetros duplicados, e expira em cinco minutos. Paginação autenticada fica restrita à origem oficial do serviço, sem redirecionamentos HTTP. Desativar o acesso online cancela a operação. Uma operação de conta por vez evita consumir simultaneamente tokens de renovação de uso único.

Por sincronização: até 100 playlists, com até 1000 faixas por lista/curtidas. Se a conta exceder os limites ou uma página falhar, a leitura não é gravada como se estivesse completa. A importação não transmite alterações, curtidas ou playlists locais de volta aos serviços.

## Documentação oficial consultada

- [Google OAuth para aplicativos instalados](https://developers.google.com/identity/protocols/oauth2/native-app).
- [YouTube playlists.list](https://developers.google.com/youtube/v3/docs/playlists/list), [playlistItems.list](https://developers.google.com/youtube/v3/docs/playlistItems/list) e [videos.list](https://developers.google.com/youtube/v3/docs/videos/list).
- [Spotify PKCE](https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow), [retorno](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri) e [itens de playlist](https://developer.spotify.com/documentation/web-api/reference/get-playlists-items).
- [SoundCloud OAuth e requisitos](https://developers.soundcloud.com/docs/api/guide), [especificação atual da API](https://developers.soundcloud.com/docs/api/explorer/api.json). Os identificadores URN atuais são aceitos, além dos IDs numéricos dos metadados públicos.
