# Glass Music 1.8.1 — correção do contorno externo

Correção solicitada em 15/11/2026. A versão 1.8.0 não cobria o contorno visível ao maximizar: retirava a região e mantinha estilos de moldura. Os testes antigos consultavam somente pontos do retângulo externo do HWND e não cobriam os cantos da área cliente maximizada.

A nova região é arredondada na área cliente efetiva em todos os estados. WS_CAPTION é removido e a borda do compositor DWM é suprimida, mantendo WS_THICKFRAME e o Acrylic transparente. A região é conferida de verdade em vez de usar um cache de tamanho. Nenhuma mudança foi feita no áudio ou na biblioteca.

As evidências e resultados finais desta correção são anexados depois dos testes no executável instalado. O relatório da 1.8 é histórico; esta nota substitui suas conclusões sobre a janela maximizada.
