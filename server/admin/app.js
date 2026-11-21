const $=id=>document.getElementById(id);
const categories={harassment:'骚扰',hate:'辱骂与仇恨',sexual:'色情与不当内容',scam:'诈骗',privacy:'侵犯隐私',other:'其他'};
const statuses={pending:'待处理',resolved:'已处理',dismissed:'不予处理'};
const actions={warn:'警告',temporary_ban:'临时封禁',temporary_ban_expired:'临时封禁到期',permanent_ban:'永久封禁',unban:'解封',login:'登录',logout:'退出',report_resolved:'处理举报',report_dismissed:'不予处理'};
let csrf='',epoch=0,view=0,tab='reports',cursor='',history=[],rows=[],hasMore=false,selected=0,working=false;
function node(tag,text='',className='') { const el=document.createElement(tag); el.textContent=text; if(className) el.className=className; return el; }
function date(value) { return value?new Date(value).toLocaleString('zh-CN'):'—'; }
function tombstone(value) { try { if(value===undefined) return sessionStorage.getItem('human-ai.admin.signed-out')==='1'; sessionStorage.setItem('human-ai.admin.signed-out',value?'1':'0'); } catch {} return false; }
function rememberSession(value) {try {if(value===undefined)return sessionStorage.getItem('human-ai.admin.had-session')==='1';sessionStorage.setItem('human-ai.admin.had-session',value?'1':'0');}catch{}return false;}
function message(text,error=false) { $('message').textContent=text; $('message').hidden=!text; $('message').className='message'+(error?' error-message':''); }
function clearConsole(reason='') {
  epoch++; view++; csrf=''; rows=[]; selected=0; cursor=''; history=[]; hasMore=false;rememberSession(false);
  $('records').replaceChildren(); $('detail').replaceChildren(); $('operator').textContent='';
  $('user-count').textContent='—'; $('report-count').textContent='—'; $('banned-count').textContent='—';
  $('console').hidden=true; $('login').hidden=false; $('admin-password').value=''; $('login-error').textContent=reason;
}
async function api(path,data) {
  const ticket=epoch,controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
  try {
    const response=await fetch('/admin/api/'+path,{credentials:'same-origin',cache:'no-store',signal:controller.signal,
      method:data===undefined?'GET':'POST',headers:data===undefined?{}:{'Content-Type':'application/json','X-CSRF-Token':csrf},
      body:data===undefined?undefined:JSON.stringify(data)});
    const result=await response.json();
    if(ticket!==epoch) throw new Error('操作已取消');
    if(!response.ok) {
      if(response.status===401 && path!=='login') clearConsole(result.error || '会话已过期，请重新登录');
      const error=new Error(result.error || '请求失败，请重试');error.status=response.status;throw error;
    }
    return result;
  } catch(error) {
    if(error.name==='AbortError' || error instanceof TypeError) throw new Error('无法连接服务器，请检查网络后重试');
    throw error;
  } finally { clearTimeout(timer); }
}
function enter(identity) {
  epoch++; csrf=identity.csrf; tombstone(false);rememberSession(true); $('operator').textContent=identity.username+' · 管理员';
  $('login').hidden=true; $('console').hidden=false; $('admin-password').value=''; message(''); switchTab('reports');
}
function options(select,items,value) {
  select.replaceChildren(...items.map(([key,label])=>{const option=node('option',label);option.value=key;return option;}));
  select.value=value;
}
function switchTab(next) {
  if(working) return;
  tab=next; cursor=''; history=[]; rows=[]; selected=0; $('search').value='';
  document.querySelectorAll('[data-tab]').forEach(el=>el.classList.toggle('active',el.dataset.tab===tab));
  const titles={reports:['举报处理','查看必要证据，记录每次处理的原因。'],users:['用户与账号','查找用户，查看账号状态与登录设备。'],audit:['操作日志','查看管理员处理时间、动作和原因。']};
  $('page-title').textContent=titles[tab][0]; $('page-description').textContent=titles[tab][1];
  $('search').hidden=tab!=='users'; $('filters').hidden=tab==='audit';
  options($('state'),tab==='users'?[['all','全部账号'],['active','正常账号'],['disabled','禁用账号'],['deleted','已注销账号']]:
    [['pending','待处理'],['resolved','已处理'],['dismissed','不予处理'],['all','全部举报']],tab==='users'?'all':'pending');
  $('detail').replaceChildren(node('div','选择一条记录查看详情与操作','empty'));
  loadPage();
}
async function summary() {
  const ticket=epoch,result=await api('summary');
  if(ticket!==epoch) return;
  $('user-count').textContent=result.users; $('report-count').textContent=result.pending; $('pending-count').textContent=result.pending; $('banned-count').textContent=result.banned;
}
async function loadPage() {
  const ticket=++view,account=epoch,params=new URLSearchParams({limit:'50'});
  if(cursor) params.set('before',cursor);
  if(tab!=='audit') params.set('state',$('state').value);
  if(tab==='users') params.set('q',$('search').value.trim());
  $('page-status').textContent='正在加载…'; $('previous').disabled=true; $('next').disabled=true;
  $('records').replaceChildren(node('div','正在加载记录…','empty'));
  $('detail').replaceChildren(node('div','选择一条记录查看详情与操作','empty'));
  try {
    const [result]=await Promise.all([api(tab+'?'+params),summary()]);
    if(ticket!==view || account!==epoch) return;
    rows=result[tab==='audit'?'logs':tab]; hasMore=result.hasMore;
    $('next').dataset.cursor=result.nextCursor || ''; selected=0; renderRows();
    $('records').scrollTop=0;
    $('page-status').textContent=rows.length+' 条记录'; $('page-number').textContent='第 '+(history.length+1)+' 页';
    $('previous').disabled=history.length===0; $('next').disabled=!hasMore;
    $('detail').replaceChildren(node('div',rows.length?'选择一条记录查看详情与操作':'当前筛选下没有记录','empty'));
    message('');
  } catch(error) { if(ticket===view && account===epoch) { $('page-status').textContent='加载失败'; message(error.message,true); } }
}
function stateOf(user) { return user.deletedAt?'已注销':user.banned && (!user.bannedUntil || user.bannedUntil>Date.now())?'已禁用':'正常'; }
function renderRows() {
  const records=rows.map(row=>{
    if(tab==='audit') {
      const box=node('article','','audit-row');
      box.append(node('strong',actions[row.action] || row.action),node('p',row.actor+' · '+date(row.createdAt),'muted'),
        node('p',(row.targetId?'账号 #'+row.targetId+' ':'')+(row.reportId?'举报 #'+row.reportId+' ':'')+row.reason));
      return box;
    }
    const button=node('button','','record'+(selected===row.id?' selected':'')); button.type='button';
    const title=node('div','','record-title');
    title.append(node('span',tab==='reports'?(categories[row.category] || row.category)+' · '+row.targetName:(row.nickname || row.username)));
    title.append(node('span',tab==='reports'?statuses[row.status]:stateOf(row),'tag '+(tab==='reports'?row.status:row.deletedAt?'deleted':stateOf(row)==='已禁用'?'disabled':'')));
    button.append(title,node('p',tab==='reports'?(row.reason || '未补充原因'):'@'+row.username+(row.email?' · '+row.email:''),'muted'),
      node('small',tab==='reports'?'举报 #'+row.id+' · '+date(row.createdAt):'账号 #'+row.id));
    button.addEventListener('click',()=>{if(!working){selected=row.id;renderRows();if(tab==='reports') reportDetail(row);else userDetail(row.id);}});
    return button;
  });
  $('records').replaceChildren(...(records.length?records:[node('div','没有符合筛选的记录','empty')]));
}
function fields(entries) {
  const dl=node('dl');
  for(const [label,value] of entries) dl.append(node('dt',label),node('dd',String(value ?? '—')));
  return dl;
}
function heading(text) { const title=node('h2',text);title.tabIndex=-1;return title; }
function focusDetail(title) {title.focus({preventScroll:true});if(window.innerWidth<=1100)title.scrollIntoView({block:'start'});}
function reportDetail(report) {
  const detail=$('detail'),title=heading('举报 #'+report.id);
  detail.replaceChildren(title,node('span',statuses[report.status],'tag '+report.status),
    fields([['分类',categories[report.category]],['被举报人',report.targetName+' · #'+report.targetId],['举报人',report.reporterName],
      ['提交时间',date(report.createdAt)],['补充原因',report.reason || '无']]),
    node('h3','被举报消息'),node('div',report.evidenceText || '证据正文已按保存规则移除','evidence'));
  if(report.status!=='pending') detail.append(fields([['处理结果',report.result],['处理时间',date(report.handledAt)],['管理员',report.handledBy]]));
  else detail.append(actionForm(report.targetId,report));
  focusDetail(title);
}
async function userDetail(id) {
  const ticket=view,account=epoch; $('detail').replaceChildren(node('div','正在加载账号…','empty'));
  try {
    const result=await api('users/'+id);
    if(ticket!==view || account!==epoch || selected!==id) return;
    const user=result.user,detail=$('detail'),title=heading(user.nickname || user.username);
    detail.replaceChildren(title,node('span',stateOf(user),'tag'),fields([['账号','#'+id+' · @'+user.username],['邮箱',user.email?(user.email+(user.emailVerified?' · 已验证':' · 未验证')):'未绑定'],
      ['简介',user.bio || '无'],['接聊状态',user.accepting?(user.busy?'忙碌':'开放接聊'):'暂停接聊'],['接聊上限',user.maxChats],['消息数',result.counts.messages],
      ['被举报数',result.counts.reports],['封禁原因',user.banReason || '无'],['封禁到期',user.bannedUntil?date(user.bannedUntil):stateOf(user)==='已禁用'?'永久':'—']]));
    detail.append(node('h3','当前登录设备'));
    if(!result.devices.length) detail.append(node('p','没有有效登录设备','muted'));
    for(const device of result.devices) detail.append(node('p',device.name+' · 最近使用 '+date(device.lastSeen),'muted'));
    if(!user.deletedAt) detail.append(actionForm(id));
    else detail.append(node('p','资料与本人消息已移除，必要举报证据按隐私政策保存。','muted'));
    focusDetail(title);
  } catch(error) { if(ticket===view && account===epoch) message(error.message,true); }
}
function actionForm(userId,report) {
  const form=node('form'),choice=node('select'),reason=node('textarea'),hours=node('input'),button=node('button','保存处理结果','primary');
  const suffix=report?'report-'+report.id:'user-'+userId; choice.id='action-'+suffix; reason.id='reason-'+suffix; hours.id='hours-'+suffix;
  const choices=report?[['resolved','已处理（无需账号操作）'],['dismissed','不予处理']]:[];
  if(!report || !report.targetDeletedAt) choices.push(['warn','发出警告'],['temporary_ban','临时封禁'],['permanent_ban','永久封禁'],['unban','解封账号']);
  options(choice,choices,choices[0][0]); reason.required=true;reason.maxLength=500;reason.placeholder='填写处理原因或结论，会记录在操作日志中';hours.type='number';hours.min='1';hours.max='720';hours.value='24';hours.hidden=true;
  const actionLabel=node('label','处理动作');actionLabel.htmlFor=choice.id;
  const hoursLabel=node('label','封禁小时数（1–720）');hoursLabel.htmlFor=hours.id;hoursLabel.hidden=true;
  const reasonLabel=node('label','处理原因 / 结果');reasonLabel.htmlFor=reason.id;
  form.append(actionLabel,choice,hoursLabel,hours,reasonLabel,reason,button);
  choice.addEventListener('change',()=>{hours.hidden=hoursLabel.hidden=choice.value!=='temporary_ban';hours.required=!hours.hidden;button.classList.toggle('danger',choice.value.includes('ban'));});
  form.addEventListener('submit',async event=>{
    event.preventDefault(); if(working || !reason.value.trim()) return;
    if(choice.value.includes('ban') && !confirm('确认对账号 #'+userId+' 执行“'+(actions[choice.value] || choice.value)+'”？相关登录会立即撤销。')) return;
    const account=epoch;working=true;button.disabled=true;choice.disabled=true;reason.disabled=true;hours.disabled=true;message('');
    try {
      if(report && ['resolved','dismissed'].includes(choice.value)) await api('reports/'+report.id+'/resolve',{status:choice.value,result:reason.value.trim()});
      else await api('moderate',{userId,action:choice.value,reason:reason.value.trim(),durationHours:Number(hours.value),reportId:report?.id});
      if(account!==epoch) return;
      working=false;await loadPage();message('处理结果已保存，操作日志已记录。');
    } catch(error) { if(account===epoch) message(error.message,true); }
    finally { working=false;button.disabled=false;choice.disabled=false;reason.disabled=false;hours.disabled=false; }
  });
  return form;
}
$('login-form').addEventListener('submit',async event=>{
  event.preventDefault();if(working)return;working=true;
  const button=event.currentTarget.querySelector('button');button.disabled=true;$('login-error').textContent='';
  try { const identity=await api('login',{username:$('admin-name').value.trim(),password:$('admin-password').value});working=false;enter(identity); }
  catch(error) {$('login-error').textContent=error.message;}
  finally {working=false;button.disabled=false;}
});
$('logout').addEventListener('click',async()=>{
  const result=api('logout',{});tombstone(true);clearConsole('已退出管理台');working=false;
  try {await result;} catch {}
});
document.querySelectorAll('[data-tab]').forEach(el=>el.addEventListener('click',()=>switchTab(el.dataset.tab)));
$('refresh').addEventListener('click',()=>{if(!working)loadPage();});
$('filters').addEventListener('submit',event=>{event.preventDefault();if(!working){cursor='';history=[];loadPage();}});
$('next').addEventListener('click',()=>{if(hasMore&&!working){history.push(cursor);cursor=$('next').dataset.cursor;loadPage();}});
$('previous').addEventListener('click',()=>{if(history.length&&!working){cursor=history.pop();loadPage();}});
if(!tombstone()) {
  const hadSession=rememberSession();
  api('session').then(enter).catch(error=>{$('login-error').textContent=error.status===401&&!hadSession?'':error.message;});
}
