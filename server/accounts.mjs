import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { hashPassword, verifyPassword } from './security.mjs';

export function createAccounts({db,fail,body,limit,authenticate,privateUser,onChanged,revoke,privacy,mailer,mailSecret}) {
  const mailAvailable = typeof mailer === 'function' && typeof mailSecret === 'string' && mailSecret.length >= 32;
  function emailAddress(value) {
    const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (email.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/.test(email)) {
      fail(400,'请输入有效的邮箱地址','INVALID_EMAIL');
    }
    return email;
  }
  function requireMail() { if (!mailAvailable) fail(503,'邮件服务尚未配置，请联系运营者','MAIL_NOT_CONFIGURED'); }
  function codeHash(id,code) { return createHmac('sha256',mailSecret).update(id+':'+code).digest('hex'); }
  function password(value) {
    if (typeof value !== 'string' || value.length < 8 || value.length > 128) fail(400,'密码需为8–128位','INVALID_PASSWORD');
    return value;
  }
  async function currentPassword(identity,data) {
    limit('reauth:'+identity.user.id,8);
    const current = password(data.currentPassword);
    if (!await verifyPassword(current,identity.user.password)) fail(400,'当前密码错误','INVALID_CURRENT_PASSWORD');
    return authenticate(identity.digest);
  }
  async function sendChallenge(email,userId,purpose) {
    const challengeId = randomBytes(24).toString('hex');
    const code = randomInt(0,1_000_000).toString().padStart(6,'0');
    const now = Date.now(), expiresAt = now+600_000;
    db.prepare('UPDATE email_challenges SET used_at=? WHERE email=? AND purpose=? AND used_at IS NULL').run(now,email,purpose);
    if (userId) db.prepare('UPDATE email_challenges SET used_at=? WHERE user_id=? AND purpose=? AND used_at IS NULL').run(now,userId,purpose);
    db.prepare('INSERT INTO email_challenges(id,user_id,email,purpose,code_hash,expires,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(challengeId,userId,email,purpose,userId?codeHash(challengeId,code):'',expiresAt,now);
    if (userId) {
      try {
        await mailer({to:email,subject:'人机？'+(purpose==='bind'?'邮箱验证':'密码找回')+'验证码',
          text:'你的验证码是：'+code+'。10分钟内有效，只能使用一次。请勿向他人提供验证码。如果不是本人操作，请忽略此邮件。'});
      } catch {
        db.prepare('UPDATE email_challenges SET used_at=? WHERE id=?').run(Date.now(),challengeId);
        fail(503,'邮件发送失败，请稍后重试','MAIL_DELIVERY_FAILED');
      }
    }
    return {ok:true,challengeId,expiresAt};
  }
  function checkChallenge(data,purpose,userId,ip) {
    requireMail();
    if (typeof data.challengeId !== 'string' || !/^[a-f0-9]{48}$/.test(data.challengeId) ||
        typeof data.code !== 'string' || !/^\d{6}$/.test(data.code)) fail(400,'请输入邮件中的6位验证码','INVALID_EMAIL_CODE');
    limit('code-ip:'+ip,30);
    const row = db.prepare('SELECT * FROM email_challenges WHERE id=?').get(data.challengeId);
    if (!row || row.purpose !== purpose || (userId && row.user_id !== userId)) fail(400,'验证码不正确或已失效','INVALID_EMAIL_CODE');
    if (row.used_at) fail(410,'验证码已使用，请重新获取','EMAIL_CODE_USED');
    if (row.expires <= Date.now()) fail(410,'验证码已过期，请重新获取','EMAIL_CODE_EXPIRED');
    if (row.attempts >= 5) fail(429,'验证码错误次数过多，请重新获取','EMAIL_CODE_LOCKED');
    db.prepare('UPDATE email_challenges SET attempts=attempts+1 WHERE id=?').run(row.id);
    if (!row.user_id || !row.code_hash || !timingSafeEqual(Buffer.from(row.code_hash,'hex'),Buffer.from(codeHash(row.id,data.code),'hex'))) {
      fail(400,'验证码不正确或已失效','INVALID_EMAIL_CODE');
    }
    return row;
  }
  function consume(row) {
    if (!db.prepare('UPDATE email_challenges SET used_at=? WHERE id=? AND used_at IS NULL AND expires>? AND attempts<=5')
      .run(Date.now(),row.id,Date.now()).changes) fail(410,'验证码已失效，请重新获取','EMAIL_CODE_USED');
  }
  function atomic(work) {
    db.exec('BEGIN IMMEDIATE');
    try { const value=work(); db.exec('COMMIT'); return value; }
    catch(error) { db.exec('ROLLBACK'); throw error; }
  }
  async function publicRoute(req,path,ip,send) {
    if (path === '/service/config' && req.method === 'GET') {
      send({mailAvailable,pushAvailable:false,privacyUrl:'/privacy',rulesUrl:'/rules'}); return true;
    }
    if (path === '/auth/recovery/request' && req.method === 'POST') {
      requireMail();
      limit('recovery-ip:'+ip,10,3600_000);
      const data=await body(req), email=emailAddress(data.email);
      limit('mail:'+email,3,3600_000);
      const user=db.prepare('SELECT id FROM users WHERE email=? AND email_verified=1 AND deleted_at IS NULL').get(email);
      const result=await sendChallenge(email,user?.id || null,'reset');
      send({...result,messageText:'若该邮箱已绑定并验证，将收到密码找回邮件。'}); return true;
    }
    if (path === '/auth/recovery/reset' && req.method === 'POST') {
      limit('reset-ip:'+ip,15);
      const data=await body(req), next=password(data.newPassword);
      const challenge=checkChallenge(data,'reset',null,ip);
      const hash=await hashPassword(next);
      const user=db.prepare('SELECT * FROM users WHERE id=?').get(challenge.user_id);
      if (!user || user.deleted_at || (user.banned && (!user.banned_until || user.banned_until>Date.now()))) fail(403,'账号当前不可用，请联系管理员','ACCOUNT_BANNED');
      atomic(() => {
        consume(challenge);
        db.prepare('UPDATE users SET password=? WHERE id=?').run(hash,user.id);
        db.prepare("UPDATE sessions SET revoked_reason='PASSWORD_RESET' WHERE user_id=?").run(user.id);
        db.prepare("UPDATE email_challenges SET used_at=? WHERE user_id=? AND purpose='reset' AND used_at IS NULL").run(Date.now(),user.id);
      });
      revoke(); onChanged(user.id);
      send({ok:true,messageText:'密码已重置，旧登录凭据已撤销，请重新登录。'}); return true;
    }
    return false;
  }
  async function privateRoute(req,path,ip,identity,send) {
    const {user}=identity;
    if (path === '/me/profile' && req.method === 'POST') {
      const data=await body(req);
      const fields=[['nickname',30],['bio',300],['aiStyle',120],['aiTopics',200]];
      for (const [field,max] of fields) if (typeof data[field] !== 'string' || data[field].trim().length>max) fail(400,field+'内容无效或过长');
      if (!data.nickname.trim()) fail(400,'昵称不能为空');
      db.prepare('UPDATE users SET nickname=?,bio=?,ai_style=?,ai_topics=? WHERE id=?')
        .run(data.nickname.trim(),data.bio.trim(),data.aiStyle.trim(),data.aiTopics.trim(),user.id);
      onChanged(user.id); send({user:privateUser(db.prepare('SELECT * FROM users WHERE id=?').get(user.id))}); return true;
    }
    if (path === '/me/availability' && req.method === 'POST') {
      const data=await body(req);
      if (typeof data.accepting !== 'boolean' || typeof data.busy !== 'boolean' ||
          !Number.isSafeInteger(data.maxChats) || data.maxChats<1 || data.maxChats>100) fail(400,'接聊上限需为1–100，状态需为开关');
      db.prepare('UPDATE users SET accepting=?,busy=?,max_chats=? WHERE id=?').run(data.accepting?1:0,data.busy?1:0,data.maxChats,user.id);
      onChanged(user.id); send({user:privateUser(db.prepare('SELECT * FROM users WHERE id=?').get(user.id))}); return true;
    }
    if (path === '/me/preferences' && req.method === 'POST') {
      const data=await body(req);
      if (typeof data.notificationEnabled !== 'boolean' || typeof data.notificationPreview !== 'boolean') fail(400,'无效通知设置');
      db.prepare('UPDATE users SET notification_enabled=?,notification_preview=? WHERE id=?')
        .run(data.notificationEnabled?1:0,data.notificationPreview?1:0,user.id);
      onChanged(user.id); send({user:privateUser(db.prepare('SELECT * FROM users WHERE id=?').get(user.id))}); return true;
    }
    if (path === '/me/email/request' && req.method === 'POST') {
      requireMail(); limit('bind:'+user.id,5,3600_000); limit('mail-ip:'+ip,10,3600_000);
      const data=await body(req), email=emailAddress(data.email);
      await currentPassword(identity,data);
      limit('mail:'+email,3,3600_000);
      const owner=db.prepare('SELECT id FROM users WHERE email=? AND id!=?').get(email,user.id);
      if (owner) fail(409,'该邮箱已绑定其他账号','EMAIL_IN_USE');
      const result=await sendChallenge(email,user.id,'bind');
      try { authenticate(identity.digest); }
      catch(error) { db.prepare('UPDATE email_challenges SET used_at=? WHERE id=?').run(Date.now(),result.challengeId); throw error; }
      send(result); return true;
    }
    if (path === '/me/email/verify' && req.method === 'POST') {
      const data=await body(req), challenge=checkChallenge(data,'bind',user.id,ip);
      if (db.prepare('SELECT id FROM users WHERE email=? AND id!=?').get(challenge.email,user.id)) fail(409,'该邮箱已绑定其他账号','EMAIL_IN_USE');
      atomic(() => {
        consume(challenge);
        db.prepare('UPDATE users SET email=?,email_verified=1 WHERE id=?').run(challenge.email,user.id);
      });
      onChanged(user.id); send({user:privateUser(db.prepare('SELECT * FROM users WHERE id=?').get(user.id))}); return true;
    }
    if (path === '/me/email/unbind' && req.method === 'POST') {
      const data=await body(req); await currentPassword(identity,data);
      db.prepare('UPDATE users SET email=NULL,email_verified=0 WHERE id=?').run(user.id);
      db.prepare('UPDATE email_challenges SET used_at=? WHERE user_id=? AND used_at IS NULL').run(Date.now(),user.id);
      onChanged(user.id); send({ok:true}); return true;
    }
    if (path === '/me/notices' && req.method === 'GET') {
      send({notices:db.prepare('SELECT id,reason,created_at createdAt,read_at readAt FROM account_notices WHERE user_id=? ORDER BY id DESC LIMIT 50').all(user.id)});
      return true;
    }
    if (path === '/me/delete' && req.method === 'POST') {
      limit('delete:'+user.id,3,3600_000);
      const data=await body(req);
      if (data.confirm !== '注销账号') fail(400,'请确认注销账号');
      await currentPassword(identity,data);
      const chats=db.prepare('SELECT id,user_id,ai_id FROM conversations WHERE user_id=? OR ai_id=?').all(user.id,user.id);
      privacy.remove(user);
      revoke(); onChanged(user.id);
      for (const chat of chats) onChanged(chat.user_id===user.id?chat.ai_id:chat.user_id,{type:'history_changed',conversationId:chat.id});
      send({ok:true,messageText:'账号已注销，本人消息正文与资料已移除。举报证据及备份按隐私政策的期限处理。'}); return true;
    }
    return false;
  }
  return {publicRoute,privateRoute,mailAvailable};
}
