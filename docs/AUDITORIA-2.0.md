# Auditoria Glass Music 2.0

Base verificada: projeto existente 1.9.0 em 2026-11-15. Backup do código em glass-1.9-before.zip. Sem repositório Git. Não alterar serviços de mídia nesta reformulação.

Tauri 2 / Rust / WebView2, React 19, TypeScript, Vite 8. CSS global + Tailwind; Zustand para estado, SQLite para biblioteca/preferências e DPAPI para credenciais. App.tsx monta janela, navegação, player e OpticalEngine. Media e contas passam por lib/native.ts. Native corners.rs mantém o recorte externo. Tauri já integra window-vibrancy transitivamente e configura Acrylic; manter, sem nova biblioteca ou migração. Recursos WebGL2 precisam ser detectados no contexto real, não pelo campo gpu:true do backend.

| Problema | Causa | Solução | Arquivos afetados | Risco | Validação |
|---|---|---|---|---|---|
| Fundo rosa fixo | drawScene desenha paleta fixa e capa borrada | Paleta por capa, cache limitado e interpolação; preservar ambiente antigo e desktop | ambient.ts, scene.ts, OpticalEngine.tsx | CORS, contraste | Capa verde/vermelha/escura, cache, temas |
| Preferências divididas | optics em localStorage, demais em SQLite | Migrar optics uma vez para appearance no SQLite | model.ts, store, db.rs, Settings | Perda de escolha anterior | Reinício, defaults, validação nativa |
| Materiais genéricos | Apenas thin/regular/deep | Clear, Frosted, Floating, Subtle com IOR/Fresnel/bordas e tokens | model/materials/renderer/shader | GPU e legibilidade | comparação óptica e fallback |
| Sidebar sem controle de recolhimento | Estado existe mas não há ação | Controle, cápsula Motion, persistência e modo compacto | Sidebar, App, CSS | clipping | teclado, cinco resoluções |
| Player em uma faixa horizontal apertada | timeline separada do transporte | Três colunas; timeline sob transporte | GlassPlayer, CSS | controles ocultos | play/pause/seek/volume/mini |
| Tipografia pequena e grid fixo | tamanhos 11px e cinco colunas | Segoe Variable, tokens e grid adaptativo | design-system.css | rolagem | 1280–2560, escala 100–125% |
| Capa sem loading e ações limitadas | img simples e botão + | skeleton, fallback, menu acessível | Cover, TrackCard, OnlineCatalog | hover/teclado | imagem indisponível, foco |
| Preferência de redução do SO ignorada pelo motor | só preferência interna | respeitar matchMedia, pausar invisível e liberar GPU | OpticalEngine | trabalho ocioso | context loss, minimizar, idle |

## Avaliação dos projetos pedidos

- Hla-aung/liquid-glass: MIT; Three.js, WebGL e html2canvas-pro. Estudados engine.ts e shaders.ts (Snell, SDF e mapa de fundo). Reutilizar o contexto compartilhado existente; implementar IOR e Fresnel no shader local. Sem copiar código novo e sem capturas DOM contínuas.
- window-vibrancy: MIT/Apache-2.0; já integrado pelo Tauri. Acrylic preserva o pedido anterior de desktop transparente; Mica é Windows 11 e não reproduz o mesmo fundo. Limitações de resize documentadas pelo projeto.
- Motion, Lucide, Zustand e TanStack Virtual já instalados e usados. Expandir o uso existente sem dependências redundantes.
- Appllama/liquid-glass-screens: Expo/React Native/Skia, GPL-3.0-only. Apenas referência de composição e hierarquia; nenhum código incorporado.
- react-three-fiber/drei: renderizador Three e helpers 3D; desnecessários para as superfícies 2D já cobertas por um contexto WebGL2.
- vanilla-extract: não introduzir uma segunda infraestrutura de estilos; tokens CSS dão configuração sem custo em runtime.

Refração cobre apenas o canvas sincronizado do ambiente/cor/imagem personalizada. DOM, capas de cards, vídeo e desktop nativo não são capturados. Texto/ícones ficam nítidos por cima. Fallback CSS é identificado como fallback.

Fontes: https://github.com/Hla-aung/liquid-glass ; https://github.com/tauri-apps/window-vibrancy ; https://motion.dev/docs/react ; https://github.com/lucide-icons/lucide ; https://github.com/Appllama/liquid-glass-screens ; https://github.com/pmndrs/react-three-fiber ; https://github.com/pmndrs/drei ; https://github.com/pmndrs/zustand ; https://github.com/TanStack/virtual ; https://github.com/vanilla-extract-css/vanilla-extract
