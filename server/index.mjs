import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate, tokenDigest, SCHEMA_VERSION } from './database.mjs';
import { createRealtime } from './realtime.mjs';
import { hashPassword, verifyPassword, clientIp, secureEqual } from './security.mjs';
import { configuredMail } from './mail.mjs';
import { createAccounts } from './accounts.mjs';
import { createModeration } from './moderation.mjs';
import { createAdmin } from './admin.mjs';
import { createPrivacy, POLICY_VERSION } from './privacy.mjs';
import { startupConfig } from './config.mjs';
import { maintain } from './maintenance.mjs';
import { pruneRecoveryCopies } from './backup.mjs';

export function createApp({
  dbPath = process.env.DB_PATH || resolve(dirname(fileURLToPath(import.meta.url)), 'data/chat.db'),
  adminKey = process.env.ALLOW_LEGACY_ADMIN === 'true' ? process.env.ADMIN_KEY || '' : '',
  adminUsername = process.env.ADMIN_USERNAME || 'operator', adminPasswordHash = process.env.ADMIN_PASSWORD_HASH || '',
  metricsKey = process.env.METRICS_KEY || '',
  mailer = configuredMail(), mailSecret = process.env.MAIL_CODE_SECRET || '', deletionLogPath,
  trustedProxies = (process.env.TRUSTED_PROXIES || '').split(',').map(value=>value.trim()).filter(Boolean),
  heartbeatMs, timeoutMs, allowedOrigin = process.env.PUBLIC_ORIGIN || ''
} = {}) {
  if (allowedOrigin) allowedOrigin = new URL(allowedOrigin).origin;
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try { migrate(db); } catch (error) { db.close(); throw error; }
  let privacy;
  try { privacy = createPrivacy(db,deletionLogPath ?? (dbPath===':memory:'?'':dbPath+'.deletions.ndjson'));maintain(db,Date.now(),true);privacy.compact();pruneRecoveryCopies(dbPath); }
  catch(error) { db.close(); throw error; }
  let realtime;
  let lastPrivacyCleanup=Date.now();
  const cleanup = setInterval(() => {
    const now = Date.now();
    try {
      const daily=now-lastPrivacyCleanup>86400_000,expired=maintain(db,now,daily);
      for (const userId of expired) realtime.publish([userId],{type:'account'});
      if (expired.length) realtime.broadcast({type:'directory'});
      if (daily) {privacy.compact();pruneRecoveryCopies(dbPath,now);lastPrivacyCleanup=now;}
    } catch {console.error(JSON.stringify({level:'error',code:'MAINTENANCE_FAILED'}));}
  }, 60_000);
  cleanup.unref();
  function limit(key, count, period = 60_000) {
    const now = Date.now();
    const value=db.prepare(`INSERT INTO rate_limits(key,count,until) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET
      count=CASE WHEN until<=? THEN 1 ELSE count+1 END,until=CASE WHEN until<=? THEN excluded.until ELSE until END RETURNING count`)
      .get(key,now+period,now,now);
    if (value.count > count) fail(429, '操作太频繁，请稍后再试','RATE_LIMITED');
  }
  function fail(status, message, code = '') { throw Object.assign(new Error(message), { status, code }); }
  function id(value) {
    const result = Number(value);
    if (!Number.isSafeInteger(result) || result < 1) fail(400, '无效编号');
    return result;
  }
  function activeChats(userId) {
    return db.prepare('SELECT COUNT(*) n FROM conversations c LEFT JOIN conversation_settings s ON s.conversation_id=c.id AND s.user_id=? WHERE c.ai_id=? AND COALESCE(s.hidden,0)=0').get(userId,userId).n;
  }
  function publicUser(user) {
    const active=user.activeChats ?? activeChats(user.id);
    return {id:user.id,username:user.deleted_at?'':user.username,nickname:user.nickname || user.username,bio:user.bio,
      aiStyle:user.ai_style,aiTopics:user.ai_topics,accepting:!!user.accepting,busy:!!user.busy,maxChats:user.max_chats,
      activeChats:active,available:!!user.accepting && !user.busy && active<user.max_chats,online:realtime?.isOnline(user.id) || false};
  }
  function privateUser(user) {
    return {...publicUser(user),email:user.email || '',emailVerified:!!user.email_verified,
      notificationEnabled:!!user.notification_enabled,notificationPreview:!!user.notification_preview};
  }
  function loadUser(userId) {
    const user=db.prepare('SELECT * FROM users WHERE id=?').get(userId);
    if (user?.banned && user.banned_until && user.banned_until<=Date.now() && !user.deleted_at) {
      db.prepare("UPDATE users SET banned=0,banned_until=NULL,ban_reason='' WHERE id=?").run(userId);
      user.banned=0; user.banned_until=null; user.ban_reason='';
      db.prepare("INSERT INTO admin_audit(actor,action,target_id,reason,created_at) VALUES('system','temporary_ban_expired',?,'临时封禁到期自动解除',?)").run(userId,Date.now());
      realtime?.publish([userId],{type:'account'}); realtime?.broadcast({type:'directory'});
    }
    return user;
  }
  function authenticate(digest, req) {
    if (!digest) digest = tokenDigest((req.headers.authorization || '').replace(/^Bearer /,''));
    const session = db.prepare('SELECT * FROM sessions WHERE token=?').get(digest);
    if (!session) fail(401,'登录已失效，请重新登录','SESSION_EXPIRED');
    if (session.revoked_reason) {
      const reasons={ACCOUNT_BANNED:'账号禁用后当前登录已撤销，请重新登录或联系管理员',ACCOUNT_DELETED:'账号已注销',
        PASSWORD_CHANGED:'密码已修改，请用新密码登录',PASSWORD_RESET:'密码已重置，请用新密码登录',DEVICE_REVOKED:'此设备已被退出，请重新登录',SIGNED_OUT:'账号已退出，请重新登录',SERVICE_RESTORED:'服务已从备份恢复，请重新登录'};
      fail(401,reasons[session.revoked_reason] || '登录已被撤销，请重新登录',session.revoked_reason);
    }
    if (session.expires <= Date.now()) fail(401,'登录已过期，请重新登录','SESSION_EXPIRED');
    const user = loadUser(session.user_id);
    if (user?.deleted_at) fail(401,'账号已注销','ACCOUNT_DELETED');
    if (!user || user.banned) fail(401,'账号已被禁用，请联系管理员','ACCOUNT_BANNED');
    return { digest,session,user };
  }
  function issueSession(user, data) {
    const token = randomBytes(32).toString('hex');
    const now = Date.now();
    const expiresAt = now + 7 * 86400_000;
    const deviceId = typeof data.deviceId === 'string' ? data.deviceId.slice(0,80) : '';
    const deviceName = typeof data.deviceName === 'string' ? data.deviceName.trim().slice(0,80) : '未知设备';
    db.prepare('INSERT INTO sessions(token,user_id,expires,device_id,device_name,created_at,last_seen,session_id) VALUES(?,?,?,?,?,?,?,?)')
      .run(tokenDigest(token), user.id, expiresAt, deviceId, deviceName || '未知设备', now, now, randomBytes(12).toString('hex'));
    return { token, expiresAt, user: privateUser(user) };
  }
  function participant(conversationId, userId) {
    const c = db.prepare('SELECT * FROM conversations WHERE id=?').get(conversationId);
    if (!c || (c.user_id !== userId && c.ai_id !== userId)) fail(404, '对话不存在');
    return c;
  }
  function blocked(a, b) {
    return !!db.prepare('SELECT 1 FROM blocks WHERE (user_id=? AND target_id=?) OR (user_id=? AND target_id=?)').get(a,b,b,a);
  }
  function pageSize(url, fallback = 50) {
    const value = Number(url.searchParams.get('limit') || fallback);
    if (!Number.isSafeInteger(value) || value < 1 || value > 100) fail(400,'分页大小需为1–100');
    return value;
  }
  function cursor(url, length, allowText = false) {
    const value = url.searchParams.get('cursor');
    if (!value) return null;
    try {
      if (value.length > 500) throw new Error();
      const data = JSON.parse(Buffer.from(value,'base64url').toString());
      if (!Array.isArray(data) || data.length !== length || data.some((n,i) => allowText && i===0 ?
        typeof n!=='string' || n.length>100 : !Number.isSafeInteger(n) || n<0)) throw new Error();
      return data;
    } catch { fail(400,'无效分页游标'); }
  }
  function blockState(a,b) {
    const selfBlocked = !!db.prepare('SELECT 1 FROM blocks WHERE user_id=? AND target_id=?').get(a,b);
    const peerBlocked = !!db.prepare('SELECT 1 FROM blocks WHERE user_id=? AND target_id=?').get(b,a);
    return { selfBlocked, peerBlocked, blocked: selfBlocked || peerBlocked };
  }
  async function body(req) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 16_384) fail(413, '请求过大');
      chunks.push(chunk);
    }
    let value;
    try { value = JSON.parse(Buffer.concat(chunks).toString() || '{}'); }
    catch { fail(400, '无效 JSON 请求'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, '无效请求');
    if (req.authDigest) authenticate(req.authDigest);
    return value;
  }
  function onChanged(userId,event={type:'account'}) {
    realtime.publish([userId],event);
    if (event.type==='account') realtime.broadcast({type:'directory'});
  }
  const moderation=createModeration({db,fail,body,limit,id,pageSize,onChanged,revoke:()=>realtime.revalidate()});
  const accounts=createAccounts({db,fail,body,limit,authenticate,privateUser,onChanged,revoke:()=>realtime.revalidate(),privacy,mailer,mailSecret});
  const admin=createAdmin({db,fail,body,limit,id,pageSize,moderation,allowedOrigin,username:adminUsername,passwordHash:adminPasswordHash,legacyKey:adminKey});
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    function send(data, status = 200) { res.writeHead(status); res.end(JSON.stringify(data)); }
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      const method = req.method;
      const ip = clientIp(req,trustedProxies);
      limit(`ip:${ip}`, 600);
      if (path === '/health' && method === 'GET') {
        db.prepare('SELECT 1').get();
        return send({ ok: true, name: '人机？', version: '2.0.0', schemaVersion: SCHEMA_VERSION });
      }
      if (path==='/internal/metrics' && method==='GET') {
        if (!metricsKey || !secureEqual(req.headers['x-metrics-key'],metricsKey)) fail(403,'监测验证失败');
        const bytes=path=>{try{return statSync(path).size;}catch{return 0;}};
        return send({ok:true,at:Date.now(),uptimeSeconds:Math.floor(process.uptime()),rssBytes:process.memoryUsage().rss,
          databaseBytes:dbPath===':memory:'?0:bytes(dbPath)+bytes(dbPath+'-wal'),schemaVersion:SCHEMA_VERSION});
      }
      if (await admin.route(req,res,path,url,ip,send)) return;
      if (await accounts.publicRoute(req,path,ip,send)) return;
      if ((path === '/auth/register' || path === '/auth/login') && method === 'POST') {
        limit(`auth:${ip}`, 20);
        const data = await body(req);
        const username = typeof data.username === 'string' ? data.username.trim().toLowerCase() : '';
        const password = typeof data.password === 'string' ? data.password : '';
        if (!/^[a-z0-9_]{3,24}$/.test(username) || password.length < 8 || password.length > 128) fail(400, '用户名需为3–24位字母、数字或下划线，密码需为8–128位');
        if (path === '/auth/register') {
          if (data.acceptPolicy!==true || data.policyVersion!==POLICY_VERSION) fail(400,'注册前请阅读并同意当前隐私政策和使用规则','PRIVACY_ACCEPTANCE_REQUIRED');
          limit(`register:${ip}`, 5, 3600_000);
          if (db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) fail(409, '用户名已被注册');
          if (username.startsWith('__deleted_')) fail(400,'该用户名保留用于数据处理');
          const passwordHash = await hashPassword(password);
          if (db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) fail(409, '用户名已被注册');
          const result = db.prepare('INSERT INTO users(username,password,nickname,created_at,policy_version,policy_accepted_at) VALUES(?,?,?,?,?,?)').run(username,passwordHash,username,Date.now(),POLICY_VERSION,Date.now());
          return send(issueSession(db.prepare('SELECT * FROM users WHERE id=?').get(Number(result.lastInsertRowid)),data),201);
        }
        limit('login-name:'+username,12);
        const user = db.prepare('SELECT * FROM users WHERE username=? AND deleted_at IS NULL').get(username);
        // 未注册用户名也计算哈希，避免明显的耗时差异。
        if (!await verifyPassword(password,user?.password) || !user) fail(401, '用户名或密码错误', 'INVALID_CREDENTIALS');
        const current=loadUser(user.id);
        if (!current || current.deleted_at || current.password!==user.password) fail(401,'登录状态已变更，请重新登录','INVALID_CREDENTIALS');
        if (current.banned) fail(403, '账号已被禁用'+(current.banned_until?'，至'+new Date(current.banned_until).toISOString():''), 'ACCOUNT_BANNED');
        return send(issueSession(current,data));
      }
      const {digest:token,session,user} = authenticate(null,req);
      req.authDigest=token;
      db.prepare('UPDATE sessions SET last_seen=? WHERE token=? AND last_seen<?').run(Date.now(),token,Date.now()-60_000);
      if (await accounts.privateRoute(req,path,ip,{digest:token,session,user},send)) return;
      if (await moderation.route(req,path,url,user,send)) return;
      if (path === '/me' && method === 'GET') return send({ user: privateUser(user), expiresAt: session.expires });
      if (path === '/me/unread' && method === 'GET') {
        const count = role => {
          const column = role === 'user' ? 'user_id' : 'ai_id';
          const read = role === 'user' ? 'user_read' : 'ai_read';
          return db.prepare(`SELECT COUNT(*) total FROM messages m JOIN conversations c ON c.id=m.conversation_id
            LEFT JOIN conversation_settings s ON s.conversation_id=c.id AND s.user_id=?
            WHERE c.${column}=? AND m.sender_id!=? AND m.id>c.${read} AND COALESCE(s.hidden,0)=0`).get(user.id,user.id,user.id).total;
        };
        return send({ unread: { user: count('user'), ai: count('ai') } });
      }
      if (path === '/auth/logout' && method === 'POST') {
        db.prepare("UPDATE sessions SET revoked_reason='SIGNED_OUT' WHERE token=?").run(token);
        realtime.revalidate();
        return send({ ok: true });
      }
      if (path === '/auth/password' && method === 'POST') {
        limit(`password:${user.id}`,5);
        const data = await body(req);
        if (typeof data.currentPassword !== 'string' || data.currentPassword.length > 128 || !await verifyPassword(data.currentPassword,user.password)) fail(400, '当前密码错误');
        if (typeof data.newPassword !== 'string' || data.newPassword.length < 8 || data.newPassword.length > 128) fail(400, '新密码需为8–128位');
        const nextHash = await hashPassword(data.newPassword);
        authenticate(token);
        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare('UPDATE users SET password=? WHERE id=?').run(nextHash,user.id);
          db.prepare("UPDATE sessions SET revoked_reason='PASSWORD_CHANGED' WHERE user_id=?").run(user.id);
          db.prepare('UPDATE email_challenges SET used_at=? WHERE user_id=? AND used_at IS NULL').run(Date.now(),user.id);
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        realtime.revalidate();
        return send({ ok: true });
      }
      if (path === '/auth/devices' && method === 'GET') {
        return send({ devices: db.prepare('SELECT session_id id,device_name name,created_at createdAt,last_seen lastSeen,expires expiresAt,token=? current FROM sessions WHERE user_id=? AND expires>? AND revoked_reason IS NULL ORDER BY last_seen DESC,session_id')
          .all(token,user.id,Date.now()).map(device => ({...device,current:!!device.current})) });
      }
      if (path === '/auth/devices/revoke' && method === 'POST') {
        const data = await body(req);
        if (data.otherDevices === true) db.prepare("UPDATE sessions SET revoked_reason='DEVICE_REVOKED' WHERE user_id=? AND token!=?").run(user.id,token);
        else if (typeof data.sessionId === 'string') {
          if (!db.prepare("UPDATE sessions SET revoked_reason='DEVICE_REVOKED' WHERE user_id=? AND session_id=?").run(user.id,data.sessionId).changes) fail(404,'登录设备不存在');
        } else fail(400,'请选择需要退出的设备');
        realtime.revalidate();
        return send({ ok: true });
      }
      if (path === '/me/accepting' && method === 'POST') {
        const data = await body(req);
        if (typeof data.accepting !== 'boolean') fail(400, '无效状态');
        db.prepare('UPDATE users SET accepting=? WHERE id=?').run(data.accepting ? 1 : 0,user.id);
        realtime.publish([user.id],{type:'account'});
        realtime.broadcast({type:'directory'});
        return send({ ok: true });
      }
      if (path === '/ais' && method === 'GET') {
        const size = pageSize(url);
        const sort=url.searchParams.get('sort') || 'recent';
        if (!['recent','available','name'].includes(sort)) fail(400,'无效排序');
        const after = cursor(url,sort==='recent'?1:2,sort==='name');
        const q = (url.searchParams.get('q') || '').trim();
        if (q.length > 100) fail(400,'搜索内容过长');
        const online=realtime.onlineIds();
        const afterSql=sort==='recent'?'AND id<?':sort==='available'?'AND (rank<? OR (rank=? AND id<?))':'AND (sortName>? OR (sortName=? AND id<?))';
        const afterArgs=sort==='recent'?[after?after[0]:Number.MAX_SAFE_INTEGER]:after?[after[0],after[0],after[1]]:[];
        const order=sort==='recent'?'id DESC':sort==='available'?'rank DESC,id DESC':'sortName ASC,id DESC';
        const rows = db.prepare(`WITH directory AS (
          SELECT u.*,(SELECT COUNT(*) FROM conversations c LEFT JOIN conversation_settings s ON s.conversation_id=c.id AND s.user_id=u.id
            WHERE c.ai_id=u.id AND COALESCE(s.hidden,0)=0) activeChats,
          CASE WHEN u.id IN (${online.length?online.map(()=>'?').join(','):'NULL'}) THEN 1 ELSE 0 END onlineFlag,
          lower(COALESCE(NULLIF(u.nickname,''),u.username)) sortName FROM users u
        ), ranked AS (SELECT *,CASE WHEN busy=0 AND activeChats<max_chats THEN 2 ELSE 0 END+onlineFlag rank FROM directory)
          SELECT * FROM ranked u WHERE accepting=1 AND banned=0 AND deleted_at IS NULL AND id!=?
          AND (instr(lower(username),lower(?))>0 OR instr(lower(nickname),lower(?))>0 OR instr(lower(ai_style),lower(?))>0 OR instr(lower(ai_topics),lower(?))>0)
          AND NOT EXISTS(SELECT 1 FROM blocks b WHERE (b.user_id=? AND b.target_id=u.id) OR (b.target_id=? AND b.user_id=u.id))
          ${after || sort==='recent'?afterSql:''} ORDER BY ${order} LIMIT ?`)
          .all(...online,user.id,q,q,q,q,user.id,user.id,...afterArgs,size+1);
        const hasMore = rows.length > size;
        const users = rows.slice(0,size).map(publicUser), last=rows[Math.min(size,rows.length)-1];
        const next=last?(sort==='recent'?[last.id]:sort==='available'?[last.rank,last.id]:[last.sortName,last.id]):[];
        return send({ users,hasMore,nextCursor:hasMore ? Buffer.from(JSON.stringify(next)).toString('base64url') : '' });
      }
      if (path === '/conversations' && method === 'POST') {
        limit(`new:${user.id}`, 10);
        const data = await body(req);
        const aiId = id(data.aiId);
        if (aiId === user.id) fail(400, '不能和自己聊天');
        if (blocked(user.id,aiId)) fail(403, '已拉黑，无法发起对话');
        const ai = loadUser(aiId);
        if (!ai || ai.banned || ai.deleted_at) fail(403,'对方账号不可用','PEER_UNAVAILABLE');
        const existing=db.prepare('SELECT id FROM conversations WHERE user_id=? AND ai_id=?').get(user.id,aiId);
        if (!existing) {
          if (!ai.accepting || ai.busy) fail(409,'对方已暂停接聊或正忙，已有对话仍可回复','AI_UNAVAILABLE');
          if (activeChats(aiId)>=ai.max_chats) fail(409,'对方接聊数量已达上限，请稍后再试','AI_CAPACITY');
          db.prepare('INSERT INTO conversations(user_id,ai_id) VALUES(?,?)').run(user.id,aiId);
        }
        const conversationId = existing?.id || db.prepare('SELECT id FROM conversations WHERE user_id=? AND ai_id=?').get(user.id,aiId).id;
        db.prepare('INSERT INTO conversation_settings(conversation_id,user_id,hidden) VALUES(?,?,0) ON CONFLICT(conversation_id,user_id) DO UPDATE SET hidden=0').run(conversationId,user.id);
        realtime.publish([user.id,aiId],{type:'conversation',conversationId});
        if (!existing) realtime.broadcast({type:'directory'});
        return send({ conversationId });
      }
      if (path === '/conversations' && method === 'GET') {
        const role = url.searchParams.get('role');
        if (role !== 'user' && role !== 'ai') fail(400, '无效身份');
        const column = role === 'user' ? 'user_id' : 'ai_id';
        const readColumn = role === 'user' ? 'user_read' : 'ai_read';
        const other = role === 'user' ? 'ai_id' : 'user_id';
        const size = pageSize(url);
        const after = cursor(url,3);
        const q = (url.searchParams.get('q') || '').trim();
        if (q.length > 100) fail(400,'搜索内容过长');
        const includeHidden = url.searchParams.get('hidden') === '1' ? 1 : 0;
        const rows = db.prepare(`SELECT c.id,u.id peerId,COALESCE(NULLIF(u.nickname,''),u.username) peerName,COALESCE(m.text,'还没有消息') lastText,
          COALESCE(m.created_at,0) lastAt,c.last_message_id lastMessageId,COALESCE(s.pinned,0) pinned,COALESCE(s.muted,0) muted,
          (SELECT COUNT(*) FROM messages WHERE conversation_id=c.id AND sender_id!=? AND id>c.${readColumn}) unread
          FROM conversations c JOIN users u ON u.id=c.${other} LEFT JOIN messages m ON m.id=c.last_message_id
          LEFT JOIN conversation_settings s ON s.conversation_id=c.id AND s.user_id=?
          WHERE c.${column}=? AND COALESCE(s.hidden,0)=? AND (instr(u.username,?)>0 OR instr(u.nickname,?)>0 OR EXISTS(SELECT 1 FROM messages sm WHERE sm.conversation_id=c.id AND instr(sm.text,?)>0))
          ${after ? 'AND (COALESCE(s.pinned,0)<? OR (COALESCE(s.pinned,0)=? AND c.last_message_id<?) OR (COALESCE(s.pinned,0)=? AND c.last_message_id=? AND c.id<?))' : ''}
          ORDER BY pinned DESC,c.last_message_id DESC,c.id DESC LIMIT ?`).all(user.id,user.id,user.id,includeHidden,q,q,q,...(after ? [after[0],after[0],after[1],after[0],after[1],after[2]] : []),size+1);
        const hasMore = rows.length > size;
        const conversations = rows.slice(0,size).map(c => ({...c,pinned:!!c.pinned,muted:!!c.muted}));
        const last = rows[Math.min(size,rows.length)-1];
        return send({ conversations,hasMore,nextCursor:hasMore ? Buffer.from(JSON.stringify([last.pinned,last.lastMessageId,last.id])).toString('base64url') : '' });
      }
      const detail = path.match(/^\/conversations\/(\d+)$/);
      if (detail && method === 'GET') {
        const c = participant(id(detail[1]),user.id);
        const peerId = c.user_id === user.id ? c.ai_id : c.user_id;
        const settings = db.prepare('SELECT * FROM conversation_settings WHERE conversation_id=? AND user_id=?').get(c.id,user.id);
        const last = db.prepare('SELECT text,created_at FROM messages WHERE id=?').get(c.last_message_id);
        const readColumn = c.user_id === user.id ? 'user_read' : 'ai_read';
        const unread = db.prepare(`SELECT COUNT(*) n FROM messages WHERE conversation_id=? AND sender_id!=? AND id>?`).get(c.id,user.id,c[readColumn]).n;
        const peer=loadUser(peerId);
        return send({ conversation: {id:c.id,peerId,peerName:peer.nickname || peer.username,role:c.user_id===user.id?'user':'ai',pinned:!!settings?.pinned,muted:!!settings?.muted,hidden:!!settings?.hidden,lastText:last?.text || '还没有消息',lastAt:last?.created_at || 0,lastMessageId:c.last_message_id,unread,...blockState(user.id,peerId),peerUnavailable:!!peer.banned || !!peer.deleted_at},peerReadId:c.user_id===user.id?c.ai_read:c.user_read });
      }
      const match = path.match(/^\/conversations\/(\d+)\/(messages|read|settings)$/);
      if (match) {
        const conversationId = id(match[1]);
        const c = participant(conversationId,user.id);
        if (match[2] === 'settings' && method === 'POST') {
          const data = await body(req);
          const fields = ['hidden','pinned','muted'].filter(field => data[field] !== undefined);
          if (!fields.length || fields.some(field => typeof data[field] !== 'boolean')) fail(400,'无效会话设置');
          db.prepare('INSERT OR IGNORE INTO conversation_settings(conversation_id,user_id) VALUES(?,?)').run(conversationId,user.id);
          db.prepare(`UPDATE conversation_settings SET ${fields.map(field=>`${field}=?`).join(',')} WHERE conversation_id=? AND user_id=?`).run(...fields.map(field=>data[field]?1:0),conversationId,user.id);
          realtime.publish([user.id],{type:'settings',conversationId});
          if (fields.includes('hidden') && c.ai_id===user.id) realtime.broadcast({type:'directory'});
          return send({ ok:true });
        }
        if (match[2] === 'messages' && method === 'GET') {
          const forward = url.searchParams.has('after');
          if (forward && url.searchParams.has('before')) fail(400,'不能同时指定前后游标');
          const value = Number(url.searchParams.get(forward?'after':'before') || (forward?0:Number.MAX_SAFE_INTEGER));
          if (!Number.isSafeInteger(value) || value < (forward?0:1)) fail(400, '无效消息游标');
          const size = pageSize(url,forward?100:50);
          const rows = db.prepare(`SELECT id,sender_id senderId,text,created_at createdAt,client_id clientMessageId,redacted FROM messages WHERE conversation_id=? AND id${forward?'>':'<'}? ORDER BY id ${forward?'ASC':'DESC'} LIMIT ?`).all(conversationId,value,size+1);
          const more = rows.length > size;
          const messages = rows.slice(0,size);
          if (!forward) messages.reverse();
          const peer=loadUser(c.user_id===user.id?c.ai_id:c.user_id);
          return send({ messages,hasMore:forward&&more,hasEarlier:!forward&&more,cursor:messages.at(-1)?.id || (forward?value:0),historyVersion:c.history_version,peerName:peer.nickname || peer.username,peerReadId:c.user_id===user.id?c.ai_read:c.user_read,peerUnavailable:!!peer.banned || !!peer.deleted_at,...blockState(user.id,peer.id) });
        }
        if (match[2] === 'messages' && method === 'POST') {
          const data = await body(req);
          const text = typeof data.text === 'string' ? data.text.trim() : '';
          if (!text || text.length > 2000) fail(400, '消息需为1–2000个字符');
          const clientId = typeof data.clientMessageId === 'string' ? data.clientMessageId : '';
          if (!/^[a-zA-Z0-9_-]{16,80}$/.test(clientId)) fail(400, '消息需要有效的客户端编号');
          const messageColumns = 'id,sender_id senderId,text,created_at createdAt,client_id clientMessageId,redacted';
          const existing = db.prepare(`SELECT ${messageColumns},conversation_id conversationId FROM messages WHERE sender_id=? AND client_id=?`).get(user.id,clientId);
          if (existing) {
            if (existing.conversationId !== conversationId || existing.text !== text) fail(409, '客户端编号已用于不同消息', 'CLIENT_ID_CONFLICT');
            delete existing.conversationId;
            return send({ messageId: existing.id, message: existing, replayed: true });
          }
          limit(`message:${user.id}`,30);
          const peer = c.user_id === user.id ? c.ai_id : c.user_id;
          if (blocked(user.id,peer)) fail(403, '已拉黑，无法发送消息');
          const peerUser=loadUser(peer);
          if (peerUser.banned || peerUser.deleted_at) fail(403, '对方账号不可用','PEER_UNAVAILABLE');
          const result = db.prepare('INSERT INTO messages(conversation_id,sender_id,text,created_at,client_id) VALUES(?,?,?,?,?)').run(conversationId,user.id,text,Date.now(),clientId);
          const message = db.prepare(`SELECT ${messageColumns} FROM messages WHERE id=?`).get(Number(result.lastInsertRowid));
          realtime.publish([c.user_id,c.ai_id],{type:'message',conversationId,messageId:message.id});
          return send({ messageId: message.id, message, replayed: false },201);
        }
        if (match[2] === 'read' && method === 'POST') {
          const data = await body(req);
          const messageId = id(data.messageId);
          if (!db.prepare('SELECT 1 FROM messages WHERE id=? AND conversation_id=?').get(messageId,conversationId)) fail(400,'消息不属于此对话');
          const column = c.user_id === user.id ? 'user_read' : 'ai_read';
          db.prepare(`UPDATE conversations SET ${column}=MAX(${column},?) WHERE id=?`).run(messageId,conversationId);
          if (messageId > c[column]) realtime.publish([c.user_id,c.ai_id],{type:'read',conversationId,userId:user.id,messageId});
          return send({ ok: true });
        }
      }
      if (path === '/blocks' && method === 'POST') {
        const data = await body(req);
        const target = id(data.userId);
        if (target === user.id || !db.prepare('SELECT 1 FROM users WHERE id=?').get(target)) fail(400,'无效账号');
        if (data.blocked === true) db.prepare('INSERT OR IGNORE INTO blocks VALUES(?,?)').run(user.id,target);
        else if (data.blocked === false) db.prepare('DELETE FROM blocks WHERE user_id=? AND target_id=?').run(user.id,target);
        else fail(400,'无效拉黑状态');
        realtime.publish([user.id,target],{type:'block'});
        realtime.broadcast({type:'directory'});
        return send({ ok: true });
      }
      fail(404,'接口不存在');
    } catch (error) {
      if (!error.status) console.error('Request failed', { type: error.name, code: error.code || 'INTERNAL_ERROR' });
      if (!res.headersSent) send({ error: error.status ? error.message : '服务暂时不可用', code: error.code || (error.status ? 'REQUEST_FAILED' : 'SERVER_UNAVAILABLE') },error.status || 500);
      else res.end();
    }
  });
  realtime = createRealtime(server,{authenticate,authorizeView:participant,limit:req=>limit(`ws:${clientIp(req,trustedProxies)}`,30),onPresence:()=>realtime.broadcast({type:'directory'}),heartbeatMs,timeoutMs,allowedOrigin});
  const closeHttp = server.close.bind(server);
  server.close = callback => { realtime.close(); return closeHttp(callback); };
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.once('close', () => { clearInterval(cleanup); db.close(); });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let server;
  try {
    const config=startupConfig();
    server = createApp(config);
    server.listen(config.port,config.host,() => console.log(JSON.stringify({level:'info',code:'SERVER_STARTED',port:config.port,version:'2.0.0',schemaVersion:SCHEMA_VERSION})));
    server.on('error',error=>{console.error(JSON.stringify({level:'error',code:error.code || 'SERVER_ERROR'}));process.exitCode=1;});
  } catch(error) {
    console.error(JSON.stringify({level:'error',code:error.code || 'STARTUP_FAILED',message:error.publicMessage?error.message:'启动失败，请检查数据库、磁盘和操作说明'}));
    process.exitCode=1;
  }
  if (!server) process.exit(1);
  let closing = false;
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => {
    if (closing) return;
    closing = true;
    server.close(() => { process.exitCode = 0; });
    setTimeout(() => process.exit(1),10_000).unref();
  });
}
