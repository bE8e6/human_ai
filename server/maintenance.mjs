export function maintain(db,now=Date.now(),daily=false) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM sessions WHERE expires<?').run(now);
    db.prepare('DELETE FROM admin_sessions WHERE expires<?').run(now);
    db.prepare('DELETE FROM rate_limits WHERE until<?').run(now);
    db.prepare('DELETE FROM email_challenges WHERE expires<?').run(now-86400_000);
    const expired=db.prepare('SELECT id FROM users WHERE banned=1 AND banned_until<=? AND deleted_at IS NULL').all(now);
    db.prepare("UPDATE users SET banned=0,banned_until=NULL,ban_reason='' WHERE banned=1 AND banned_until<=? AND deleted_at IS NULL").run(now);
    for (const user of expired) db.prepare("INSERT INTO admin_audit(actor,action,target_id,reason,created_at) VALUES('system','temporary_ban_expired',?,'临时封禁到期自动解除',?)").run(user.id,now);
    if (daily) {
      db.prepare("UPDATE reports SET status='dismissed',result='超过一年未处理，证据已按保存规则移除',handled_at=?,handled_by='system',evidence_text='',reason='' WHERE status='pending' AND created_at<?").run(now,now-365*86400_000);
      db.prepare("DELETE FROM reports WHERE status!='pending' AND handled_at<?").run(now-180*86400_000);
      db.prepare('DELETE FROM account_notices WHERE created_at<?').run(now-180*86400_000);
      db.prepare('DELETE FROM admin_audit WHERE created_at<?').run(now-365*86400_000);
      db.prepare('DELETE FROM account_deletions WHERE deleted_at<?').run(now-35*86400_000);
    }
    db.exec('COMMIT');
    return expired.map(user=>user.id);
  } catch(error) {db.exec('ROLLBACK');throw error;}
}
