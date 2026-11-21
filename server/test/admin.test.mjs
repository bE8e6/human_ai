import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, PASSWORD } from './helpers.mjs';
import { hashPassword } from '../security.mjs';
import { tokenDigest } from '../database.mjs';

async function adminFixture(t,options={}) {
  const f=await fixture(t,{adminUsername:'operator',adminPasswordHash:await hashPassword('admin_password_123'),...options});
  const response=await fetch(f.base()+'/admin/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'operator',password:'admin_password_123'})});
  assert.equal(response.status,200);
  const identity=await response.json(),cookie=response.headers.get('set-cookie').split(';')[0];
  const call=(path,data,status=200,headers={})=>f.call('/admin/api/'+path,'',data,status,{Cookie:cookie,'X-CSRF-Token':identity.csrf,...headers});
  return {...f,admin:call,cookie,identity};
}

test('管理登录独立于普通账号，Cookie仅HTTP可读，CSRF与来源校验，退出及过期拒绝访问',async t=>{
  const f=await adminFixture(t,{allowedOrigin:'https://chat.example.com'}),user=await f.register('alice');
  await f.call('/admin/api/users',user.token,undefined,401);
  await f.call('/admin/reports','',undefined,403,{'X-Admin-Key':'unused-key'});
  const html=await fetch(f.base()+'/admin');
  assert.equal(html.status,200);assert.match(html.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  assert.match(await html.text(),/管理员登录/);
  const login=await fetch(f.base()+'/admin/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'operator',password:'admin_password_123'})});
  const cookie=login.headers.get('set-cookie');
  assert.match(cookie,/HttpOnly/);assert.match(cookie,/SameSite=Strict/);assert.match(cookie,/Secure/);
  const raw=f.cookie.split('=')[1];
  f.sql(db=>assert.equal(db.prepare('SELECT COUNT(*) n FROM admin_sessions WHERE token=?').get(tokenDigest(raw)).n,1));
  await f.admin('moderate',{userId:user.user.id,action:'warn',reason:'缺少CSRF'},403,{'X-CSRF-Token':''});
  await f.admin('moderate',{userId:user.user.id,action:'warn',reason:'跨站请求'},403,{Origin:'https://evil.example.com'});
  await f.admin('moderate',{userId:user.user.id,action:'warn',reason:'非JSON'},415,{'Content-Type':'text/plain'});
  await f.admin('logout',{});
  await f.admin('session',undefined,401);
  const session=await f.call('/admin/api/login','',{username:'operator',password:'admin_password_123'});
  assert.equal(typeof session.csrf,'string');
  f.sql(db=>db.prepare('UPDATE admin_sessions SET expires=?').run(Date.now()-1));
  const expired=await f.call('/admin/api/session','',undefined,401,{Cookie:cookie.split(';')[0]});
  assert.equal(expired.code,'ADMIN_SESSION_EXPIRED');
  await f.call('/admin/api/login','',{username:'alice',password:PASSWORD},401);
});

test('管理员警告、临时封禁、自动到期、永久封禁与解封保留原因并撤销旧登录',async t=>{
  const f=await adminFixture(t),a=await f.register('alice');
  await f.admin('moderate',{userId:a.user.id,action:'warn',reason:'请尊重对方'});
  assert.equal((await f.call('/me/notices',a.token)).notices[0].reason,'请尊重对方');
  await f.admin('moderate',{userId:a.user.id,action:'temporary_ban',durationHours:2,reason:'测试临时限制'});
  assert.equal((await f.call('/me',a.token,undefined,401)).code,'ACCOUNT_BANNED');
  await f.call('/auth/login','',{username:'alice',password:PASSWORD},403);
  const detail=(await f.admin('users/'+a.user.id)).user;
  assert.equal(detail.banReason,'测试临时限制');assert.ok(detail.bannedUntil>Date.now());
  f.sql(db=>db.prepare('UPDATE users SET banned_until=? WHERE id=?').run(Date.now()-1,a.user.id));
  const after=await f.call('/auth/login','',{username:'alice',password:PASSWORD});
  await f.call('/me',after.token);await f.call('/me',a.token,undefined,401);
  await f.admin('moderate',{userId:a.user.id,action:'permanent_ban',reason:'重复违规'});
  await f.call('/me',after.token,undefined,401);
  await f.admin('moderate',{userId:a.user.id,action:'unban',reason:'复核后解除'});
  const next=await f.call('/auth/login','',{username:'alice',password:PASSWORD});
  await f.call('/me',next.token);await f.call('/me',after.token,undefined,401);
  const logs=(await f.admin('audit')).logs;
  assert.deepEqual(logs.filter(log=>log.targetId===a.user.id).map(log=>log.action),['unban','permanent_ban','temporary_ban_expired','temporary_ban','warn']);
  assert.equal(logs[0].reason,'复核后解除');assert.equal(logs[0].actor,'operator');
  await f.admin('moderate',{userId:a.user.id,action:'temporary_ban',durationHours:0,reason:'无效'},400);
});

test('举报按状态分页，处理结果同步给举报者，证据只来自被举报消息且越权不可读取',async t=>{
  const f=await adminFixture(t),{a,b,chat,path}=await f.pair(),c=await f.register('carol');
  const message=await f.call(path,b.token,{text:'<img src=x onerror=alert(1)>必要消息证据',clientMessageId:randomUUID()},201);
  await f.call('/reports',c.token,{messageId:message.messageId,category:'privacy'},404);
  const report=await f.call('/reports',a.token,{messageId:message.messageId,category:'privacy',reason:'必要描述'},201);
  const inbox=(await f.admin('reports')).reports;
  assert.equal(inbox[0].evidenceText,message.message.text);assert.equal(inbox[0].targetId,b.user.id);
  await f.admin('moderate',{userId:a.user.id,reportId:report.reportId,action:'warn',reason:'错误目标'},400);
  await f.admin('moderate',{userId:b.user.id,reportId:report.reportId,action:'warn',reason:'管理员已提醒保护隐私'});
  assert.equal((await f.admin('reports?state=pending')).reports.length,0);
  const mine=(await f.call('/reports',a.token)).reports[0];
  assert.equal(mine.status,'resolved');assert.equal(mine.result,'管理员已提醒保护隐私');
  assert.equal((await f.call('/reports',c.token)).reports.length,0);
  await f.admin('reports/'+report.reportId+'/resolve',{status:'dismissed',result:'重复操作'},409);
  f.sql(db=>{
    const insert=db.prepare("INSERT INTO reports(reporter_id,message_id,reason,category,created_at,evidence_text,evidence_sender_id,evidence_conversation_id) VALUES(?,?,'分页证据','other',?,'证据',?,?)");
    for(let i=0;i<125;i++) insert.run(a.user.id,message.messageId,Date.now()+i,b.user.id,chat);
  });
  const seen=[];let cursor='';
  do {
    const result=await f.admin('reports?state=pending&limit=50'+(cursor?'&before='+cursor:''));
    seen.push(...result.reports.map(row=>row.id));cursor=result.nextCursor;
  } while(cursor);
  assert.equal(seen.length,125);assert.equal(new Set(seen).size,125);
  const pending=seen[0];await f.admin('reports/'+pending+'/resolve',{status:'dismissed',result:'证据不足'});
  assert.equal((await f.admin('reports?state=dismissed')).reports[0].result,'证据不足');
  const script=await fetch(f.base()+'/admin/assets/app.js');
  assert.equal(script.status,200);assert.equal((await script.text()).includes('innerHTML'),false);
});

test('用户搜索与超过100条的管理分页，普通用户无法获取管理员会话或私有证据',async t=>{
  const f=await adminFixture(t),a=await f.register('alice');
  f.sql(db=>{
    const password=db.prepare('SELECT password FROM users WHERE id=?').get(a.user.id).password;
    for(let i=0;i<145;i++) db.prepare('INSERT INTO users(username,password,nickname) VALUES(?,?,?)').run('member_'+i,password,'昵称'+i);
  });
  const ids=[];let cursor='';
  do {
    const page=await f.admin('users?limit=50'+(cursor?'&before='+cursor:''));
    ids.push(...page.users.map(user=>user.id));cursor=page.nextCursor;
  } while(cursor);
  assert.equal(ids.length,146);assert.equal(new Set(ids).size,146);
  assert.equal((await f.admin('users?q=member_144')).users.length,1);
  await f.call('/admin/api/reports',a.token,undefined,401);
  await f.call('/admin/api/session',a.token,undefined,401);
  const policy=await fetch(f.base()+'/privacy');assert.equal(policy.status,200);assert.match(await policy.text(),/180天/);
});
