export const REPORT_CATEGORIES = ['harassment','hate','sexual','scam','privacy','other'];

export function createModeration({db,fail,body,limit,id,pageSize,onChanged,revoke}) {
  function atomic(work) {
    db.exec('BEGIN IMMEDIATE');
    try { const value=work(); db.exec('COMMIT'); return value; }
    catch(error) { db.exec('ROLLBACK'); throw error; }
  }
  function audit(actor,action,targetId,reportId,reason='') {
    db.prepare('INSERT INTO admin_audit(actor,action,target_id,report_id,reason,created_at) VALUES(?,?,?,?,?,?)')
      .run(actor,action,targetId || null,reportId || null,reason,Date.now());
  }
  function moderate({actor,userId,action,reason,durationHours,reportId}) {
    const target=id(userId);
    if (!['warn','temporary_ban','permanent_ban','unban'].includes(action)) fail(400,'无效处理动作');
    const text=typeof reason==='string'?reason.trim():'';
    if (!text || text.length>500) fail(400,'处理原因需为1–500个字符');
    const user=db.prepare('SELECT * FROM users WHERE id=?').get(target);
    if (!user || user.deleted_at) fail(404,'可处理的账号不存在');
    if (action==='temporary_ban' && (!Number.isSafeInteger(durationHours) || durationHours<1 || durationHours>720)) fail(400,'临时封禁时长需为1–720小时');
    const report=reportId?db.prepare('SELECT * FROM reports WHERE id=?').get(id(reportId)):null;
    if (reportId && (!report || report.evidence_sender_id!==target)) fail(400,'举报与被处理账号不匹配');
    if (report && report.status!=='pending') fail(409,'举报已处理，请刷新列表');
    atomic(() => {
      if (action==='warn') {
        db.prepare('INSERT INTO account_notices(user_id,reason,created_at) VALUES(?,?,?)').run(target,text,Date.now());
      } else if (action==='unban') {
        db.prepare("UPDATE users SET banned=0,banned_until=NULL,ban_reason='' WHERE id=?").run(target);
      } else {
        db.prepare('UPDATE users SET banned=1,banned_until=?,ban_reason=?,accepting=0 WHERE id=?')
          .run(action==='temporary_ban'?Date.now()+durationHours*3600_000:null,text,target);
        db.prepare("UPDATE sessions SET revoked_reason='ACCOUNT_BANNED' WHERE user_id=?").run(target);
      }
      if (report) db.prepare("UPDATE reports SET status='resolved',result=?,handled_at=?,handled_by=? WHERE id=?")
        .run(text,Date.now(),actor,report.id);
      audit(actor,action,target,report?.id,text);
    });
    revoke(); onChanged(target);
    if (report) onChanged(report.reporter_id,{type:'reports'});
    return {ok:true};
  }
  function resolveReport(actor,reportId,status,result) {
    const report=db.prepare('SELECT * FROM reports WHERE id=?').get(id(reportId));
    if (!report) fail(404,'举报不存在');
    if (report.status!=='pending') fail(409,'举报已处理，请刷新列表');
    if (!['resolved','dismissed'].includes(status) || typeof result!=='string' || !result.trim() || result.trim().length>500) fail(400,'请选择处理结果并填写1–500字说明');
    atomic(() => {
      db.prepare('UPDATE reports SET status=?,result=?,handled_at=?,handled_by=? WHERE id=?').run(status,result.trim(),Date.now(),actor,report.id);
      audit(actor,'report_'+status,report.evidence_sender_id,report.id,result.trim());
    });
    onChanged(report.reporter_id,{type:'reports'});
    return {ok:true};
  }
  async function route(req,path,url,user,send) {
    if (path==='/blocks' && req.method==='GET') {
      const size=pageSize(url), before=url.searchParams.get('before')?id(url.searchParams.get('before')):Number.MAX_SAFE_INTEGER;
      const rows=db.prepare("SELECT u.id,u.username,COALESCE(NULLIF(u.nickname,''),u.username) nickname FROM blocks b JOIN users u ON u.id=b.target_id WHERE b.user_id=? AND b.target_id<? ORDER BY b.target_id DESC LIMIT ?")
        .all(user.id,before,size+1);
      const hasMore=rows.length>size, users=rows.slice(0,size);
      send({users,hasMore,nextCursor:hasMore?String(users.at(-1).id):''}); return true;
    }
    if (path==='/reports' && req.method==='GET') {
      const size=pageSize(url), before=url.searchParams.get('before')?id(url.searchParams.get('before')):Number.MAX_SAFE_INTEGER;
      const rows=db.prepare('SELECT id,message_id messageId,category,reason,status,result,created_at createdAt,handled_at handledAt,evidence_sender_id targetId FROM reports WHERE reporter_id=? AND id<? ORDER BY id DESC LIMIT ?')
        .all(user.id,before,size+1);
      const hasMore=rows.length>size, reports=rows.slice(0,size);
      send({reports,hasMore,nextCursor:hasMore?String(reports.at(-1).id):''}); return true;
    }
    if (path==='/reports' && req.method==='POST') {
      limit('report-requests:'+user.id,30);
      const data=await body(req), messageId=id(data.messageId);
      const message=db.prepare('SELECT * FROM messages WHERE id=?').get(messageId);
      if (!message) fail(404,'消息不存在');
      const conversation=db.prepare('SELECT user_id,ai_id FROM conversations WHERE id=?').get(message.conversation_id);
      if (!conversation || (conversation.user_id!==user.id && conversation.ai_id!==user.id)) fail(404,'消息不存在');
      if (message.sender_id===user.id) fail(400,'不能举报自己的消息');
      const category=data.category || 'other', reason=typeof data.reason==='string'?data.reason.trim():'';
      if (!REPORT_CATEGORIES.includes(category) || reason.length>300) fail(400,'请选择举报分类，补充原因最多300字');
      const existing=db.prepare('SELECT id,status FROM reports WHERE reporter_id=? AND message_id=? ORDER BY id LIMIT 1').get(user.id,messageId);
      if (existing) { send({ok:true,reportId:existing.id,status:existing.status,replayed:true}); return true; }
      limit('report-new:'+user.id,5); limit('report-day:'+user.id,20,86400_000);
      const result=db.prepare('INSERT INTO reports(reporter_id,message_id,category,reason,created_at,evidence_text,evidence_sender_id,evidence_conversation_id) VALUES(?,?,?,?,?,?,?,?)')
        .run(user.id,messageId,category,reason,Date.now(),message.text,message.sender_id,message.conversation_id);
      send({ok:true,reportId:Number(result.lastInsertRowid),status:'pending',replayed:false},201); return true;
    }
    return false;
  }
  return {route,moderate,resolveReport,audit};
}
