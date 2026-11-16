import {readFile,writeFile} from 'node:fs/promises';
const pkg=JSON.parse(await readFile('package.json','utf8'));
const [major,minor,patch]=pkg.version.split('.').map(Number);
if(process.env.GITHUB_RUN_NUMBER)pkg.version=`${major}.${minor}.${patch+Number(process.env.GITHUB_RUN_NUMBER)}`;
await writeFile('package.json',JSON.stringify(pkg,null,2)+'\n');
const config=JSON.parse(await readFile('src-tauri/tauri.conf.json','utf8'));config.version=pkg.version;await writeFile('src-tauri/tauri.conf.json',JSON.stringify(config,null,2)+'\n');
const cargo=(await readFile('src-tauri/Cargo.toml','utf8')).replace(/^(version = ")[^"]+/m,`$1${pkg.version}`);await writeFile('src-tauri/Cargo.toml',cargo);
const repository=process.env.GITHUB_REPOSITORY||'nlzwrld/glass-music';await writeFile('src-tauri/release.json',JSON.stringify({repository,endpoint:`https://github.com/${repository}/releases/latest/download/latest.json`})+'\n');
