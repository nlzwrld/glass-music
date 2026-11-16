import {readFile,readdir,writeFile} from 'node:fs/promises';
import {resolve,join,basename} from 'node:path';
const pkg=JSON.parse(await readFile('package.json','utf8'));const repository=process.env.GITHUB_REPOSITORY||'nlzwrld/glass-music';const dir=resolve(process.env.CARGO_TARGET_DIR||'src-tauri/target','release/bundle/nsis');const file=(await readdir(dir)).find(f=>f.includes(`_${pkg.version}_`)&&f.endsWith('-setup.exe'));if(!file)throw new Error('Signed installer missing');
const signature=(await readFile(join(dir,file+'.sig'),'utf8')).trim();const url=`https://github.com/${repository}/releases/download/v${pkg.version}/${encodeURIComponent(basename(file).replace(/\s/g,'.'))}`;
await writeFile('latest.json',JSON.stringify({version:pkg.version,notes:`Glass Music ${pkg.version}`,pub_date:new Date().toISOString(),platforms:{'windows-x86_64':{signature,url}}},null,2)+'\n');
