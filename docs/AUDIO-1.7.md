# Áudio do YouTube dentro do Glass — 1.7

A versão 1.6 direcionava músicas do YouTube ao navegador ao remover o player de vídeo. A versão 1.7 corrige essa interpretação: músicas usam o próprio mecanismo de áudio do Glass. Artistas e coleções continuam como links externos.

O yt-dlp incluído resolve somente um fluxo de áudio HTTPS. O núcleo valida ID, destino `*.googlevideo.com/videoplayback`, codec sem vídeo e prazo de validade. Endereços temporários ficam em memória e não são enviados ao frontend ou gravados na biblioteca. O elemento HTML de áudio recebe somente uma URL local com token aleatório; o servidor local transmite o conteúdo e encaminha intervalos para permitir seek. Não há arquivo de música salvo, iframe do YouTube ou elemento de vídeo.

As consultas respeitam o acesso online e a aceitação inicial. Desativar o acesso cancela consultas, invalida endereços locais e interrompe o áudio. A resolução tem limite de tempo e tamanho; é cancelada ao trocar de faixa. A lista de destinos do fluxo não aceita URLs arbitrárias, IPs locais, credenciais ou portas alternativas.

É uma integração pública não oficial e pode exigir atualização quando a plataforma mudar. Conteúdo privado, regional, bloqueado ou que exige login pode não tocar. Esta entrega não importa cookies ou conta do navegador. Spotify e Deezer continuam como links externos; a alteração desta versão se aplica às músicas do YouTube.
