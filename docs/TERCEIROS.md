# Componentes e atribuições

- Tauri e plugins oficiais: MIT/Apache-2.0. https://github.com/tauri-apps/tauri
- React: MIT. https://github.com/facebook/react
- shadcn/ui: MIT, Copyright (c) 2023 shadcn. Os componentes Button, Switch e Input foram obtidos do registro oficial New York e adaptados ao visual Glass Music. https://github.com/shadcn-ui/ui
- Radix UI: MIT. https://github.com/radix-ui/primitives
- Tailwind CSS: MIT. https://github.com/tailwindlabs/tailwindcss
- Motion: MIT. https://github.com/motiondivision/motion
- liquid-glass-react 1.1.1: MIT. https://github.com/rdev/liquid-glass-react — licença integral em `licenses/liquid-glass-react.txt`. Usado nas superfícies ópticas dos botões principais de reprodução. A implementação própria dos mapas de refração dos painéis e a avaliação técnica estão em `LIQUID-GLASS-V2.md`.
- Lucide: ISC. https://github.com/lucide-icons/lucide
- Zustand: MIT. https://github.com/pmndrs/zustand
- TanStack Virtual: MIT. https://github.com/TanStack/virtual
- Pixelmatch (ISC) e pngjs (MIT): ferramentas de comparação visual usadas somente no desenvolvimento. https://github.com/mapbox/pixelmatch e https://github.com/pngjs/pngjs
- Vite, Vitest, Playwright, rusqlite, reqwest, lofty e demais dependências: consulte as licenças incluídas em seus pacotes e os arquivos de versões travadas `pnpm-lock.yaml` e `src-tauri/Cargo.lock`.

- yt-dlp 2026.10.26: programa separado para consultas públicas de metadados. Código principal Unlicense; a distribuição Windows agregada contém componentes GPLv3+ e outras licenças. Consulte as licenças integrais em `../assets/catalog/yt-dlp-LICENSE` e `../assets/catalog/yt-dlp-THIRD_PARTY_LICENSES.txt`, com origens e componentes. Binário oficial: https://github.com/yt-dlp/yt-dlp/releases/tag/2026.10.26 . O adaptador `glass_soundcloud.py` é código original MIT. O auxiliar não é vinculado ao executável Rust.

YouTube e SoundCloud são marcas dos respectivos titulares. Glass Music é um cliente independente, sem afiliação ou patrocínio dessas empresas. As interfaces incorporadas e seu conteúdo pertencem aos respectivos provedores/autores.

Texto da licença MIT dos componentes shadcn/ui:

Copyright (c) 2023 shadcn

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Liquid Glass V3

Shader adaptado de [el-gladiador/liquid-glass-react](https://github.com/el-gladiador/liquid-glass-react), revisão `21e5c3a7ba1316c5ab679fbeeabe29e447c0b736`, MIT, Copyright (c) 2026 Zaki. A licença integral acompanha `src/components/glass/v3/vendor/LICENSE` e `public/licenses/glass-webgl-MIT.txt` (também incluída no build). O compositor, a cena e os componentes de integração são locais. O pacote de captura DOM e os demais quatro candidatos estudados não foram incorporados. Veja `LIQUID-GLASS-V3.md`.
