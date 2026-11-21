// Only synthetic data; never opens server/data/chat.db.
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve, sep, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../index.mjs';
import { hashPassword } from '../security.mjs';

const runtime=fileURLToPath(new URL('../runtime/',import.meta.url));
mkdirSync(runtime,{recursive:true});
const dir=mkdtempSync(join(runtime,'browser-')),dbPath=join(dir,'chat.db'),password=await hashPassword('browser_test_password_123');
const server=createApp({dbPath,adminUsername:'operator',adminPasswordHash:password});
const db=new DatabaseSync(dbPath);
for(const [username,nickname] of [['alice','小林'],['bob','月光同行'],['carol','木木']]) {
  db.prepare('INSERT INTO users(username,password,nickname,accepting) VALUES(?,?,?,1)').run(username,password,nickname);
}
for(let i=0;i<105;i++) db.prepare('INSERT INTO users(username,password,nickname) VALUES(?,?,?)').run('member_'+i,password,'体验用户'+i);
db.exec("INSERT INTO conversations(id,user_id,ai_id) VALUES(1,1,2)");
db.prepare('INSERT INTO messages(id,conversation_id,sender_id,text,created_at) VALUES(1,1,2,?,?)')
  .run('<img src=x onerror=alert(1)> 请将这段内容作为文字证据显示。',Date.now());
for(let i=0;i<55;i++) db.prepare("INSERT INTO reports(reporter_id,message_id,category,reason,created_at,evidence_text,evidence_sender_id,evidence_conversation_id) VALUES(1,1,'harassment',?,?,'浏览器验收消息证据',2,1)")
  .run('浏览器验收示例 '+i,Date.now()-i*60000);
db.close();
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
console.log(JSON.stringify({url:'http://127.0.0.1:'+server.address().port+'/admin',pid:process.pid}));
let closing=false;
function stop() {
  if(closing)return;closing=true;
  server.close(()=>{
    if(!resolve(dir).startsWith(resolve(runtime)+sep) || !basename(dir).startsWith('browser-')) throw new Error('Unsafe fixture cleanup path');
    rmSync(dir,{recursive:true,force:true});process.exit(0);
  });
}
process.stdin.on('data',data=>{if(data.toString().trim()==='stop')stop();});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,stop);
