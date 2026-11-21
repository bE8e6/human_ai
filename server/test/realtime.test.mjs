import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { createApp } from '../index.mjs';

async function fixture(t,options={}) {
  const server = createApp({dbPath:':memory:',adminKey:'test-admin',...options});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(path,token='',data,status=200,admin='') {
    const res = await fetch(base+path,{method:data===undefined?'GET':'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`,'X-Admin-Key':admin},body:data===undefined?undefined:JSON.stringify(data)});
    const value = await res.json(); assert.equal(res.status,status,JSON.stringify(value)); return value;
  }
  const register = username=>call('/auth/register','',{username,password:'test_password_123',acceptPolicy:true,policyVersion:'2026-11-20'},201);
  return {server,base,call,register};
}
async function open(f,token,options={}) {
  const ws = new WebSocket(f.base.replace(/^http/,'ws')+'/realtime',{headers:{Authorization:`Bearer ${token}`},...options});
  const history = [];
  const waiters = [];
  ws.on('error',()=>{});
  ws.on('message',data=> {
    const event = JSON.parse(data.toString()); history.push(event);
    for (const waiter of [...waiters]) if (waiter.filter(event)) waiter.resolve(event);
  });
  await new Promise((resolve,reject)=> { ws.once('open',resolve); ws.once('error',reject); });
  function until(filter) {
    const found = history.find(filter); if (found) return Promise.resolve(found);
    return new Promise((resolve,reject)=> {
      const timer = setTimeout(()=> { waiters.splice(waiters.indexOf(waiter),1); reject(new Error('Realtime event timed out')); },2000);
      const waiter = {filter,resolve:event=> { clearTimeout(timer); waiters.splice(waiters.indexOf(waiter),1); resolve(event); }};
      waiters.push(waiter);
    });
  }
  function closed() {
    if (ws.readyState===WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolve,reject)=> {
      const timer=setTimeout(()=>reject(new Error('Socket did not close')),2000);
      ws.once('close',()=> { clearTimeout(timer); resolve(); });
    });
  }
  return {ws,history,until,closed};
}

test('实时消息和已读同步到多设备，非参与者不收到会话事件，断线后按游标补齐',async t=> {
  const f = await fixture(t);
  const a = await f.register('alice'), b = await f.register('bob'), c = await f.register('carol');
  const b2 = await f.call('/auth/login','',{username:'bob',password:'test_password_123'});
  await f.call('/me/accepting',b.token,{accepting:true});
  const chat = (await f.call('/conversations',a.token,{aiId:b.user.id})).conversationId;
  const path = `/conversations/${chat}/messages`;
  const alice = await open(f,a.token), bob = await open(f,b.token), otherDevice = await open(f,b2.token), outsider = await open(f,c.token);
  const payload = {text:'实时消息',clientMessageId:randomUUID()};
  const sent = await f.call(path,a.token,payload,201);
  for (const socket of [alice,bob,otherDevice]) await socket.until(e=>e.type==='message'&&e.messageId===sent.messageId);
  await f.call(path,a.token,payload);
  assert.equal(bob.history.filter(e=>e.type==='message'&&e.messageId===sent.messageId).length,1);
  assert.equal(outsider.history.some(e=>e.conversationId===chat),false);
  await f.call(`/conversations/${chat}/read`,b2.token,{messageId:sent.messageId});
  await alice.until(e=>e.type==='read'&&e.messageId===sent.messageId);
  await bob.until(e=>e.type==='read'&&e.messageId===sent.messageId);
  assert.equal((await f.call('/me/unread',b.token)).unread.ai,0);
  bob.ws.close(); await bob.closed();
  const ids = [];
  for (let i=0;i<4;i++) ids.push((await f.call(path,a.token,{text:`断线消息${i}`,clientMessageId:randomUUID()},201)).messageId);
  const reconnected = await open(f,b.token);
  await reconnected.until(e=>e.type==='ready');
  assert.deepEqual((await f.call(`${path}?after=${sent.messageId}`,b.token)).messages.map(m=>m.id),ids);
  outsider.ws.send(JSON.stringify({type:'view',conversationId:chat}));
  await outsider.closed();
});

test('开放接聊与在线状态独立，失联心跳超时会退出在线，正常心跳不掉线',async t=> {
  const f = await fixture(t,{heartbeatMs:25,timeoutMs:100});
  const a = await f.register('alice'), b = await f.register('bob');
  await f.call('/me/accepting',b.token,{accepting:true});
  assert.equal((await f.call('/ais',a.token)).users[0].online,false);
  const dead = await open(f,b.token,{autoPong:false});
  assert.equal((await f.call('/ais',a.token)).users[0].online,true);
  await dead.closed();
  assert.equal((await f.call('/ais',a.token)).users[0].online,false);
  assert.equal((await f.call('/ais',a.token)).users[0].accepting,true);
  const healthy = await open(f,b.token);
  await new Promise(resolve=>setTimeout(resolve,200));
  assert.equal(healthy.ws.readyState,WebSocket.OPEN);
});

test('退出其他设备和封禁立即关闭实时连接，普通用户无管理员权限，停服释放升级连接',async t=> {
  const f = await fixture(t);
  const a = await f.register('alice');
  const second = await f.call('/auth/login','',{username:'alice',password:'test_password_123'});
  const current = await open(f,a.token), other = await open(f,second.token);
  await f.call('/auth/devices/revoke',a.token,{otherDevices:true});
  await other.closed();
  assert.equal(current.ws.readyState,WebSocket.OPEN);
  await f.call('/admin/ban',a.token,{userId:a.user.id},403);
  await f.call('/admin/ban','',{userId:a.user.id},200,'test-admin');
  await current.closed();
  assert.equal((await f.call('/me',a.token,undefined,401)).code,'ACCOUNT_BANNED');
  const b = await f.register('bob');
  const socket = await open(f,b.token);
  await new Promise(resolve=>f.server.close(resolve));
  await socket.closed();
});
