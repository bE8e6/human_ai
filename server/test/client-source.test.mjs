import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

async function source(name) {
  // Execute the real data-source classes, stripping only types and type imports.
  const text=readFileSync(new URL('../../entry/src/main/ets/common/'+name+'.ets',import.meta.url),'utf8').replace(/^import .*\r?\n/gm,'');
  const javascript=stripTypeScriptTypes(text,{mode:'strip'});
  return import('data:text/javascript;base64,'+Buffer.from(javascript).toString('base64'));
}
function listener(events) {
  return {onDataReloaded:()=>events.push(['reload']),onDataAdd:i=>events.push(['add',i]),onDataDelete:i=>events.push(['delete',i]),onDataChange:i=>events.push(['change',i])};
}
const row=(id,clientMessageId='',state='sent')=>({id,senderId:1,text:'消息'+id,createdAt:id,clientMessageId,state,error:'',order:id});

test('历史prepend使用插入通知保留锚点，ACK保持客户端key不重建或重复显示消息',async()=>{
  const {MessageSource}=await source('MessageSource'),data=new MessageSource(),events=[];
  data.registerDataChangeListener(listener(events));data.replace([row(51),row(52),row(0,'client-message-id','queued')]);events.length=0;
  data.replace([...Array.from({length:50},(_,i)=>row(i+1)),row(51),row(52),row(0,'client-message-id','queued')]);
  assert.equal(data.totalCount(),53);assert.equal(data.getData(50).id,51);
  assert.equal(events.filter(e=>e[0]==='reload').length,0);assert.equal(events.filter(e=>e[0]==='add').length,50);
  events.length=0;
  data.replace([...Array.from({length:52},(_,i)=>row(i+1)),{...row(53,'client-message-id','sent'),text:'消息0',createdAt:0}]);
  assert.equal(data.totalCount(),53);assert.equal(data.getData(52).state,'sent');
  assert.deepEqual(events,[['change',52]]);
});

test('会话置顶、移出及资料变更通知包含正确下标，懒加载源不残留其他账号项目',async()=>{
  const {ListSource}=await source('ListSource'),data=new ListSource(row=>String(row.id)),events=[];
  data.registerDataChangeListener(listener(events));data.replace([{id:1,name:'甲'},{id:2,name:'乙'}]);events.length=0;
  data.replace([{id:2,name:'新昵称'},{id:1,name:'甲'}]);
  assert.equal(data.getData(0).name,'新昵称');assert.deepEqual(events.slice(0,2),[['delete',1],['add',0]]);
  data.replace([{id:1,name:'甲'}]);assert.equal(data.totalCount(),1);assert.equal(data.getData(0).id,1);
  data.replace([]);assert.equal(data.totalCount(),0);
});
