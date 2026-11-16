import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, delimiter } from 'node:path';
const env={...process.env};const local=resolve('../../work');
if(!env.CARGO_HOME && existsSync(resolve(local,'cargo/bin/cargo.exe'))){env.CARGO_HOME=resolve(local,'cargo');env.RUSTUP_HOME=resolve(local,'rustup');env.PATH=resolve(env.CARGO_HOME,'bin')+delimiter+(env.PATH||'');}
const cargo=env.CARGO_HOME?resolve(env.CARGO_HOME,'bin',process.platform==='win32'?'cargo.exe':'cargo'):'cargo';
const child=spawn(cargo,process.argv.slice(2),{env,stdio:'inherit',windowsHide:true});child.on('error',e=>{console.error(e.message);process.exitCode=1;});child.on('exit',code=>process.exitCode=code??1);
