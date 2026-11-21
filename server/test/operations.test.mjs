import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseEnv } from 'node:util';
import { randomUUID } from 'node:crypto';
import { fixture, PASSWORD } from './helpers.mjs';
import { createBackup, verifyBackup, restoreBackup, pruneBackups, pruneRecoveryCopies, hashFile } from '../backup.mjs';
import { startupConfig } from '../config.mjs';
import { verifyPassword } from '../security.mjs';
import { SCHEMA_VERSION } from '../database.mjs';

test('在线备份包含WAL中的最新消息，恢复后保留编号和账号，强制退出所有旧设备',async t=>{
  const f=await fixture(t),{a,b,path}=await f.pair(),payload={text:'在线备份必须保存的消息',clientMessageId:randomUUID()};
  const sent=await f.call(path,a.token,payload,201);
  await f.call(path,b.token,{text:'另一方回复',clientMessageId:randomUUID()},201);
  const snapshot=await createBackup({dbPath:f.dbPath,backupDir:join(f.dir,'backups')});
  assert.deepEqual(snapshot.counts,{users:2,conversations:1,messages:2});
  assert.equal((await verifyBackup(snapshot.path)).schemaVersion,SCHEMA_VERSION);
  await assert.rejects(restoreBackup({backupPath:snapshot.path,targetPath:f.dbPath,latestJournalPath:f.dbPath+'.deletions.ndjson',replace:true}),{code:'RESTORE_REQUIRES_STOP'});
  await f.stop();
  const result=await restoreBackup({backupPath:snapshot.path,targetPath:f.dbPath,latestJournalPath:f.dbPath+'.deletions.ndjson',replace:true,stopped:true});
  assert.equal(existsSync(result.preserved),true);
  await f.start();
  for(const account of [a,b]) assert.equal((await f.call('/me',account.token,undefined,401)).code,'SERVICE_RESTORED');
  const next=await f.call('/auth/login','',{username:'alice',password:PASSWORD});
  assert.equal((await f.call(path,next.token)).messages.length,2);
  const retry=await f.call(path,next.token,payload);
  assert.equal(retry.messageId,sent.messageId);assert.equal(retry.replayed,true);
});

test('损坏备份、缺失最新注销日志和过期备份均拒绝覆盖当前数据库；轮换只删除本服务备份',async t=>{
  const f=await fixture(t);await f.register('alice');
  const directory=join(f.dir,'backups'),snapshot=await createBackup({dbPath:f.dbPath,backupDir:directory});
  const originalHash=await hashFile(f.dbPath);
  await assert.rejects(restoreBackup({backupPath:snapshot.path,targetPath:join(f.dir,'new.db'),stopped:true}),{code:'RESTORE_JOURNAL_REQUIRED'});
  const bytes=readFileSync(snapshot.path);writeFileSync(snapshot.path,Buffer.concat([bytes,Buffer.from('corrupted')]));
  await assert.rejects(restoreBackup({backupPath:snapshot.path,targetPath:f.dbPath,stopped:true,replace:true,latestJournalPath:f.dbPath+'.deletions.ndjson'}),{code:'BACKUP_HASH_MISMATCH'});
  assert.equal(await hashFile(f.dbPath),originalHash);writeFileSync(snapshot.path,bytes);
  const data=JSON.parse(readFileSync(snapshot.path+'.json','utf8'));
  writeFileSync(snapshot.path+'.json',JSON.stringify({...data,file:'../outside.db'}));
  await assert.rejects(verifyBackup(snapshot.path),{code:'BACKUP_INVALID'});
  writeFileSync(snapshot.path+'.json',JSON.stringify({...data,createdAt:Date.now()-31*86400_000}));
  await assert.rejects(restoreBackup({backupPath:snapshot.path,targetPath:f.dbPath,stopped:true,replace:true,latestJournalPath:f.dbPath+'.deletions.ndjson'}),{code:'RESTORE_BACKUP_EXPIRED'});
  const unrelated=join(directory,'operator-notes.txt');writeFileSync(unrelated,'不要删除');
  pruneBackups(directory);
  assert.equal(existsSync(snapshot.path),false);assert.equal(readFileSync(unrelated,'utf8'),'不要删除');
  const oldCopy=f.dbPath+'.before-restore-deadbeef',recentCopy=f.dbPath+'.before-restore-feedface',notes=f.dbPath+'.before-restore-operator-notes';
  writeFileSync(oldCopy,bytes);writeFileSync(recentCopy,bytes);writeFileSync(notes,'操作记录');
  const oldAt=new Date(Date.now()-31*86400_000);utimesSync(oldCopy,oldAt,oldAt);utimesSync(notes,oldAt,oldAt);
  pruneRecoveryCopies(f.dbPath);
  assert.equal(existsSync(oldCopy),false);assert.equal(existsSync(recentCopy),true);assert.equal(readFileSync(notes,'utf8'),'操作记录');
});

test('数据库损坏时可从已验证备份恢复，损坏原文件保留供排查',async t=>{
  const f=await fixture(t);await f.register('alice');
  const snapshot=await createBackup({dbPath:f.dbPath,backupDir:join(f.dir,'backups')});
  await f.stop();writeFileSync(f.dbPath,'damaged database');
  const result=await restoreBackup({backupPath:snapshot.path,targetPath:f.dbPath,latestJournalPath:f.dbPath+'.deletions.ndjson',replace:true,stopped:true});
  assert.equal(readFileSync(result.preserved,'utf8'),'damaged database');
  await f.start();await f.call('/auth/login','',{username:'alice',password:PASSWORD});
});

test('回退可保留V1原schema，退出旧凭据；若旧schema无法处理后续注销则安全拒绝回退',async t=>{
  const f=await fixture(t),legacy=join(f.dir,'legacy.db');
  f.sql(db=>db.exec(`
    CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT UNIQUE,password TEXT,accepting INTEGER DEFAULT 0,banned INTEGER DEFAULT 0);
    CREATE TABLE sessions(token TEXT PRIMARY KEY,user_id INTEGER REFERENCES users(id),expires INTEGER);
    CREATE TABLE conversations(id INTEGER PRIMARY KEY,user_id INTEGER REFERENCES users(id),ai_id INTEGER REFERENCES users(id),user_read INTEGER DEFAULT 0,ai_read INTEGER DEFAULT 0);
    CREATE TABLE messages(id INTEGER PRIMARY KEY,conversation_id INTEGER REFERENCES conversations(id),sender_id INTEGER REFERENCES users(id),text TEXT,created_at INTEGER);
    CREATE TABLE blocks(user_id INTEGER REFERENCES users(id),target_id INTEGER REFERENCES users(id));
    CREATE TABLE reports(id INTEGER PRIMARY KEY,reporter_id INTEGER REFERENCES users(id),message_id INTEGER REFERENCES messages(id),reason TEXT,created_at INTEGER);
    INSERT INTO users VALUES(1,'legacy_a','unused',0,0),(2,'legacy_b','unused',0,0);
    INSERT INTO conversations VALUES(1,1,2,0,0);INSERT INTO messages VALUES(1,1,1,'旧记录',1);
    INSERT INTO sessions VALUES('legacy-token',1,9999999999999);
  `),legacy);
  const snapshot=await createBackup({dbPath:legacy,backupDir:join(f.dir,'legacy-backups')}),target=join(f.dir,'legacy-restored.db');
  const restored=await restoreBackup({backupPath:snapshot.path,targetPath:target,latestJournalPath:snapshot.path+'.deletions.ndjson',stopped:true,preserveSchema:true});
  assert.equal(restored.schemaVersion,0);
  f.sql(db=>{assert.equal(db.prepare('PRAGMA user_version').get().user_version,0);assert.equal(db.prepare('SELECT COUNT(*) n FROM sessions').get().n,0);assert.equal(db.prepare('SELECT text FROM messages').get().text,'旧记录');},target);
  const journal=join(f.dir,'later-deletions.ndjson');
  writeFileSync(journal,JSON.stringify({userId:1,identityDigest:'a'.repeat(64),at:Date.now()})+'\n');
  await assert.rejects(restoreBackup({backupPath:snapshot.path,targetPath:join(f.dir,'unsafe.db'),latestJournalPath:journal,stopped:true,preserveSchema:true}),{code:'ROLLBACK_PRIVACY_UNSUPPORTED'});
});

test('配置生成保存摘要而非密码，拒绝覆盖已有密钥；生产配置错误不把秘密写入日志',async t=>{
  const f=await fixture(t),file=join(f.dir,'test.env'),password='not_saved_admin_password';
  const init=spawnSync(process.execPath,['scripts/init-env.mjs','--environment','test','--output',file],{input:password+'\n',encoding:'utf8',cwd:new URL('../',import.meta.url)});
  assert.equal(init.status,0,init.stderr);assert.equal(init.stdout.includes(password),false);
  const text=readFileSync(file,'utf8'),values=parseEnv(text);
  assert.equal(text.includes(password),false);assert.equal(await verifyPassword(password,values.ADMIN_PASSWORD_HASH),true);
  assert.equal(values.METRICS_KEY.length,64);
  assert.equal(startupConfig({...values,NODE_ENV:values.SERVICE_ENV}).allowedOrigin,'http://127.0.0.1:18787');
  const before=await hashFile(file),again=spawnSync(process.execPath,['scripts/init-env.mjs','--output',file],{input:'other_password\n',encoding:'utf8',cwd:new URL('../',import.meta.url)});
  assert.equal(again.status,1);assert.equal(await hashFile(file),before);
  const secret='sensitive-configuration-string';
  const bad=spawnSync(process.execPath,['index.mjs'],{env:{...process.env,NODE_ENV:'production',PUBLIC_ORIGIN:'https://chat.example.com',ADMIN_PASSWORD_HASH:secret,METRICS_KEY:secret,DB_PATH:join(f.dir,'not-created.db')},
    encoding:'utf8',cwd:new URL('../',import.meta.url)});
  assert.equal(bad.status,1);assert.equal(bad.stderr.includes(secret),false);assert.equal(existsSync(join(f.dir,'not-created.db')),false);
  assert.throws(()=>startupConfig({NODE_ENV:'production',PUBLIC_ORIGIN:'http://chat.example.com'}),{code:'CONFIG_INVALID'});
});

test('监测接口需要独立密钥，只返回容量与健康指标，不暴露账号和消息',async t=>{
  const key='test-metrics-key-with-at-least-32-characters',f=await fixture(t,{metricsKey:key}),a=await f.register('alice');
  await f.call('/internal/metrics',a.token,undefined,403);
  const metrics=await f.call('/internal/metrics','',undefined,200,{'X-Metrics-Key':key});
  assert.ok(metrics.rssBytes>0);assert.equal(metrics.schemaVersion,SCHEMA_VERSION);
  assert.equal(JSON.stringify(metrics).includes('alice'),false);assert.equal('users' in metrics,false);
});
