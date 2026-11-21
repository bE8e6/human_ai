import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync, readFileSync } from 'node:fs';
import { fixture } from './helpers.mjs';
import { maintain } from '../maintenance.mjs';
import { createPrivacy } from '../privacy.mjs';

test('数据保存期限实际清除处理后举报、过期验证与设备记录，待处理超期证据被移除',async t=>{
  const f=await fixture(t),{a,b,path,chat}=await f.pair(),message=await f.call(path,b.token,{text:'必要证据',clientMessageId:randomUUID()},201);
  const now=Date.now(),day=86400_000;
  f.sql(db=>{
    db.prepare("INSERT INTO reports(reporter_id,message_id,reason,created_at,status,handled_at,evidence_text,evidence_sender_id,evidence_conversation_id) VALUES(?,?,'旧处理记录',?,'resolved',?,'旧证据',?,?)")
      .run(a.user.id,message.messageId,now-200*day,now-181*day,b.user.id,chat);
    db.prepare("INSERT INTO reports(reporter_id,message_id,reason,created_at,evidence_text,evidence_sender_id,evidence_conversation_id) VALUES(?,?,'超期说明',?,'超期证据',?,?)")
      .run(a.user.id,message.messageId,now-366*day,b.user.id,chat);
    db.prepare('INSERT INTO account_notices(user_id,reason,created_at) VALUES(?,?,?)').run(a.user.id,'旧警告',now-181*day);
    db.prepare('INSERT INTO admin_audit(actor,action,reason,created_at) VALUES(?,?,?,?)').run('operator','warn','旧操作',now-366*day);
    db.prepare("INSERT INTO sessions(token,user_id,expires,session_id) VALUES('expired',?,?,?)").run(a.user.id,now-1,randomUUID());
    db.prepare("INSERT INTO email_challenges(id,user_id,email,purpose,code_hash,expires,created_at) VALUES('expired',?,'expired@example.com','bind','unused',?,?)").run(a.user.id,now-2*day,now-3*day);
    db.prepare('UPDATE users SET banned=1,banned_until=?,accepting=0 WHERE id=?').run(now-1,b.user.id);
    assert.deepEqual(maintain(db,now,true),[b.user.id]);
    const reports=db.prepare('SELECT * FROM reports').all();
    assert.equal(reports.length,1);assert.equal(reports[0].status,'dismissed');assert.equal(reports[0].evidence_text,'');assert.equal(reports[0].reason,'');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM sessions WHERE token='expired'").get().n,0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM email_challenges WHERE id='expired'").get().n,0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM account_notices').get().n,0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM admin_audit WHERE action='warn'").get().n,0);
    assert.equal(db.prepare('SELECT accepting FROM users WHERE id=?').get(b.user.id).accepting,0);
  });
});

test('注销日志35天轮换在Windows也完整落盘，保留有效恢复期限内的日志',async t=>{
  const f=await fixture(t),journal=f.dbPath+'.deletions.ndjson',now=Date.now();
  const entries=[{userId:100,identityDigest:'a'.repeat(64),at:now-36*86400_000},{userId:101,identityDigest:'b'.repeat(64),at:now-86400_000}];
  writeFileSync(journal,entries.map(entry=>JSON.stringify(entry)+'\n').join(''));
  f.sql(db=>createPrivacy(db,journal).compact());
  const retained=readFileSync(journal,'utf8').trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(retained.length,1);assert.equal(retained[0].userId,101);
});
