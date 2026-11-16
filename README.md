# Glass Music 2.2

Player pessoal para Windows com Liquid Glass, biblioteca local e músicas por links públicos.

## Recursos

- Biblioteca com playlists, capas individuais, reordenação e menu de contexto.
- Recentes na barra lateral; playlists na Biblioteca.
- Descobertas com cache persistente e preparação antecipada da próxima música.
- Transições configuráveis: sem efeito, fade e crossfade.
- Volume, booster até +12 dB com proteção contra distorção, equalizador de cinco bandas e escolha de saída quando suportada pelo WebView2.
- Downloads para reprodução offline das fontes compatíveis. SoundCloud utiliza o player oficial e não oferece os efeitos ou downloads deste app.
- Letras sincronizadas pelo LRCLIB, com janela separada ao abrir no mini-player.
- JAM na rede local entre até oito pessoas. Para usar em redes diferentes, configure um servidor HTTPS; veja [deploy/jam.md](deploy/jam.md).
- Configurações organizadas por tópicos, gradientes ajustáveis, temas claro/escuro e transparência da área de trabalho.
- Canal de atualizações assinadas via GitHub Releases; veja [deploy/updates.md](deploy/updates.md). O pipeline exige a chave de assinatura nos Actions Secrets.

As contas das outras plataformas permanecem preparadas para configuração posterior; não há login universal ativo.

## Instalação

Use o instalador Windows publicado nas releases. A biblioteca permanece em `%APPDATA%\com.glassmusic.desktop`. Na primeira abertura, escolha se deseja permitir acesso online. Downloads continuam disponíveis com esse acesso desativado.

O componente público do YouTube usa metadados HTTP e yt-dlp como auxiliar. Não importa cookies ou contas do navegador. Spotify e Deezer fornecem referências e metadados; o áudio compatível é localizado no YouTube. Conteúdos privados, protegidos ou restritos podem não funcionar, e mudanças nas plataformas podem exigir uma atualização do auxiliar.

Sua biblioteca e preferências ficam no computador. Plataformas externas recebem o IP e os dados necessários à consulta. Uma JAM compartilha apenas os dados da música, posição e estado de reprodução com os participantes; cada dispositivo reproduz seu próprio áudio.

## Compilação

Requisitos: Node.js 24, pnpm 10, Rust estável com MSVC, C++ Build Tools e WebView2.

```powershell
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm test:native
```

A distribuição assinada exige `TAURI_SIGNING_PRIVATE_KEY` e, se aplicável, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, mantidas fora do código. Então execute `pnpm dist`. O workflow de publicação compila o instalador e gera o manifesto de atualização automaticamente.

Os testes de uso usam perfis isolados e encerram somente os processos que criam. Defina `GLASS_EXE` com o caminho absoluto do executável para executar os cenários atuais em `features-220.spec.ts`, `visual-220.spec.ts`, `jam-apps-220.spec.ts` e `audio-212.spec.ts`. Relatórios das versões anteriores em `docs/` são históricos.

Código original sob MIT. Dependências e auxiliares mantêm suas licenças; veja [docs/TERCEIROS.md](docs/TERCEIROS.md) e `assets/catalog/`. Atualizações usam assinatura própria do aplicativo, distinta de um certificado Authenticode comercial do Windows.
