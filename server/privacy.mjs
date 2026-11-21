import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { tokenDigest } from './database.mjs';

export const REMOVED_MESSAGE = '［发送者注销账号时已移除此消息］';
export const POLICY_VERSION = '2026-11-20';
export const DELETION_RETENTION_MS = 35 * 86400_000;

function transaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = work(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function anonymizeAccount(db, entry) {
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(entry.userId);
  if (!user || user.deleted_at || tokenDigest(user.username) !== entry.identityDigest) return false;
  return transaction(db, () => {
    db.prepare(`UPDATE users SET username=?,password='',nickname='已注销用户',bio='',ai_style='',ai_topics='',
      accepting=0,busy=0,banned=1,banned_until=NULL,ban_reason='',email=NULL,email_verified=0,
      notification_enabled=0,notification_preview=0,deleted_at=? WHERE id=?`)
      .run('__deleted_' + user.id + '__',entry.at,user.id);
    db.prepare("UPDATE users SET policy_version='',policy_accepted_at=0 WHERE id=?").run(user.id);
    db.prepare('UPDATE messages SET text=?,redacted=1 WHERE sender_id=?').run(REMOVED_MESSAGE,user.id);
    db.prepare('UPDATE conversations SET history_version=history_version+1 WHERE user_id=? OR ai_id=?').run(user.id,user.id);
    db.prepare("UPDATE sessions SET revoked_reason='ACCOUNT_DELETED' WHERE user_id=?").run(user.id);
    db.prepare('DELETE FROM blocks WHERE user_id=? OR target_id=?').run(user.id,user.id);
    db.prepare('DELETE FROM conversation_settings WHERE user_id=?').run(user.id);
    db.prepare('DELETE FROM email_challenges WHERE user_id=?').run(user.id);
    db.prepare('DELETE FROM account_notices WHERE user_id=?').run(user.id);
    db.prepare('INSERT OR IGNORE INTO account_deletions(user_id,identity_digest,deleted_at) VALUES(?,?,?)')
      .run(user.id,entry.identityDigest,entry.at);
    return true;
  });
}

export function readDeletionJournal(path) {
  if (!path || !existsSync(path)) return [];
  if (statSync(path).size > 10_000_000) throw new Error('注销处理日志过大，请按操作说明维护后再启动');
  const entries = [];
  for (const line of readFileSync(path,'utf8').split('\n').filter(Boolean)) {
    const entry = JSON.parse(line);
    if (!Number.isSafeInteger(entry.userId) || entry.userId < 1 ||
        !Number.isSafeInteger(entry.at) || entry.at < 1 || !/^[a-f0-9]{64}$/.test(entry.identityDigest)) {
      throw new Error('注销处理日志损坏，请恢复完整日志后再启动');
    }
    entries.push({userId:entry.userId,identityDigest:entry.identityDigest,at:entry.at});
  }
  return entries;
}

export function replayDeletions(db, path) {
  let applied = 0;
  for (const entry of readDeletionJournal(path)) if (anonymizeAccount(db,entry)) applied++;
  return applied;
}

export function createPrivacy(db, path) {
  if (path && !existsSync(path)) {
    try {writeFileSync(path,'',{flag:'wx',mode:0o600});}
    catch(error) {if (error.code!=='EEXIST') throw error;}
  }
  replayDeletions(db,path);
  function remove(user) {
    const entry = {userId:user.id,identityDigest:tokenDigest(user.username),at:Date.now()};
    // Write and fsync before touching the DB. Replay finishes deletion after a crash
    // and applies later deletions to a restored, older backup.
    if (path) {
      const fd = openSync(path,'a',0o600);
      try { appendFileSync(fd,JSON.stringify(entry)+'\n'); fsyncSync(fd); }
      finally { closeSync(fd); }
    }
    anonymizeAccount(db,entry);
  }
  function compact() {
    if (!path || !existsSync(path)) return;
    const entries = readDeletionJournal(path).filter(entry=>entry.at > Date.now()-DELETION_RETENTION_MS);
    const temporary = path + '.tmp';
    writeFileSync(temporary,entries.map(entry=>JSON.stringify(entry)+'\n').join(''),{mode:0o600});
    const fd = openSync(temporary,'r+');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary,path);
  }
  return {remove,compact};
}
