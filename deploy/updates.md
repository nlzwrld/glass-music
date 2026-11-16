# Publicação e atualizações

O workflow `.github/workflows/release.yml` compila, assina e publica o instalador Windows em cada alteração de código na branch `main`. Cada execução recebe uma versão crescente; a atualização do app usa somente instaladores com assinatura válida.

O repositório precisa ter estes Actions Secrets:

- `TAURI_SIGNING_PRIVATE_KEY`: chave privada de atualização, mantida fora do repositório.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: senha da chave (vazia quando não há senha).

A chave pública está em `src-tauri/tauri.conf.json`. Conserve um backup seguro da chave privada: builds futuros devem usar a mesma chave para atualizar as instalações existentes. A assinatura de atualização é distinta do certificado comercial do Windows.

O app consulta o canal do GitHub ao iniciar, ao reconectar e a cada cinco minutos. Instala quando a reprodução está parada para preservar a música; a biblioteca recebe um backup antes da instalação. O usuário pode desativar em Configurações → Atualizações.

Para a primeira publicação local, execute a compilação com a chave no ambiente, gere `latest.json` com `node scripts/update-manifest.mjs` e publique o instalador, sua assinatura `.sig` e `latest.json` na mesma release.

JAM pela internet requer um servidor separado (ver `deploy/jam.md`). GitHub Releases distribui o aplicativo, mas não hospeda salas de JAM.
