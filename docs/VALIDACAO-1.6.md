# Validação — Glass Music 1.6.0

Testado em 15/11/2026 no Windows deste computador, com o instalador NSIS e perfis isolados.

- 22 testes TypeScript e 17 testes Rust passaram; 2 testes completos do aplicativo instalado passaram.
- Primeiro uso com termos, persistência da escolha e bloqueio de consultas antes da aceitação. Correção da ordem de gravação da permissão verificada.
- Importações reais de Spotify, Deezer e link do Apple Music. Spotify e Deezer tiveram título e capa reconhecidos; outros links são referências públicas sem extração de dados de sites arbitrários.
- Criação de playlist, adição de link do Spotify à playlist e persistência após recarregar a interface.
- Reprodução real do SoundCloud avançando, pause e mini-player. Nenhum elemento de vídeo ou iframe do YouTube na interface.
- Capas quadradas e ausência de rolagem horizontal verificadas em 1672×941, 1360×860 e 920×650.
- Busca hospedada opcional: duas fontes, paginação, recuperação de falha e revogação de acesso verificadas com respostas de plataforma simuladas.
- Tela inicial também consultada diretamente nas plataformas reais, com dez cards.
- Migração pessoal comparada com backup: apenas as três faixas de demonstração e suas referências foram removidas; playlists e preferências salvas preservadas.

## Otimização medida

CSS de produção: cerca de 107 KB → 41 KB. JavaScript principal: cerca de 468 KB → 402 KB. Instalador: cerca de 34,7 MiB → 24,7 MiB. Foram eliminados o fundo procedural, filtros SVG de refração, lentes com renderização adicional e extração automática de cores da capa.

Na medição desta edição: 448 MiB de memória somada do app e seus processos WebView2; rolagem com p95 de 7.1 ms e 0 quadros acima de 33 ms. Estes valores variam com o computador e a carga de outros programas. O tempo até a tela interativa (4.3 s) inclui a animação de saudação; não deve ser comparado diretamente a uma abertura sem animação.

## Transparência e limites

A configuração da janela usa transparência e Acrylic nativo do Windows; o fundo HTML é transparente. Não há imagem ou gradiente azul/roxo artificial. As capturas WebView2 verificam o conteúdo e o alfa da interface, mas não incluem o fundo composto pelo Windows. A aparência final depende da transparência do sistema e do compositor/GPU. Não foi validada em outro PC.

O app não contém player de vídeo. YouTube, Spotify, Deezer e links externos abrem no serviço de origem; não há promessa de áudio completo desses serviços dentro do app. SoundCloud continua sujeito à disponibilidade de seu widget. Álbum/playlist externa é importado como referência, sem expansão em faixas. Outros links públicos podem usar nome derivado do endereço. A busca não oficial pode exigir atualização quando as plataformas mudam.

Evidências: `docs/evidencias/interface-1.6/`. Guia atualizado em `README.md`.
