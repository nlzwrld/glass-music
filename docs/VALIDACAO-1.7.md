# Validação — Glass Music 1.7.0

Testado em 15/11/2026 no Windows deste computador. A versão final foi reinstalada pelo instalador NSIS e testada com perfis isolados. A instância pessoal foi reaberta após os testes.

- 22 testes TypeScript e 19 testes Rust passaram. Os três testes completos do aplicativo instalado passaram.
- Duas músicas reais do YouTube reproduziram pelo elemento de áudio do Glass: Daft Punk — Instant Crush e Rick Astley — Never Gonna Give You Up. O tempo de reprodução avançou com o contexto de áudio ativo. Os testes usam volume zero no perfil isolado.
- Play, pausa, mudança de posição para 110 segundos, próxima faixa e histórico verificados. O endereço fornecido ao player pertence ao servidor local e usa um identificador aleatório; o endereço temporário da plataforma permanece no núcleo nativo.
- Nenhuma chamada de abertura externa foi feita ao reproduzir essas músicas. Nenhum elemento de vídeo ou iframe do YouTube foi criado. A ação explícita para abrir a origem continua disponível.
- Intervalo de bytes do fluxo respondeu 206 com 1024 bytes e tipo audio/mp4. Intervalo múltiplo inválido foi recusado. O núcleo recusa destinos fora do CDN permitido e fluxos que contenham vídeo.
- Resolução do áudio bloqueada antes da aceitação dos termos. Revogar acesso online interrompeu a reprodução e bloqueou o endereço local anterior com 403.
- Reprodução SoundCloud, mini-player, persistência de termos, importações reais de Spotify/Deezer e referência Apple Music, playlists e capas quadradas continuaram passando no teste completo. Busca hospedada opcional, paginação e tratamento de falha foram verificados com respostas simuladas.
- A biblioteca pessoal foi comparada integralmente ao backup anterior à atualização. Faixas, playlists, histórico e preferências permaneceram iguais.

## Escopo

Esta correção mantém a interface minimalista e a transparência nativa da edição 1.6. Não foram repetidas as medições de desempenho daquela edição. A captura desta entrega mostra o conteúdo WebView2 durante reprodução; não comprova o fundo composto pelo Windows.

O áudio do YouTube usa resolução não oficial de links públicos, sem importar cookies, credenciais ou salvar arquivos de áudio. A disponibilidade depende da plataforma e pode mudar. Conteúdo privado, restrito, com exigência de login ou bloqueado pode não tocar. Falhas são mostradas no Glass, sem abrir automaticamente o navegador. Spotify, Deezer e outras referências continuam abrindo no serviço de origem; não há liberação de áudio de serviços que exigem conta/assinatura. Coleções e artistas do YouTube ainda abrem na plataforma.

Evidências: `docs/evidencias/audio-1.7/`. Funcionamento: `docs/AUDIO-1.7.md`. Relatórios de versões anteriores são históricos.
