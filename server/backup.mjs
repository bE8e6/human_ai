import { DatabaseSync, backup } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, lstatSync, utimesSync, unlinkSync, writeFileSync, readdirSync, createReadStream } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { migrate, SCHEMA_VERSION } from './database.mjs';
import { readDeletionJournal, replayDeletions } from './privacy.mjs';

export const BACKUP_RETENTION_MS=30*86400_000;
const NAME=/^chat-\d{8}T\d{6}Z-[a-f0-9]{8}\.db$/;
function fail(message,code='BACKUP_INVALID') {throw Object.assign(new Error(message),{code,publicMessage:true});}
function sync(path) {const fd=openSync(path,'r+');try{fsyncSync(fd);}finally{closeSync(fd);}}
function child(directory,name) {
  const path=resolve(directory,name);
  if (!path.startsWith(resolve(directory)+sep) || basename(name)!==name) fail('备份文件必须位于备份目录中');
  return path;
}
export async function hashFile(path) {
  const digest=createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}
function inspect(path) {
  const db=new DatabaseSync(path,{readOnly:true});
  try {
    const version=db.prepare('PRAGMA user_version').get().user_version;
    if (version>SCHEMA_VERSION) fail('备份版本高于当前服务，请使用对应版本恢复','BACKUP_NEWER_SCHEMA');
    const check=db.prepare('PRAGMA integrity_check').all();
    if (check.length!==1 || check[0].integrity_check!=='ok' || db.prepare('PRAGMA foreign_key_check').all().length) fail('备份数据库完整性检查失败','BACKUP_CORRUPT');
    return {schemaVersion:version,counts:{users:db.prepare('SELECT COUNT(*) n FROM users').get().n,
      conversations:db.prepare('SELECT COUNT(*) n FROM conversations').get().n,messages:db.prepare('SELECT COUNT(*) n FROM messages').get().n}};
  } finally {db.close();}
}
function manifest(path) {
  if (!NAME.test(basename(path))) fail('不是本服务生成的备份文件');
  let data;
  try {data=JSON.parse(readFileSync(path+'.json','utf8'));}
  catch {fail('备份清单缺失或损坏','BACKUP_MANIFEST_MISSING');}
  if (data.file!==basename(path) || data.journal!==basename(path)+'.deletions.ndjson' ||
      !Number.isSafeInteger(data.createdAt) || data.createdAt<1 || !/^[a-f0-9]{64}$/.test(data.sha256) ||
      !/^[a-f0-9]{64}$/.test(data.journalSha256)) fail('备份清单无效');
  return data;
}
export async function createBackup({dbPath,backupDir,now=Date.now()}) {
  if (!existsSync(dbPath)) fail('源数据库不存在','BACKUP_SOURCE_MISSING');
  mkdirSync(backupDir,{recursive:true,mode:0o700});
  const stamp=new Date(now).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');
  const name='chat-'+stamp+'-'+randomBytes(4).toString('hex')+'.db',path=child(backupDir,name);
  const db=new DatabaseSync(dbPath,{readOnly:true});
  try {db.exec('PRAGMA busy_timeout=5000');await backup(db,path);}
  finally {db.close();}
  chmodSync(path,0o600);sync(path);
  const sourceJournal=dbPath+'.deletions.ndjson',journal=path+'.deletions.ndjson';
  if (existsSync(sourceJournal)) {
    readDeletionJournal(sourceJournal);copyFileSync(sourceJournal,journal);readDeletionJournal(journal);
  } else writeFileSync(journal,'',{mode:0o600});
  chmodSync(journal,0o600);sync(journal);
  const data={format:1,version:'2.0.0',file:name,journal:basename(journal),createdAt:now,
    sha256:await hashFile(path),journalSha256:await hashFile(journal),...inspect(path)};
  writeFileSync(path+'.json.tmp',JSON.stringify(data,null,2)+'\n',{mode:0o600});
  sync(path+'.json.tmp');renameSync(path+'.json.tmp',path+'.json');
  writeFileSync(join(backupDir,'last-success.json'),JSON.stringify({at:now,file:name})+'\n',{mode:0o600});
  pruneBackups(backupDir,now);
  pruneRecoveryCopies(dbPath,now);
  return {path,...data};
}
export function listBackups(backupDir) {
  if (!existsSync(backupDir)) return [];
  return readdirSync(backupDir).filter(name=>NAME.test(name)).map(name=>{
    const path=child(backupDir,name);if (!existsSync(path+'.json')) return null;
    return {path,...manifest(path)};
  }).filter(Boolean).sort((a,b)=>b.createdAt-a.createdAt);
}
export function pruneBackups(backupDir,now=Date.now()) {
  for (const entry of listBackups(backupDir)) {
    if (entry.createdAt>=now-BACKUP_RETENTION_MS) continue;
    for (const name of [entry.file,entry.file+'.json',entry.journal]) {
      const path=child(backupDir,name);if (existsSync(path)) unlinkSync(path);
    }
  }
  // Remove incomplete snapshots only after a day; never touch unrelated files.
  for (const name of readdirSync(backupDir)) {
    if (!/^chat-\d{8}T\d{6}Z-[a-f0-9]{8}\.db(?:\.json\.tmp|\.deletions\.ndjson)?$/.test(name)) continue;
    const path=child(backupDir,name),dbName=name.match(/^chat-\d{8}T\d{6}Z-[a-f0-9]{8}\.db/)[0];
    if (!existsSync(child(backupDir,dbName+'.json')) && statSync(path).mtimeMs<now-86400_000) unlinkSync(path);
  }
}
export function pruneRecoveryCopies(dbPath,now=Date.now()) {
  if (dbPath===':memory:') return;
  const directory=dirname(resolve(dbPath)),prefix=basename(dbPath)+'.before-restore-';
  if (!existsSync(directory)) return;
  for (const name of readdirSync(directory)) {
    if (!name.startsWith(prefix) || !/^[a-f0-9]{8}$/.test(name.slice(prefix.length))) continue;
    const path=child(directory,name);
    try {
      const info=lstatSync(path);
      if (info.isFile() && info.mtimeMs<now-BACKUP_RETENTION_MS) unlinkSync(path);
    } catch(error) {if (error.code!=='ENOENT') throw error;}
  }
}
export async function verifyBackup(path) {
  const data=manifest(path);
  if (await hashFile(path)!==data.sha256 || await hashFile(path+'.deletions.ndjson')!==data.journalSha256) fail('备份或注销日志校验摘要不匹配','BACKUP_HASH_MISMATCH');
  readDeletionJournal(path+'.deletions.ndjson');
  return {...data,...inspect(path)};
}
export async function restoreBackup({backupPath,targetPath,latestJournalPath,replace=false,stopped=false,preserveSchema=false,now=Date.now()}) {
  if (!stopped) fail('恢复前必须停服并明确传入 --stopped','RESTORE_REQUIRES_STOP');
  if (resolve(backupPath)===resolve(targetPath)) fail('不能覆盖备份原文件');
  if (existsSync(targetPath) && !replace) fail('目标已存在，停服后使用 --replace 才可替换','RESTORE_TARGET_EXISTS');
  const data=await verifyBackup(backupPath);
  if (data.createdAt<now-BACKUP_RETENTION_MS || data.createdAt>now+300_000) fail('仅允许恢复30天内、时间有效的备份','RESTORE_BACKUP_EXPIRED');
  if (!latestJournalPath || !existsSync(latestJournalPath)) fail('必须提供最新注销日志，空日志也应保留','RESTORE_JOURNAL_REQUIRED');
  const entries=new Map();
  const journals=[backupPath+'.deletions.ndjson',latestJournalPath];
  if (existsSync(targetPath+'.deletions.ndjson')) journals.push(targetPath+'.deletions.ndjson');
  for (const path of journals) for (const entry of readDeletionJournal(path)) {
    const key=entry.userId+':'+entry.identityDigest,previous=entries.get(key);
    if (!previous || previous.at<entry.at) entries.set(key,entry);
  }
  if (preserveSchema && data.schemaVersion<6 && entries.size) fail('旧数据库版本无法安全重放后续注销，请使用当前版本恢复并向前修复','ROLLBACK_PRIVACY_UNSUPPORTED');
  mkdirSync(dirname(targetPath),{recursive:true,mode:0o700});
  const nonce=randomBytes(4).toString('hex'),temporary=targetPath+'.restore-'+nonce+'.tmp';
  const journalTemp=targetPath+'.deletions.ndjson.restore-'+nonce+'.tmp';
  copyFileSync(backupPath,temporary);chmodSync(temporary,0o600);
  writeFileSync(journalTemp,[...entries.values()].sort((a,b)=>a.at-b.at).map(entry=>JSON.stringify(entry)+'\n').join(''),{mode:0o600});
  sync(journalTemp);
  const db=new DatabaseSync(temporary);
  let replayed,counts;
  try {
    if (!preserveSchema) migrate(db);
    replayed=entries.size?replayDeletions(db,journalTemp):0;
    const hasTable=name=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
    const sessionColumns=db.prepare('PRAGMA table_info(sessions)').all().map(column=>column.name);
    if (sessionColumns.includes('revoked_reason')) db.prepare("UPDATE sessions SET revoked_reason=COALESCE(revoked_reason,'SERVICE_RESTORED')").run();
    else db.exec('DELETE FROM sessions');
    if (hasTable('admin_sessions')) db.exec('DELETE FROM admin_sessions');
    if (hasTable('email_challenges')) db.prepare('UPDATE email_challenges SET used_at=? WHERE used_at IS NULL').run(now);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {db.close();}
  const restored=inspect(temporary);counts=restored.counts;sync(temporary);
  if (existsSync(targetPath)) {
    const old=new DatabaseSync(targetPath);
    try {old.exec('PRAGMA busy_timeout=2000');if (old.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get().busy) fail('数据库仍被使用，请停止服务','RESTORE_DATABASE_BUSY');}
    catch(error) {if (error.publicMessage || existsSync(targetPath+'-wal') || existsSync(targetPath+'-shm')) throw error;}
    finally {old.close();}
    if (existsSync(targetPath+'-wal') || existsSync(targetPath+'-shm')) fail('数据库连接尚未释放，请停止服务','RESTORE_DATABASE_BUSY');
  }
  const preserved=existsSync(targetPath)?targetPath+'.before-restore-'+nonce:null;
  // Put the newest privacy ledger in place first. A crash cannot resurrect data.
  renameSync(journalTemp,targetPath+'.deletions.ndjson');
  if (preserved) renameSync(targetPath,preserved);
  try {if (preserved) utimesSync(preserved,new Date(now),new Date(now));renameSync(temporary,targetPath);}
  catch(error) {if (preserved && !existsSync(targetPath)) renameSync(preserved,targetPath);throw error;}
  pruneRecoveryCopies(targetPath,now);
  return {ok:true,targetPath,preserved,replayed,counts,schemaVersion:restored.schemaVersion};
}
