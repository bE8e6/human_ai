import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../index.mjs';

export const PASSWORD='test_password_123';
export async function fixture(t,options={}) {
  const dir=mkdtempSync(join(tmpdir(),'human-ai-accounts-')),dbPath=join(dir,'chat.db');
  let current;
  async function start(path=dbPath,overrides={}) {
    current=createApp({...options,...overrides,dbPath:path});
    await new Promise(resolve=>current.listen(0,'127.0.0.1',resolve));
    return current;
  }
  await start();
  async function stop() { if(current?.listening) await new Promise(resolve=>current.close(resolve)); }
  t.after(async()=>{
    await stop();
    if(!resolve(dir).startsWith(resolve(tmpdir())+sep) || !basename(dir).startsWith('human-ai-')) throw new Error('Unsafe test cleanup path');
    rmSync(dir,{recursive:true,force:true});
  });
  const base=()=> 'http://127.0.0.1:'+current.address().port;
  async function call(path,token='',data,status=200,headers={}) {
    const response=await fetch(base()+path,{method:data===undefined?'GET':'POST',
      headers:{'Content-Type':'application/json',Authorization:'Bearer '+token,...headers},
      body:data===undefined?undefined:JSON.stringify(data)});
    const result=await response.json();
    assert.equal(response.status,status,JSON.stringify(result));
    return result;
  }
  function sql(work,path=dbPath) { const db=new DatabaseSync(path);try{return work(db);}finally{db.close();} }
  const register=name=>call('/auth/register','',{username:name,password:PASSWORD,deviceId:randomUUID(),deviceName:'测试设备',acceptPolicy:true,policyVersion:'2026-11-20'},201);
  async function pair() {
    const a=await register('alice'),b=await register('bob');
    await call('/me/accepting',b.token,{accepting:true});
    const chat=(await call('/conversations',a.token,{aiId:b.user.id})).conversationId;
    return {a,b,chat,path:'/conversations/'+chat+'/messages'};
  }
  return {dir,dbPath,base,call,register,pair,sql,start,stop,restart:async()=>{await stop();await start();}};
}
