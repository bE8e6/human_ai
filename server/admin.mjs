import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tokenDigest } from './database.mjs';
import { verifyPassword } from './security.mjs';

const staticFiles = new Map([
  ['/admin',['admin/index.html','text/html; charset=utf-8']],
  ['/admin/',['admin/index.html','text/html; charset=utf-8']],
  ['/admin/assets/app.js',['admin/app.js','text/javascript; charset=utf-8']],
  ['/admin/assets/app.css',['admin/app.css','text/css; charset=utf-8']],
  ['/privacy',['public/privacy.html','text/html; charset=utf-8']],
  ['/rules',['public/rules.html','text/html; charset=utf-8']]
]);

export function createAdmin({db,fail,body,limit,id,pageSize,moderation,allowedOrigin,username,passwordHash,legacyKey=''}) {
  const configured=!!username && /^[^:\s]{1,128}:[a-f0-9]{128}$/.test(passwordHash || '');
  function equal(a,b) { return typeof a==='string' && typeof b==='string' && timingSafeEqual(Buffer.from(tokenDigest(a),'hex'),Buffer.from(tokenDigest(b),'hex')); }
  function origin(req) {
    const expected=allowedOrigin || (req.socket.encrypted?'https://':'http://')+req.headers.host;
    if (req.headers.origin && req.headers.origin!==expected) fail(403,'管理员请求来源不允许','ADMIN_ORIGIN_REJECTED');
  }
  function cookie(res,value,expires,req) {
    res.setHeader('Set-Cookie','human_ai_admin='+value+'; Path=/admin; HttpOnly; SameSite=Strict; '+
      (allowedOrigin.startsWith('https://') || req.socket.encrypted?'Secure; ':'')+'Expires='+new Date(expires).toUTCString());
  }
  function session(req) {
    const match=(req.headers.cookie || '').match(/(?:^|;\s*)human_ai_admin=([a-f0-9]{64})(?:;|$)/);
    const row=match?db.prepare('SELECT * FROM admin_sessions WHERE token=?').get(tokenDigest(match[1])):null;
    if (!configured || !row || row.expires<=Date.now() || row.username!==username) fail(401,'管理员会话已过期，请重新登录','ADMIN_SESSION_EXPIRED');
    return row;
  }
  function checkCsrf(req,row) { if (!equal(req.headers['x-csrf-token'],row.csrf)) fail(403,'管理员请求验证失败，请刷新页面','ADMIN_CSRF_REJECTED'); }
  function listResponse(rows,size,key) {
    const hasMore=rows.length>size, items=rows.slice(0,size);
    return {[key]:items,hasMore,nextCursor:hasMore?String(items.at(-1).id):''};
  }
  async function route(req,res,path,url,ip,send) {
    if (staticFiles.has(path) && req.method==='GET') {
      const [file,type]=staticFiles.get(path);
      res.setHeader('Content-Type',type);
      res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; connect-src 'self'");
      res.setHeader('Referrer-Policy','no-referrer');
      res.end(readFileSync(fileURLToPath(new URL(file,import.meta.url))));
      return true;
    }
    if (!path.startsWith('/admin/')) return false;
    if (path==='/admin/reports' || path==='/admin/ban') {
      if (!legacyKey || !equal(req.headers['x-admin-key'],legacyKey)) fail(403,'管理员验证失败');
      if (path==='/admin/reports' && req.method==='GET') {
        send({reports:db.prepare('SELECT r.*,r.evidence_text text,r.evidence_sender_id sender_id FROM reports r ORDER BY id DESC LIMIT 100').all()}); return true;
      }
      if (path==='/admin/ban' && req.method==='POST') {
        const data=await body(req);
        send(moderation.moderate({actor:'legacy-admin',userId:data.userId,action:'permanent_ban',reason:data.reason || '旧版管理员接口封禁'})); return true;
      }
      fail(404,'接口不存在');
    }
    if (!path.startsWith('/admin/api/')) fail(404,'页面不存在');
    if (req.method==='POST') {
      origin(req);
      if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) fail(415,'管理员接口需要JSON请求');
    }
    if (path==='/admin/api/login' && req.method==='POST') {
      limit('admin-login:'+ip,10,600_000);
      if (!configured) fail(503,'管理员账号尚未配置，请按部署说明设置账号和密码摘要','ADMIN_NOT_CONFIGURED');
      const data=await body(req);
      if (typeof data.username!=='string' || typeof data.password!=='string' || data.password.length<8 || data.password.length>128) fail(401,'管理员账号或密码错误','INVALID_ADMIN_CREDENTIALS');
      const valid=await verifyPassword(data.password,passwordHash);
      if (!valid || data.username!==username) fail(401,'管理员账号或密码错误','INVALID_ADMIN_CREDENTIALS');
      const token=randomBytes(32).toString('hex'), csrf=randomBytes(24).toString('hex'), expiresAt=Date.now()+8*3600_000;
      db.prepare('INSERT INTO admin_sessions(token,username,csrf,expires,created_at) VALUES(?,?,?,?,?)').run(tokenDigest(token),username,csrf,expiresAt,Date.now());
      moderation.audit(username,'login',null,null);
      cookie(res,token,expiresAt,req); send({username,csrf,expiresAt}); return true;
    }
    const identity=session(req);
    if (req.method==='POST') checkCsrf(req,identity);
    if (path==='/admin/api/session' && req.method==='GET') {
      send({username:identity.username,csrf:identity.csrf,expiresAt:identity.expires}); return true;
    }
    if (path==='/admin/api/logout' && req.method==='POST') {
      db.prepare('DELETE FROM admin_sessions WHERE token=?').run(identity.token);
      moderation.audit(identity.username,'logout',null,null);
      cookie(res,'',0,req); send({ok:true}); return true;
    }
    if (path==='/admin/api/summary' && req.method==='GET') {
      send({users:db.prepare('SELECT COUNT(*) n FROM users WHERE deleted_at IS NULL').get().n,
        banned:db.prepare('SELECT COUNT(*) n FROM users WHERE deleted_at IS NULL AND banned=1 AND (banned_until IS NULL OR banned_until>?)').get(Date.now()).n,
        pending:db.prepare("SELECT COUNT(*) n FROM reports WHERE status='pending'").get().n}); return true;
    }
    const size=pageSize(url), before=url.searchParams.get('before')?id(url.searchParams.get('before')):Number.MAX_SAFE_INTEGER;
    if (path==='/admin/api/users' && req.method==='GET') {
      const q=(url.searchParams.get('q') || '').trim().toLowerCase(), state=url.searchParams.get('state') || 'all';
      if (q.length>100 || !['all','active','disabled','deleted'].includes(state)) fail(400,'无效搜索或账号状态');
      const conditions={all:'1',active:'deleted_at IS NULL AND (banned=0 OR banned_until<='+Date.now()+')',
        disabled:'deleted_at IS NULL AND banned=1 AND (banned_until IS NULL OR banned_until>'+Date.now()+')',deleted:'deleted_at IS NOT NULL'};
      const rows=db.prepare(`SELECT id,username,nickname,email,email_verified emailVerified,banned,banned_until bannedUntil,deleted_at deletedAt,ban_reason banReason
        FROM users WHERE id<? AND (${conditions[state]}) AND (instr(lower(username),?)>0 OR instr(lower(nickname),?)>0 OR instr(COALESCE(email,''),?)>0) ORDER BY id DESC LIMIT ?`)
        .all(before,q,q,q,size+1);
      send(listResponse(rows,size,'users')); return true;
    }
    const detail=path.match(/^\/admin\/api\/users\/(\d+)$/);
    if (detail && req.method==='GET') {
      const target=id(detail[1]);
      const user=db.prepare('SELECT id,username,nickname,bio,ai_style aiStyle,ai_topics aiTopics,accepting,busy,max_chats maxChats,email,email_verified emailVerified,banned,banned_until bannedUntil,ban_reason banReason,deleted_at deletedAt FROM users WHERE id=?').get(target);
      if (!user) fail(404,'账号不存在');
      const counts=db.prepare('SELECT (SELECT COUNT(*) FROM messages WHERE sender_id=?) messages,(SELECT COUNT(*) FROM reports WHERE evidence_sender_id=?) reports').get(target,target);
      const devices=db.prepare('SELECT device_name name,created_at createdAt,last_seen lastSeen,expires expiresAt FROM sessions WHERE user_id=? AND revoked_reason IS NULL AND expires>? ORDER BY last_seen DESC').all(target,Date.now());
      send({user,counts,devices}); return true;
    }
    if (path==='/admin/api/reports' && req.method==='GET') {
      const state=url.searchParams.get('state') || 'pending';
      if (!['all','pending','resolved','dismissed'].includes(state)) fail(400,'无效举报状态');
      const rows=db.prepare(`SELECT r.id,r.reporter_id reporterId,r.message_id messageId,r.category,r.reason,r.status,r.result,r.created_at createdAt,
        r.handled_at handledAt,r.handled_by handledBy,r.evidence_text evidenceText,r.evidence_sender_id targetId,
        COALESCE(NULLIF(u.nickname,''),u.username,'已注销用户') targetName,u.deleted_at targetDeletedAt,
        COALESCE(NULLIF(p.nickname,''),p.username,'已注销用户') reporterName
        FROM reports r LEFT JOIN users u ON u.id=r.evidence_sender_id LEFT JOIN users p ON p.id=r.reporter_id
        WHERE r.id<? AND (?='all' OR r.status=?) ORDER BY r.id DESC LIMIT ?`).all(before,state,state,size+1);
      send(listResponse(rows,size,'reports')); return true;
    }
    if (path==='/admin/api/audit' && req.method==='GET') {
      send(listResponse(db.prepare('SELECT id,actor,action,target_id targetId,report_id reportId,reason,created_at createdAt FROM admin_audit WHERE id<? ORDER BY id DESC LIMIT ?').all(before,size+1),size,'logs')); return true;
    }
    if (path==='/admin/api/moderate' && req.method==='POST') {
      const data=await body(req); send(moderation.moderate({...data,actor:identity.username})); return true;
    }
    const resolve=path.match(/^\/admin\/api\/reports\/(\d+)\/resolve$/);
    if (resolve && req.method==='POST') {
      const data=await body(req); send(moderation.resolveReport(identity.username,id(resolve[1]),data.status,data.result)); return true;
    }
    fail(404,'管理员接口不存在');
  }
  return {route,configured};
}
