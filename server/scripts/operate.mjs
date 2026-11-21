import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startupConfig } from '../config.mjs';

const args=process.argv.slice(2),action=args.shift(),option=name=>{const i=args.indexOf(name);return i<0?'':args[i+1] || '';};
const environment=option('--environment') || 'test';
function fail(message) {throw Object.assign(new Error(message),{publicMessage:true});}
if(!['test','production'].includes(environment))fail('环境只能为test或production');
const root=fileURLToPath(new URL('../../',import.meta.url)),file=resolve(option('--env-file') || root+'deploy/.env.'+environment);
let settings,childEnv;
function readSettings() {
  if(!existsSync(file))fail('尚未生成配置，请先运行 init-env.mjs。');
  settings=parseEnv(readFileSync(file,'utf8'));childEnv={...process.env,...settings};
}
function compose(command,capture=false,image='') {
  const publicService=(settings.PUBLIC_ORIGIN || '').startsWith('https://');
  const prefix=['compose','--project-name','human-ai-'+environment,'--env-file',file,'-f',root+'deploy/compose.yaml'];
  if(publicService)prefix.push('--profile','public');
  const result=spawnSync(process.platform==='win32'?'docker.exe':'docker',[...prefix,...command],
    {stdio:capture?['inherit','pipe','inherit']:'inherit',encoding:'utf8',env:{...childEnv,...(image?{CHAT_IMAGE:image}:{})}});
  if(result.status!==0)fail('Docker操作失败，请检查引擎是否已启动、配置和容器日志。');
  return capture?JSON.parse(result.stdout):undefined;
}
function validate() {
  startupConfig({...settings,NODE_ENV:settings.SERVICE_ENV,PORT:'8787',TRUSTED_PROXIES:settings.PROXY_IP});
  if((settings.PUBLIC_ORIGIN || '').startsWith('https://') && (!settings.DOMAIN || settings.DOMAIN.endsWith('.example.com')))fail('公网启动前需设置真实DOMAIN与PUBLIC_ORIGIN。');
  compose(['config','--quiet']);
}
function validateImage(image) {
  if(!/^[a-zA-Z0-9][a-zA-Z0-9._:/@-]{1,240}$/.test(image))fail('镜像名称无效');
}
function validateBackup(name) {
  if(!/^chat-\d{8}T\d{6}Z-[a-f0-9]{8}\.db$/.test(name))fail('请使用list-backups中列出的完整备份文件名');
}
function updateImage(image) {
  validateImage(image);
  const text=readFileSync(file,'utf8'),next=/^CHAT_IMAGE=.*$/m.test(text)?text.replace(/^CHAT_IMAGE=.*$/m,'CHAT_IMAGE='+image):text+'\nCHAT_IMAGE='+image+'\n';
  writeFileSync(file+'.tmp',next,{mode:0o600});renameSync(file+'.tmp',file);readSettings();
}
function snapshot() {return compose(['run','--rm','--no-deps','-T','backup','node','scripts/backup.mjs','create','/data/chat.db','/backups'],true);}
function verifySnapshot(name) {validateBackup(name);return compose(['run','--rm','--no-deps','-T','backup','node','scripts/backup.mjs','verify','/backups/'+name],true);}
function stop() {compose(['stop','gateway','monitor','backup','server']);}
function start() {
  compose(['up','-d','--no-build','--wait','--wait-timeout','90','server','backup','monitor']);
  if((settings.PUBLIC_ORIGIN || '').startsWith('https://'))compose(['up','-d','--wait','gateway']);
}
function restore(name,image='',preserve=false) {
  validateBackup(name);
  return compose(['run','--rm','--no-deps','-T','server','node','scripts/backup.mjs','restore','/backups/'+name,'/data/chat.db',
    '--latest-journal','/data/chat.db.deletions.ndjson','--replace','--stopped',...(preserve?['--preserve-schema']:[])],true,image);
}
try {
  readSettings();
  if(action==='validate') {validate();console.log('部署配置通过检查。');}
  else if(action==='start') {validate();start();}
  else if(action==='build') {validate();compose(['build','server']);}
  else if(action==='stop')stop();
  else if(action==='status')compose(['ps']);
  else if(action==='logs')compose(['logs','--tail','100']);
  else if(action==='stats')compose(['stats','--no-stream']);
  else if(action==='backup')console.log(JSON.stringify(snapshot(),null,2));
  else if(action==='list-backups')compose(['run','--rm','--no-deps','-T','backup','node','scripts/backup.mjs','list','/backups']);
  else if(action==='restore') {
    const name=option('--backup');validateBackup(name);validate();verifySnapshot(name);stop();
    try {console.log(JSON.stringify(restore(name),null,2));} catch(error) {start();throw error;}
    start();
  }
  else if(action==='upgrade') {
    validate();const previous=settings.CHAT_IMAGE || 'human-ai:2.0.0',next=option('--image');
    if(!next || next===previous)fail('升级需使用与当前不同的 --image 标签，并先准备好新版源码。');
    validateImage(next);
    compose(['build','server'],false,next);
    stop();let before;
    try {before=snapshot();} catch(error) {start();throw error;}
    writeFileSync(file+'.rollback.json',JSON.stringify({image:previous,backup:before.file,at:Date.now()})+'\n',{mode:0o600});
    updateImage(next);
    try {start();console.log('升级完成，回退镜像与备份已记录。');}
    catch(error) {
      stop();restore(before.file,next,true);updateImage(previous);start();fail('新版启动失败，已恢复升级前备份和镜像。');
    }
  }
  else if(action==='rollback') {
    const state=JSON.parse(readFileSync(file+'.rollback.json','utf8')),current=settings.CHAT_IMAGE;
    validateBackup(state.backup);validateImage(state.image);validateImage(current);
    validate();verifySnapshot(state.backup);stop();restore(state.backup,current,true);updateImage(state.image);start();console.log('已恢复升级前备份和镜像；所有登录需重新建立。');
  }
  else fail('动作：validate/start/stop/status/logs/stats/build/backup/list-backups/restore/upgrade/rollback');
} catch(error) {console.error(error.publicMessage?error.message:'操作失败，请检查配置文件和操作说明。');process.exitCode=1;}
