import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep, basename } from 'node:path';
import { randomUUID, scryptSync } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../index.mjs';
import { SCHEMA_VERSION, tokenDigest } from '../database.mjs';

function removeTestDir(dir) {
  if (!resolve(dir).startsWith(resolve(tmpdir())+sep) || !basename(dir).startsWith('human-ai-')) throw new Error('Unsafe test cleanup path');
  rmSync(dir,{recursive:true,force:true});
}

async function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(),'human-ai-v2-'));
  const dbPath = options.dbPath || join(dir,'chat.db');
  const server = createApp({ ...options,dbPath });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(async () => {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    // Only remove the exact temporary directory created by this fixture.
    removeTestDir(dir);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(path, token = '', data, status = 200, headers = {}) {
    const res = await fetch(base+path,{method:data===undefined?'GET':'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`,...headers},body:data===undefined?undefined:JSON.stringify(data)});
    const body = await res.json();
    assert.equal(res.status,status,JSON.stringify(body));
    return body;
  }
  async function register(username) { return call('/auth/register','',{username,password:'test_password_123',deviceId:randomUUID(),deviceName:'测试设备',acceptPolicy:true,policyVersion:'2026-11-20'},201); }
  async function pair() {
    const a = await register('alice');
    const b = await register('bob');
    await call('/me/accepting',b.token,{accepting:true});
    const chat = (await call('/conversations',a.token,{aiId:b.user.id})).conversationId;
    return {a,b,chat,path:`/conversations/${chat}/messages`};
  }
  return {server,base,dbPath,call,register,pair};
}

test('丢失发送响应、并发重试、服务重启均只保存一次；编号冲突和越权不泄漏消息',async t => {
  const f = await fixture(t);
  const {a,b,chat,path} = await f.pair();
  const c = await f.register('carol');
  const payload = {text:'服务器已保存，但客户端没有收到响应',clientMessageId:randomUUID()};
  const first = await f.call(path,a.token,payload,201);
  const retries = await Promise.all(Array.from({length:40},()=>f.call(path,a.token,payload)));
  for (const retry of retries) {
    assert.equal(retry.messageId,first.messageId);
    assert.equal(retry.message.clientMessageId,payload.clientMessageId);
    assert.equal(retry.replayed,true);
  }
  assert.equal((await f.call(path,b.token)).messages.length,1);
  await f.call(path,a.token,{...payload,text:'同一个编号换成另一段文字'},409);
  await f.call(path,c.token,payload,404);
  const otherChat = (await f.call('/conversations',c.token,{aiId:b.user.id})).conversationId;
  await f.call(`/conversations/${otherChat}/messages`,b.token,{...payload,text:'不同发送者可以使用同一编号'},201);
  await f.call(path,b.token,{...payload,text:'不同发送者但重复使用编号到别的会话'},409);
  await f.call(path,a.token,{text:'缺少编号'},400);
  await new Promise(resolve=>f.server.close(resolve));
  const second = await fixture(t,{dbPath:f.dbPath});
  assert.equal((await second.call(path,a.token,payload)).messageId,first.messageId);
  assert.equal((await second.call(`/conversations/${chat}/messages`,b.token)).messages.length,1);
  await new Promise(resolve=>second.server.close(resolve));
});

test('V1无版本数据库原地升级，账号、原始令牌、消息、已读和举报均保留，令牌仅存摘要',async t => {
  const dir = mkdtempSync(join(tmpdir(),'human-ai-v1-'));
  const dbPath = join(dir,'chat.db');
  const old = new DatabaseSync(dbPath);
  old.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT UNIQUE NOT NULL,password TEXT NOT NULL,accepting INTEGER NOT NULL DEFAULT 0,banned INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE sessions(token TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),expires INTEGER NOT NULL);
    CREATE TABLE conversations(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),ai_id INTEGER NOT NULL REFERENCES users(id),user_read INTEGER NOT NULL DEFAULT 0,ai_read INTEGER NOT NULL DEFAULT 0,UNIQUE(user_id,ai_id),CHECK(user_id!=ai_id));
    CREATE TABLE messages(id INTEGER PRIMARY KEY,conversation_id INTEGER NOT NULL REFERENCES conversations(id),sender_id INTEGER NOT NULL REFERENCES users(id),text TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE blocks(user_id INTEGER NOT NULL REFERENCES users(id),target_id INTEGER NOT NULL REFERENCES users(id),PRIMARY KEY(user_id,target_id));
    CREATE TABLE reports(id INTEGER PRIMARY KEY,reporter_id INTEGER NOT NULL REFERENCES users(id),message_id INTEGER NOT NULL REFERENCES messages(id),reason TEXT NOT NULL,created_at INTEGER NOT NULL);`);
  const hash = `salt:${scryptSync('test_password_123','salt',64).toString('hex')}`;
  old.prepare('INSERT INTO users(id,username,password) VALUES(?,?,?)').run(1,'legacy_a',hash);
  old.prepare('INSERT INTO users(id,username,password) VALUES(?,?,?)').run(2,'legacy_b',hash);
  old.prepare('INSERT INTO sessions VALUES(?,?,?)').run('legacy-token',1,Date.now()+86400_000);
  old.exec("INSERT INTO conversations VALUES(1,1,2,1,0); INSERT INTO messages VALUES(1,1,2,'旧聊天原文',100); INSERT INTO reports VALUES(1,1,1,'旧举报原因',200)");
  old.close();
  const f = await fixture(t,{dbPath});
  assert.equal((await f.call('/me','legacy-token')).user.username,'legacy_a');
  assert.equal((await f.call('/conversations/1/messages','legacy-token')).messages[0].text,'旧聊天原文');
  const check = new DatabaseSync(dbPath);
  assert.equal(check.prepare('PRAGMA user_version').get().user_version,SCHEMA_VERSION);
  assert.equal(check.prepare('SELECT token FROM sessions').get().token,tokenDigest('legacy-token'));
  assert.equal(check.prepare('SELECT user_read FROM conversations').get().user_read,1);
  assert.equal(check.prepare('SELECT COUNT(*) n FROM reports').get().n,1);
  assert.equal(check.prepare('PRAGMA foreign_key_check').all().length,0);
  check.close();
  await f.call('/auth/login','',{username:'legacy_a',password:'test_password_123'});
  await new Promise(resolve=>f.server.close(resolve));
  const second = await fixture(t,{dbPath});
  assert.equal((await second.call('/me','legacy-token')).user.id,1);
  await new Promise(resolve=>second.server.close(resolve));
  t.after(()=>removeTestDir(dir));
});

test('多设备登录与选择性退出，密码修改撤销全部设备并给出稳定失效原因',async t => {
  const f = await fixture(t,{adminKey:'test-admin'});
  const a = await f.register('alice');
  const b = await f.call('/auth/login','',{username:'alice',password:'test_password_123',deviceName:'第二台设备'});
  const devices = (await f.call('/auth/devices',a.token)).devices;
  assert.equal(devices.length,2);
  assert.equal(devices.filter(d=>d.current).length,1);
  assert.equal(JSON.stringify(devices).includes(a.token),false);
  await f.call('/auth/devices/revoke',a.token,{sessionId:devices.find(d=>!d.current).id});
  assert.equal((await f.call('/me',b.token,undefined,401)).code,'DEVICE_REVOKED');
  await f.call('/me',a.token);
  const c = await f.call('/auth/login','',{username:'alice',password:'test_password_123'});
  await f.call('/auth/password',a.token,{currentPassword:'wrong_password',newPassword:'new_password_123'},400);
  await f.call('/auth/password',a.token,{currentPassword:'test_password_123',newPassword:'new_password_123'});
  for (const login of [a,c]) assert.equal((await f.call('/me',login.token,undefined,401)).code,'PASSWORD_CHANGED');
  await f.call('/auth/login','',{username:'alice',password:'test_password_123'},401);
  const next = await f.call('/auth/login','',{username:'alice',password:'new_password_123'});
  await f.call('/admin/ban','',{userId:a.user.id},200,{'X-Admin-Key':'test-admin'});
  assert.equal((await f.call('/me',next.token,undefined,401)).code,'ACCOUNT_BANNED');
});

test('最近消息首屏、向前历史、向后补齐、双身份未读、只隐藏自己列表与置顶',async t => {
  const f = await fixture(t);
  const {a,b,chat,path} = await f.pair();
  const seed = new DatabaseSync(f.dbPath);
  const insert = seed.prepare('INSERT INTO messages(conversation_id,sender_id,text,created_at) VALUES(?,?,?,?)');
  for (let i=0;i<235;i++) insert.run(chat,a.user.id,`历史消息${i}`,i);
  seed.close();
  const recent = await f.call(path,b.token);
  assert.equal(recent.messages.length,50);
  assert.equal(recent.messages[0].text,'历史消息185');
  assert.equal(recent.messages.at(-1).text,'历史消息234');
  assert.equal(recent.hasEarlier,true);
  assert.equal((await f.call('/me/unread',b.token)).unread.ai,235);
  const all = [...recent.messages];
  let before = recent.messages[0].id;
  let more = true;
  while (more) {
    const page = await f.call(`${path}?before=${before}&limit=100`,b.token);
    all.unshift(...page.messages);
    before = page.messages[0]?.id;
    more = page.hasEarlier;
  }
  assert.equal(all.length,235);
  assert.equal(new Set(all.map(m=>m.id)).size,235);
  assert.deepEqual(all.map(m=>m.id),[...all.map(m=>m.id)].sort((a,b)=>a-b));
  const reply = await f.call(path,b.token,{text:'断线期间新增',clientMessageId:randomUUID()},201);
  assert.equal((await f.call(`${path}?after=${recent.cursor}`,a.token)).messages[0].id,reply.messageId);
  await f.call(`/conversations/${chat}/read`,b.token,{messageId:recent.cursor});
  assert.equal((await f.call(path,a.token)).peerReadId,recent.cursor);
  await f.call(`/conversations/${chat}/settings`,a.token,{hidden:true,pinned:true,muted:true});
  assert.equal((await f.call('/conversations?role=user',a.token)).conversations.length,0);
  assert.equal((await f.call('/conversations?role=ai',b.token)).conversations.length,1);
  assert.equal((await f.call('/conversations?role=user&hidden=1',a.token)).conversations[0].pinned,true);
  await f.call(path,b.token,{text:'新消息使会话重新出现',clientMessageId:randomUUID()},201);
  const visible = (await f.call('/conversations?role=user',a.token)).conversations[0];
  assert.equal(visible.muted,true);
  assert.equal(visible.lastText,'新消息使会话重新出现');
});

test('大量会话和AI名录分页超过100条，关键词查找及无效游标校验',async t => {
  const f = await fixture(t);
  const a = await f.register('alice');
  const seed = new DatabaseSync(f.dbPath);
  const password = seed.prepare('SELECT password FROM users WHERE id=?').get(a.user.id).password;
  for (let i=0;i<145;i++) {
    const aiId = Number(seed.prepare('INSERT INTO users(username,password,accepting) VALUES(?,?,1)').run(`directory_${i}`,password).lastInsertRowid);
    seed.prepare('INSERT INTO conversations(user_id,ai_id) VALUES(?,?)').run(a.user.id,aiId);
  }
  seed.close();
  for (const [endpoint,field] of [['/conversations?role=user','conversations'],['/ais?','users']]) {
    const ids = [];
    let next = '';
    do {
      const page = await f.call(`${endpoint}&limit=40${next?`&cursor=${next}`:''}`,a.token);
      ids.push(...page[field].map(row=>row.id));
      next = page.nextCursor;
    } while (next);
    assert.equal(ids.length,145);
    assert.equal(new Set(ids).size,145);
  }
  assert.equal((await f.call('/conversations?role=user&q=directory_144',a.token)).conversations.length,1);
  await f.call('/conversations?role=user&cursor=invalid',a.token,undefined,400);
  await f.call('/ais?limit=0',a.token,undefined,400);
});
