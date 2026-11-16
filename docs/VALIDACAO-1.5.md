# Validação — Glass Music 1.5.0

Validação realizada em 15/11/2026 no Windows deste computador, com o aplicativo instalado e perfis de teste isolados.

## Integração entregue

- Busca pública direta do YouTube e SoundCloud, sem credenciais do usuário nem servidor do Glass Music.
- yt-dlp 2026.10.26 oficial incluído; SHA-256 do arquivo de distribuição conferido antes da execução. Componentes e licenças registrados em `assets/catalog/PROVENANCE.json`.
- Resultados reais nas duas seções da tela inicial. Foram testadas seis combinações: músicas, artistas e playlists em cada plataforma.
- Paginação real nas duas fontes, reaproveitamento do cache, salvamento de resultados na biblioteca e consulta pela interface.
- Consentimento antes das buscas, desativação bloqueando novas consultas e cancelamento sem processos auxiliares restantes.
- Players oficiais mantidos. Reprodução real avançando no YouTube e SoundCloud, com retorno à reprodução local. Players externos sem permissão de modificar a biblioteca por acesso direto à ponte nativa.

## Verificações

- Compilação TypeScript/Vite e compilação/instalação Tauri/NSIS concluídas.
- 22 testes TypeScript, 15 testes Rust e 2 testes completos do aplicativo passaram.
- Teste do catálogo hospedado opcional preservado: consentimento, duas fontes, paginação e recuperação de falhas simuladas.
- Biblioteca SQLite pessoal comparada antes/depois: conteúdo de todas as tabelas preservado. Nenhum perfil pessoal foi usado nos testes de busca ou reprodução.
- Testes de biblioteca, persistência, controles, temas, mini-player e cinco tamanhos de janela passaram, sem erros de execução registrados.
- Inicialização medida: 2.80 s neste computador. Este valor não é garantia para outros PCs.

## Limites

Os seis testes consultaram as plataformas reais; os testes determinísticos do serviço hospedado usaram respostas simuladas. Não houve validação em outro computador. Resultados, permissões de reprodução, anúncios, prévias e disponibilidade dependem das plataformas. A busca não oficial pode precisar de atualização quando os sites mudam ou bloqueiam consultas. Não há acesso a contas privadas, importação de cookies do navegador, download de áudio ou atualização automática do auxiliar. As seleções iniciais são buscas temáticas, não rankings nem recomendações pessoais.

Evidências: `docs/evidencias/catalog-1.5/`. Guia: `docs/INTEGRACOES.md`.
