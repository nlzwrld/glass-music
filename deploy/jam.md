# Glass Music JAM

O coordenador sincroniza música, play, pausa e posição; cada participante recebe o áudio diretamente da plataforma. Não retransmite áudio, arquivos locais, contas ou senhas. Salas ficam apenas na memória; reiniciar o servidor encerra as salas. Até 8 participantes por sala. Quem cria controla a reprodução; sair encerra a sala.

## Servidor público

Use Node.js 24 e execute `node --experimental-strip-types server/jam.ts`. Configure `JAM_HOST=0.0.0.0` e `PORT=8789` (ou a porta do provedor). O serviço oferece `GET /health` e `POST /v1/jam`.

Alternativa Docker: `docker build -f server/Dockerfile.jam -t glass-jam .` e `docker run -p 8789:8789 -e JAM_HOST=0.0.0.0 glass-jam`.

Publique atrás de HTTPS (por exemplo um serviço de contêiner gerenciado). Use uma única instância enquanto as salas estiverem em memória; múltiplas instâncias precisam de roteamento fixo ou de um armazenamento compartilhado. Não registre corpos, códigos de sala ou tokens de sessão no proxy. Sem CORS: o aplicativo acessa pelo componente nativo.

No aplicativo, abra Configurações → JAM e informe o mesmo endereço HTTPS nos dois computadores. O distribuidor também pode definir `GLASS_JAM_URL` ao compilar para que o endereço venha pronto. Publicar o repositório no GitHub não hospeda o coordenador; GitHub Pages não executa este servidor.

## Mesma rede local

Execute o servidor em um dos computadores com Node 24, escutando em `0.0.0.0`, libere a porta 8789 somente para a rede privada no firewall e configure nos dois aplicativos `http://IP-LOCAL-DO-SERVIDOR:8789`. HTTP só é aceito para endereços privados ou loopback. Para usar de redes diferentes é necessário HTTPS público; não abra a porta do computador para a internet.

## Funcionamento e limites

O aplicativo estima a diferença entre seu relógio e o servidor pelo tempo de ida e volta de cada consulta, faz acompanhamento a cada segundo e corrige divergências acima de 0,85 segundo. Atraso e indisponibilidade da plataforma ainda podem causar uma breve diferença ao trocar de música; o convidado ajusta a posição assim que o áudio estiver pronto. Pausa, avanço e troca do anfitrião são refletidos nos convidados. São aceitas faixas públicas de YouTube, SoundCloud e links Spotify/Deezer que o Glass já consegue reproduzir. Arquivos locais não são enviados.

Por padrão há no máximo 1000 salas, 8 pessoas por sala, 30 tentativas de criar/entrar por endereço/minuto e 1800 consultas ativas por endereço/minuto. `JAM_MAX_ROOMS` limita salas; `JAM_IDLE_TTL_MS` define a expiração por ausência do anfitrião (padrão 15 minutos). Convidados ausentes por 35 segundos saem da lista. Código de sala permite entrar; token privado de 192 bits autoriza cada sessão e nunca é incluído na lista de membros. A interface limpa a sessão ao sair e não a salva no disco.

Testes: `node node_modules/vitest/vitest.mjs run tests/unit/jam.test.ts`.
