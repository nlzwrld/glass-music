# Glass Music 1.8 — Liquid Glass V3

Entrega validada em 15/11/2026 no Windows 11 Pro 10.0.26200 deste computador. A versão final foi instalada pelo NSIS e os testes completos usam o executável instalado, com perfis isolados.

## Preferências finais atendidas

- Fundo transparente da área de trabalho como padrão, usando Acrylic nativo. O cenário colorido está no laboratório e na opção Ambiente.
- Contorno nativo arredondado, ajustado ao DPI e ao tamanho. A região real do HWND excluiu os quatro cantos e incluiu centro/laterais, tanto na janela normal quanto no mini-player. Sombreado/moldura nativos extras desativados; removido o segundo highlight do contorno HTML. Os insets nativos medidos foram zero nos quatro lados, em ambos os tamanhos.
- Abertura com entrada suave do símbolo, saudação e horário local digitados em etapas, pausa curta e saída gradual. Reduzir animações/modo de desempenho usam apresentação curta.
- Crystal Thin, Regular e Deep, com parâmetros separados. Refração, especular direcional com falloff, transmissão e dispersão sutil; texto/ícones permanecem DOM nítido.
- Navegação e funcionalidades musicais preservadas. Importação continua apenas por link na interface.

## Validação funcional e visual

22 testes TypeScript, 21 testes Rust e **6 testes completos do aplicativo instalado passaram**. Incluem dois áudios reais do YouTube com play/pausa/posição/fila/histórico, SoundCloud, arquivo local legado sem acesso online, playlists, links Spotify/Deezer com áudio correspondente, capas quadradas e persistência. Não foi criado vídeo/iframe do YouTube e não houve abertura automática do navegador ao tocar YouTube.

Os links de faixas Spotify e Deezer iniciaram áudio correspondente do YouTube automaticamente, sem navegador. A identificação usa título, artista e duração e rejeita versões não solicitadas. Links antigos foram reproduzidos com o mesmo ID nas playlists e no histórico. Links incompatíveis permaneceram no app com aviso; o erro oferece tentativa de novo, sem chamar o navegador. Esse fluxo não transmite áudio da assinatura Spotify/Deezer.

A reprodução do YouTube avançou durante a animação do laboratório e durante perda/restauração simulada do contexto gráfico. Painéis de fila e player expandido abriram e fecharam. Revogar a integração interrompeu o áudio e invalidou o endereço local. A biblioteca pessoal foi comparada integralmente com o backup anterior à instalação final: todas as linhas permaneceram iguais.

O laboratório comparativo mostra imagem original local, texto e movimento por trás dos materiais CSS, SVG e WebGL2. Pixelmatch e comparação RGB com refração 0/10 detectaram mudança em 8.86% da faixa de borda e 0.00% do centro no recorte medido. O cenário em movimento alterou 4498 pixels no recorte. A diferença mede o efeito, não é uma nota estética.

Capturas foram feitas no WebView2 real durante os testes. Layouts 1672×941, 1360×860 e 920×650 passaram sem overflow horizontal, com player dentro da janela. O contorno nativo também foi consultado diretamente no Windows.

## Desempenho medido

- GPU: ANGLE (AMD, AMD Radeon RX 580 2048SP (0x00006FDF) Direct3D11 vs_5_0 ps_5_0, D3D11).
- Um contexto WebGL2 compartilhado; segundo canvas é apenas a fonte 2D.
- **0 desenhos em repouso** na janela medida. O laboratório ativo ficou em 30.9 desenhos/s; há limite de atualização, sem um loop por superfície.
- Laboratório minimizado: desenhos pararam; restaurar retomou. Foi necessário sinal nativo, pois `document.hidden` sozinho não acompanhou o minimizar neste WebView2.
- Rolagem: p95 13.9 ms, 0 quadros acima de 33 ms, 214 amostras.
- Memória total observada do app e sua árvore WebView2: 417 MiB. Heap JS: 5.25 MiB. Perfil dessa medição: offline, Configurações, Ambiente ativo, sem música tocando; não é comparação direta com medições de outras versões.
- Janela ociosa medida por mais 1,5 s: 0.84 ms de tarefas do renderer, 0 layouts e 0 desenhos ópticos.
- Em oito ciclos de navegação, listeners: 426 → 440; nós: 1601 → 1617, após coleta de lixo. Uma rodada curta não prova ausência de vazamento prolongado.

Os números variam com GPU, escala, carga do sistema e WebView2. Não se apresenta tempo de submissão JS como tempo de GPU. Há fallback CSS em falha/perda de contexto e no modo de desempenho. Não foram repetidos testes de hardware em outros PCs.

## Biblioteca e limitações

Selecionado o shader MIT do el-gladiador/liquid-glass-react, adaptado para o compositor local sem instalar seu capturador DOM. Os cinco repositórios solicitados foram estudados. A análise, revisões, segurança, licenças e fontes estão em `LIQUID-GLASS-V3.md`.

WebGL refrata o ambiente interno; **não captura nem refrata a área de trabalho através da transparência do Windows**. O modo padrão Área de trabalho mantém o desfoque nativo e materiais leves. SVG atua sobre o backdrop que o navegador compõe; não captura conteúdo interno de iframe SoundCloud. Windows 10 e outras GPUs não foram executados neste PC. A aparência/sombra do contorno depende do compositor e a janela maximizada segue contorno retangular.

As capturas WebView2 comprovam conteúdo, alfa e shaders; não incluem o fundo composto pelo Windows. A captura nativa de janelas transparentes foi inconsistente neste ambiente (em alguns momentos capturou o jogo atrás ou desenhou uma moldura de captura), por isso não foi usada como evidência visual. A geometria do contorno foi consultada diretamente via Win32. O perfil pessoal permaneceu em Área de trabalho, verificado na preferência salva, e o executável instalado corresponde ao build com seu marcador NSIS. Áudio público do YouTube continua não oficial e sujeito a bloqueios/alterações; Spotify/Deezer usam correspondência pública no YouTube, que pode falhar ou diferir da gravação original; coleções não são expandidas em faixas e outros links incompatíveis mostram aviso interno. As credenciais e permissões do usuário não foram alteradas.

Evidências em `docs/evidencias/engine-v3/`. Relatórios anteriores são históricos.
