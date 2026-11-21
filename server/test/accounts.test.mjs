import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fixture, PASSWORD } from './helpers.mjs';
import { clientIp } from '../security.mjs';
import { tokenDigest } from '../database.mjs';
import { REMOVED_MESSAGE } from '../privacy.mjs';

const MAIL_SECRET='test-only-mail-secret-with-at-least-32-characters';
function mailOptions() {
  const mails=[];
  return {mails,options:{mailSecret:MAIL_SECRET,mailer:async mail=>mails.push(mail)},
    code:()=>mails.at(-1).text.match(/\d{6}/)[0]};
}

test('邮件未配置有明确反馈；资料、通知与接聊设置只向本人返回私有字段',async t=>{
  const f=await fixture(t),{a,b}=await f.pair();
  await f.call('/auth/register','',{username:'missing_policy',password:PASSWORD},400);
  assert.equal((await f.call('/service/config')).mailAvailable,false);
  await f.call('/auth/recovery/request','',{email:'alice@example.com'},503);
  await f.call('/me/email/request',a.token,{email:'alice@example.com',currentPassword:PASSWORD},503);
  await f.call('/me/profile',b.token,{nickname:'温柔的同行者',bio:'慢慢聊',aiStyle:'耐心倾听',aiTopics:'阅读、生活'});
  await f.call('/me/preferences',b.token,{notificationEnabled:false,notificationPreview:false});
  const self=(await f.call('/me',b.token)).user;
  assert.equal(self.nickname,'温柔的同行者');assert.equal(self.notificationEnabled,false);
  const list=(await f.call('/ais?q=阅读',a.token)).users;
  assert.equal(list[0].nickname,'温柔的同行者');
  assert.equal('email' in list[0],false);assert.equal('notificationPreview' in list[0],false);assert.equal('password' in self,false);
  await f.call('/me/profile',b.token,{nickname:'',bio:'',aiStyle:'',aiTopics:''},400);
  await f.call('/me/availability',b.token,{accepting:true,busy:false,maxChats:0},400);
});

test('绑定邮箱、验证与找回支持一次性验证码，重置撤销全部设备，响应不透露邮箱账号',async t=>{
  const mail=mailOptions(),f=await fixture(t,mail.options),a=await f.register('alice'),b=await f.register('bob');
  const other=await f.call('/auth/login','',{username:'alice',password:PASSWORD});
  await f.call('/me/email/request',a.token,{email:'alice@example.com',currentPassword:'wrong_password'},400);
  const challenge=await f.call('/me/email/request',a.token,{email:'Alice@Example.com',currentPassword:PASSWORD});
  const code=mail.code();
  await f.call('/me/email/verify',b.token,{challengeId:challenge.challengeId,code},400);
  await f.call('/me/email/verify',a.token,{challengeId:challenge.challengeId,code:'xxxxxx'},400);
  const verified=await f.call('/me/email/verify',a.token,{challengeId:challenge.challengeId,code});
  assert.equal(verified.user.email,'alice@example.com');assert.equal(verified.user.emailVerified,true);
  await f.call('/me/email/verify',a.token,{challengeId:challenge.challengeId,code},410);
  await f.call('/me/email/request',b.token,{email:'alice@example.com',currentPassword:PASSWORD},409);
  const unknown=await f.call('/auth/recovery/request','',{email:'unknown@example.com'});
  const known=await f.call('/auth/recovery/request','',{email:'alice@example.com'});
  assert.equal(unknown.messageText,known.messageText);assert.equal('userId' in known,false);
  assert.equal(mail.mails.length,2);
  const resetCode=mail.code(),payload={challengeId:known.challengeId,code:resetCode,newPassword:'new_password_456'};
  await f.call('/auth/recovery/reset','',payload);
  for(const account of [a,other]) assert.equal((await f.call('/me',account.token,undefined,401)).code,'PASSWORD_RESET');
  await f.call('/auth/recovery/reset','',payload,410);
  await f.call('/auth/login','',{username:'alice',password:PASSWORD},401);
  const login=await f.call('/auth/login','',{username:'alice',password:'new_password_456'});
  await f.call('/me/email/unbind',login.token,{currentPassword:'new_password_456'});
  assert.equal((await f.call('/me',login.token)).user.emailVerified,false);
});

test('邮箱有效期、五次尝试和发信限流在重启后仍然有效，库中只存验证码HMAC',async t=>{
  const mail=mailOptions(),f=await fixture(t,mail.options),a=await f.register('alice');
  const first=await f.call('/me/email/request',a.token,{email:'alice@example.com',currentPassword:PASSWORD});
  const firstCode=mail.code();
  f.sql(db=>db.prepare('UPDATE email_challenges SET expires=? WHERE id=?').run(Date.now()-1,first.challengeId));
  assert.equal((await f.call('/me/email/verify',a.token,{challengeId:first.challengeId,code:firstCode},410)).code,'EMAIL_CODE_EXPIRED');
  const next=await f.call('/me/email/request',a.token,{email:'alice@example.com',currentPassword:PASSWORD}),actual=mail.code();
  const wrong=actual==='000000'?'111111':'000000';
  for(let i=0;i<5;i++) await f.call('/me/email/verify',a.token,{challengeId:next.challengeId,code:wrong},400);
  await f.restart();
  assert.equal((await f.call('/me/email/verify',a.token,{challengeId:next.challengeId,code:actual},429)).code,'EMAIL_CODE_LOCKED');
  f.sql(db=>{
    const row=db.prepare('SELECT code_hash,attempts FROM email_challenges WHERE id=?').get(next.challengeId);
    assert.equal(row.attempts,5);assert.match(row.code_hash,/^[a-f0-9]{64}$/);assert.notEqual(row.code_hash,tokenDigest(actual));
  });
  for(let i=0;i<3;i++) await f.call('/auth/recovery/request','',{email:'unknown@example.com'});
  await f.restart();
  await f.call('/auth/recovery/request','',{email:'unknown@example.com'},429);
});

test('忙碌和接聊上限只限制新对话，暂停后旧对话能回复，隐藏AI列表项释放接聊名额',async t=>{
  const f=await fixture(t),{a,b,chat,path}=await f.pair(),c=await f.register('carol');
  await f.call('/me/availability',b.token,{accepting:true,busy:false,maxChats:1});
  assert.equal((await f.call('/conversations',c.token,{aiId:b.user.id},409)).code,'AI_CAPACITY');
  await f.call('/me/availability',b.token,{accepting:false,busy:true,maxChats:1});
  assert.equal((await f.call('/conversations',a.token,{aiId:b.user.id})).conversationId,chat);
  await f.call(path,a.token,{text:'暂停期间旧对话仍可聊天',clientMessageId:randomUUID()},201);
  await f.call(path,b.token,{text:'仍能回复',clientMessageId:randomUUID()},201);
  await f.call('/conversations',c.token,{aiId:b.user.id},409);
  await f.call('/conversations/'+chat+'/settings',b.token,{hidden:true});
  await f.call('/me/availability',b.token,{accepting:true,busy:false,maxChats:1});
  await f.call('/conversations',c.token,{aiId:b.user.id});
  const directory=await f.call('/ais?sort=available&limit=1',a.token);
  assert.equal(directory.users[0].available,false);
  await f.call('/ais?sort=unknown',a.token,undefined,400);
});

test('AI按昵称分页和介绍搜索，稳定用户名保持不变，多设备读取相同设置',async t=>{
  const f=await fixture(t),a=await f.register('alice'),b=await f.register('bob'),c=await f.register('carol');
  for(const [account,nickname] of [[b,'Zed'],[c,'Amy']]) {
    await f.call('/me/profile',account.token,{nickname,bio:'',aiStyle:'轻松',aiTopics:'共同话题'});
    await f.call('/me/accepting',account.token,{accepting:true});
  }
  const first=await f.call('/ais?sort=name&limit=1&q=共同',a.token);
  assert.equal(first.users[0].id,c.user.id);assert.equal(first.hasMore,true);
  const second=await f.call('/ais?sort=name&limit=1&q=共同&cursor='+first.nextCursor,a.token);
  assert.equal(second.users[0].id,b.user.id);assert.equal(second.hasMore,false);
  const device=await f.call('/auth/login','',{username:'bob',password:PASSWORD});
  assert.equal(device.user.username,'bob');assert.equal(device.user.nickname,'Zed');
  await f.call('/me/preferences',b.token,{notificationEnabled:false,notificationPreview:false});
  assert.equal((await f.call('/me',device.token)).user.notificationPreview,false);
});

test('仅受信代理的转发IP用于限流，攻击者不能通过伪造XFF绕过来源识别',()=>{
  const request=(remote,forwarded)=>({socket:{remoteAddress:remote},headers:{'x-forwarded-for':forwarded}});
  assert.equal(clientIp(request('::ffff:127.0.0.1','203.0.113.7'),[]),'127.0.0.1');
  assert.equal(clientIp(request('127.0.0.1','203.0.113.7'),['127.0.0.1']),'203.0.113.7');
  assert.equal(clientIp(request('127.0.0.1','203.0.113.7, 10.0.0.2'),['127.0.0.1','10.0.0.2']),'203.0.113.7');
  assert.equal(clientIp(request('127.0.0.1','198.51.100.3, 203.0.113.7'),['127.0.0.1']),'203.0.113.7');
  assert.equal(clientIp(request('127.0.0.1','invalid-ip'),['127.0.0.1']),'127.0.0.1');
});

test('注销移除资料和本人正文，举报保留必要证据；恢复旧备份重放注销日志且不会复活账号',async t=>{
  const f=await fixture(t,{adminKey:'test-admin'}),{a,b,chat,path}=await f.pair();
  await f.call('/me/profile',b.token,{nickname:'待注销昵称',bio:'待注销简介',aiStyle:'风格',aiTopics:'话题'});
  const evidence=await f.call(path,b.token,{text:'举报需保留的必要证据',clientMessageId:randomUUID()},201);
  await f.call(path,a.token,{text:'对方自己保留的消息',clientMessageId:randomUUID()},201);
  const report=await f.call('/reports',a.token,{messageId:evidence.messageId,category:'harassment',reason:'补充原因'},201);
  const duplicate=await f.call('/reports',a.token,{messageId:evidence.messageId,category:'other',reason:'重复内容'});
  assert.equal(duplicate.reportId,report.reportId);
  await f.call('/blocks',a.token,{userId:b.user.id,blocked:true});
  const backupPath=join(f.dir,'before-deletion.db');
  f.sql(db=>db.prepare('VACUUM INTO ?').run(backupPath));
  await f.call('/me/delete',b.token,{currentPassword:'wrong_password',confirm:'注销账号'},400);
  await f.call('/me/delete',b.token,{currentPassword:PASSWORD,confirm:'注销账号'});
  assert.equal((await f.call('/me',b.token,undefined,401)).code,'ACCOUNT_DELETED');
  await f.call('/auth/login','',{username:'bob',password:PASSWORD},401);
  const messages=(await f.call(path,a.token)).messages;
  const changed=await f.call(path+'?after='+messages.at(-1).id,a.token);
  assert.equal(changed.historyVersion,1);assert.equal(changed.messages.length,0);
  assert.equal(messages[0].text,REMOVED_MESSAGE);assert.equal(messages[1].text,'对方自己保留的消息');
  assert.equal((await f.call('/conversations/'+chat,a.token)).conversation.peerName,'已注销用户');
  assert.equal((await f.call('/blocks',a.token)).users.length,0);
  const reports=await f.call('/admin/reports','',undefined,200,{'X-Admin-Key':'test-admin'});
  assert.equal(reports.reports[0].text,'举报需保留的必要证据');
  const journal=f.dbPath+'.deletions.ndjson';assert.equal(existsSync(journal),true);
  const journalText=readFileSync(journal,'utf8');assert.equal(journalText.includes('bob'),false);assert.equal(journalText.includes('必要证据'),false);
  await f.stop();await f.start(backupPath,{deletionLogPath:journal});
  assert.equal((await f.call('/me',b.token,undefined,401)).code,'ACCOUNT_DELETED');
  assert.equal((await f.call(path,a.token)).messages[0].text,REMOVED_MESSAGE);
  f.sql(db=>{
    const user=db.prepare('SELECT * FROM users WHERE id=?').get(b.user.id);
    assert.equal(user.email,null);assert.equal(user.bio,'');assert.equal(user.password,'');assert.notEqual(user.username,'bob');
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);
  },backupPath);
});
