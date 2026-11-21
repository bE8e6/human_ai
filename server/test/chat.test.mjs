import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../index.mjs';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

async function fixture(t, options = {}) {
  const server = createApp(options);
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(() => server.listening ? new Promise(resolve => server.close(resolve)) : undefined);
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(path, token = '', data, expected = 200, admin = '') {
    if (data && /^\/conversations\/\d+\/messages$/.test(path) && data.clientMessageId === undefined) data = { ...data, clientMessageId: randomUUID() };
    const response = await fetch(base + path, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Admin-Key': admin },
      body: data === undefined ? undefined : JSON.stringify(data)
    });
    const result = await response.json();
    assert.equal(response.status, expected, JSON.stringify(result));
    return result;
  }
  async function register(username) { return call('/auth/register','',{ username,password:'test_password_123',acceptPolicy:true,policyVersion:'2026-11-20' },201); }
  return { server, call, register };
}

test('双身份文字聊天、未读、隔离、拉黑、举报、禁用和退出', async t => {
  const { call, register } = await fixture(t,{ dbPath: ':memory:', adminKey:'test_admin' });
  const a = await register('alice');
  const b = await register('bob');
  const c = await register('carol');
  await call('/conversations',a.token,{ aiId:b.user.id },409);
  await call('/me/accepting',b.token,{ accepting:true });
  assert.equal((await call('/ais',a.token)).users[0].username,'bob');
  assert.equal((await call('/ais',b.token)).users.length,0);
  const chat = (await call('/conversations',a.token,{ aiId:b.user.id })).conversationId;
  assert.equal((await call('/conversations',a.token,{ aiId:b.user.id })).conversationId,chat);
  const path = `/conversations/${chat}/messages`;
  await call(path,c.token,undefined,404);
  await call(path,c.token,{ text:'越权发送' },404);
  await call(path,a.token,{ text:'   ' },400);
  await call(path,a.token,{ text:'a'.repeat(2001) },400);
  const sent = await call(path,a.token,{ text:'你好，真人 AI' },201);
  let list = await call('/conversations?role=ai',b.token);
  assert.equal(list.conversations[0].unread,1);
  assert.equal((await call('/conversations?role=user',b.token)).conversations.length,0);
  assert.equal((await call(path,b.token)).messages[0].text,'你好，真人 AI');
  await call(`/conversations/${chat}/read`,b.token,{ messageId:sent.messageId });
  assert.equal((await call('/conversations?role=ai',b.token)).conversations[0].unread,0);
  const reply = await call(path,b.token,{ text:'我是真人，很高兴认识你' },201);
  const increment = await call(path + '?after=' + sent.messageId,a.token);
  assert.equal(increment.messages.length,1);
  assert.equal(increment.messages[0].senderId,b.user.id);
  await call('/reports',c.token,{ messageId:reply.messageId,reason:'越权举报' },404);
  await call('/reports',a.token,{ messageId:sent.messageId,reason:'举报自己' },400);
  await call('/reports',a.token,{ messageId:reply.messageId,reason:'测试举报' },201);
  await call('/admin/reports','',undefined,403);
  assert.equal((await call('/admin/reports','',undefined,200,'test_admin')).reports[0].reason,'测试举报');
  await call('/blocks',a.token,{ userId:b.user.id,blocked:true });
  await call(path,b.token,{ text:'被拉黑后发送' },403);
  await call(path,a.token,{ text:'被拉黑后发送' },403);
  assert.equal((await call('/ais',a.token)).users.length,0);
  await call('/blocks',a.token,{ userId:b.user.id,blocked:false });
  await call('/me/accepting',b.token,{ accepting:false });
  await call(path,b.token,{ text:'关闭接聊仍能回复旧对话' },201);
  await call('/conversations',c.token,{ aiId:b.user.id },409);
  await call('/admin/ban','',{ userId:b.user.id },200,'test_admin');
  await call('/me',b.token,undefined,401);
  await call('/auth/login','',{ username:'bob',password:'test_password_123' },403);
  await call(path,a.token,{ text:'向禁用账号发送' },403);
  await call('/auth/logout',a.token,{});
  await call('/me',a.token,undefined,401);
});

test('重新打开 SQLite 后账号、消息和会话仍存在', async t => {
  const dir = mkdtempSync(join(tmpdir(),'human-ai-test-'));
  const options = { dbPath: join(dir,'chat.db') };
  const first = await fixture(t,options);
  const a = await first.register('persist_a');
  const b = await first.register('persist_b');
  await first.call('/me/accepting',b.token,{ accepting:true });
  const chat = (await first.call('/conversations',a.token,{ aiId:b.user.id })).conversationId;
  await first.call(`/conversations/${chat}/messages`,a.token,{ text:'重启后保留' },201);
  await new Promise(resolve => first.server.close(resolve));
  const second = await fixture(t,options);
  assert.equal((await second.call(`/conversations/${chat}/messages`,a.token)).messages[0].text,'重启后保留');
  await second.call('/auth/login','',{ username:'persist_a',password:'wrong_password' },401);
  const login = await second.call('/auth/login','',{ username:'persist_a',password:'test_password_123' });
  assert.equal(login.user.id,a.user.id);
});

test('发送限流和无效消息游标', async t => {
  const { call, register } = await fixture(t,{ dbPath: ':memory:' });
  const a = await register('rate_a');
  const b = await register('rate_b');
  await call('/me/accepting',b.token,{ accepting:true });
  const chat = (await call('/conversations',a.token,{ aiId:b.user.id })).conversationId;
  for (let i=0;i<30;i++) await call(`/conversations/${chat}/messages`,a.token,{ text:`消息 ${i}` },201);
  await call(`/conversations/${chat}/messages`,a.token,{ text:'超过限流' },429);
  assert.equal((await call(`/conversations/${chat}/messages`,b.token)).messages.length,30);
  await call(`/conversations/${chat}/messages?after=-1`,b.token,undefined,400);
});

test('超过100条的分页不会遗漏，已读游标不可跨对话', async t => {
  const dir = mkdtempSync(join(tmpdir(),'human-ai-pages-'));
  const dbPath = join(dir,'chat.db');
  const { call, register } = await fixture(t,{ dbPath });
  const a = await register('pages_a');
  const b = await register('pages_b');
  const c = await register('pages_c');
  await call('/me/accepting',b.token,{ accepting:true });
  const chat = (await call('/conversations',a.token,{ aiId:b.user.id })).conversationId;
  const otherChat = (await call('/conversations',c.token,{ aiId:b.user.id })).conversationId;
  // 构造长会话数据，不改变应用限流配置。
  const seed = new DatabaseSync(dbPath);
  const statement = seed.prepare('INSERT INTO messages(conversation_id,sender_id,text,created_at) VALUES(?,?,?,?)');
  for (let i=0;i<105;i++) statement.run(chat,a.user.id,`历史 ${i}`,Date.now());
  const foreign = Number(statement.run(otherChat,c.user.id,'另一段对话',Date.now()).lastInsertRowid);
  seed.close();
  const first = await call(`/conversations/${chat}/messages?after=0`,b.token);
  assert.equal(first.messages.length,100);
  assert.equal(first.hasMore,true);
  const second = await call(`/conversations/${chat}/messages?after=${first.messages[99].id}`,b.token);
  assert.equal(second.messages.length,5);
  assert.equal(second.hasMore,false);
  assert.equal(new Set(first.messages.concat(second.messages).map(m=>m.id)).size,105);
  await call(`/conversations/${chat}/read`,b.token,{ messageId:foreign },400);
  await call(`/conversations/${chat}/read`,b.token,{ messageId:second.messages[4].id });
  await call(`/conversations/${chat}/read`,b.token,{ messageId:first.messages[0].id });
  const list = await call('/conversations?role=ai',b.token);
  assert.equal(list.conversations.find(c=>c.id===chat).unread,0);
  assert.equal(list.conversations.find(c=>c.id===otherChat).unread,1);
});
