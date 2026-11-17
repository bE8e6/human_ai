import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function createApp({ dbPath = resolve(dirname(fileURLToPath(import.meta.url)), 'data/chat.db'), adminKey = process.env.ADMIN_KEY || '' } = {}) {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL, accepting INTEGER NOT NULL DEFAULT 0, banned INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS conversations(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), ai_id INTEGER NOT NULL REFERENCES users(id), user_read INTEGER NOT NULL DEFAULT 0, ai_read INTEGER NOT NULL DEFAULT 0, UNIQUE(user_id,ai_id), CHECK(user_id != ai_id));
    CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL REFERENCES conversations(id), sender_id INTEGER NOT NULL REFERENCES users(id), text TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id,id);
    CREATE TABLE IF NOT EXISTS blocks(user_id INTEGER NOT NULL REFERENCES users(id), target_id INTEGER NOT NULL REFERENCES users(id), PRIMARY KEY(user_id,target_id));
    CREATE TABLE IF NOT EXISTS reports(id INTEGER PRIMARY KEY, reporter_id INTEGER NOT NULL REFERENCES users(id), message_id INTEGER NOT NULL REFERENCES messages(id), reason TEXT NOT NULL, created_at INTEGER NOT NULL);
  `);
  const rates = new Map();
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, value] of rates) if (value.until < now) rates.delete(key);
    db.prepare('DELETE FROM sessions WHERE expires < ?').run(now);
  }, 60_000);
  cleanup.unref();
  function limit(key, count, period = 60_000) {
    const now = Date.now();
    let value = rates.get(key);
    if (!value || value.until < now) { value = { count: 0, until: now + period }; rates.set(key, value); }
    if (++value.count > count) fail(429, '操作太频繁，请稍后再试');
  }
  function fail(status, message) { throw Object.assign(new Error(message), { status }); }
  function id(value) {
    const result = Number(value);
    if (!Number.isSafeInteger(result) || result < 1) fail(400, '无效编号');
    return result;
  }
  function publicUser(user) { return { id: user.id, username: user.username, accepting: !!user.accepting }; }
  function issueSession(user) {
    const token = randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(token, user.id, Date.now() + 7 * 86400_000);
    return { token, user: publicUser(user) };
  }
  function participant(conversationId, userId) {
    const c = db.prepare('SELECT * FROM conversations WHERE id=?').get(conversationId);
    if (!c || (c.user_id !== userId && c.ai_id !== userId)) fail(404, '对话不存在');
    return c;
  }
  function blocked(a, b) {
    return !!db.prepare('SELECT 1 FROM blocks WHERE (user_id=? AND target_id=?) OR (user_id=? AND target_id=?)').get(a,b,b,a);
  }
  async function body(req) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 16_384) fail(413, '请求过大');
      chunks.push(chunk);
    }
    try {
      const value = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, '无效请求');
      return value;
    } catch { fail(400, '无效 JSON 请求'); }
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    function send(data, status = 200) { res.writeHead(status); res.end(JSON.stringify(data)); }
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      const method = req.method;
      const ip = req.socket.remoteAddress;
      limit(`ip:${ip}`, 600);
      if (path === '/health' && method === 'GET') return send({ ok: true, name: '人机？' });
      if ((path === '/auth/register' || path === '/auth/login') && method === 'POST') {
        limit(`auth:${ip}`, 20);
        const data = await body(req);
        const username = typeof data.username === 'string' ? data.username.trim().toLowerCase() : '';
        const password = typeof data.password === 'string' ? data.password : '';
        if (!/^[a-z0-9_]{3,24}$/.test(username) || password.length < 8 || password.length > 128) fail(400, '用户名需为3–24位字母、数字或下划线，密码需为8–128位');
        if (path === '/auth/register') {
          limit(`register:${ip}`, 5, 3600_000);
          if (db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) fail(409, '用户名已被注册');
          const salt = randomBytes(16).toString('hex');
          const passwordHash = `${salt}:${scryptSync(password,salt,64).toString('hex')}`;
          const result = db.prepare('INSERT INTO users(username,password) VALUES(?,?)').run(username,passwordHash);
          return send(issueSession(db.prepare('SELECT * FROM users WHERE id=?').get(Number(result.lastInsertRowid))),201);
        }
        const user = db.prepare('SELECT * FROM users WHERE username=?').get(username);
        // 未注册用户名也计算哈希，避免明显的耗时差异。
        const [salt, hash] = user ? user.password.split(':') : ['missing-user-salt', '00'.repeat(64)];
        if (!timingSafeEqual(scryptSync(password,salt,64),Buffer.from(hash,'hex')) || !user) fail(401, '用户名或密码错误');
        if (user.banned) fail(403, '账号已被禁用');
        return send(issueSession(user));
      }
      if (path.startsWith('/admin/')) {
        if (!adminKey || req.headers['x-admin-key'] !== adminKey) fail(403, '管理员验证失败');
        if (path === '/admin/reports' && method === 'GET') return send({ reports: db.prepare('SELECT r.*,m.text,m.sender_id FROM reports r JOIN messages m ON m.id=r.message_id ORDER BY r.id DESC LIMIT 100').all() });
        if (path === '/admin/ban' && method === 'POST') {
          const data = await body(req);
          const target = id(data.userId);
          db.prepare('UPDATE users SET banned=1,accepting=0 WHERE id=?').run(target);
          db.prepare('DELETE FROM sessions WHERE user_id=?').run(target);
          return send({ ok: true });
        }
        fail(404, '接口不存在');
      }
      const token = (req.headers.authorization || '').replace(/^Bearer /, '');
      const user = db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>? AND u.banned=0').get(token,Date.now());
      if (!user) fail(401, '请重新登录');
      if (path === '/me' && method === 'GET') return send({ user: publicUser(user) });
      if (path === '/auth/logout' && method === 'POST') {
        db.prepare('DELETE FROM sessions WHERE token=?').run(token);
        return send({ ok: true });
      }
      if (path === '/me/accepting' && method === 'POST') {
        const data = await body(req);
        if (typeof data.accepting !== 'boolean') fail(400, '无效状态');
        db.prepare('UPDATE users SET accepting=? WHERE id=?').run(data.accepting ? 1 : 0,user.id);
        return send({ ok: true });
      }
      if (path === '/ais' && method === 'GET') {
        return send({ users: db.prepare(`SELECT id,username,accepting FROM users u WHERE accepting=1 AND banned=0 AND id!=? AND NOT EXISTS(SELECT 1 FROM blocks b WHERE (b.user_id=? AND b.target_id=u.id) OR (b.target_id=? AND b.user_id=u.id)) ORDER BY id DESC LIMIT 100`).all(user.id,user.id,user.id).map(publicUser) });
      }
      if (path === '/conversations' && method === 'POST') {
        limit(`new:${user.id}`, 10);
        const data = await body(req);
        const aiId = id(data.aiId);
        if (aiId === user.id) fail(400, '不能和自己聊天');
        if (blocked(user.id,aiId)) fail(403, '已拉黑，无法发起对话');
        const ai = db.prepare('SELECT * FROM users WHERE id=? AND banned=0').get(aiId);
        if (!ai || !ai.accepting) fail(409, '对方暂不接收新对话');
        db.prepare('INSERT OR IGNORE INTO conversations(user_id,ai_id) VALUES(?,?)').run(user.id,aiId);
        return send({ conversationId: db.prepare('SELECT id FROM conversations WHERE user_id=? AND ai_id=?').get(user.id,aiId).id });
      }
      if (path === '/conversations' && method === 'GET') {
        const role = url.searchParams.get('role');
        if (role !== 'user' && role !== 'ai') fail(400, '无效身份');
        const column = role === 'user' ? 'user_id' : 'ai_id';
        const readColumn = role === 'user' ? 'user_read' : 'ai_read';
        const other = role === 'user' ? 'ai_id' : 'user_id';
        const conversations = db.prepare(`SELECT c.id,u.id peerId,u.username peerName,
          COALESCE((SELECT text FROM messages WHERE conversation_id=c.id ORDER BY id DESC LIMIT 1),'还没有消息') lastText,
          (SELECT COUNT(*) FROM messages WHERE conversation_id=c.id AND sender_id!=? AND id>c.${readColumn}) unread
          FROM conversations c JOIN users u ON u.id=c.${other} WHERE c.${column}=?
          ORDER BY COALESCE((SELECT MAX(id) FROM messages WHERE conversation_id=c.id),0) DESC,c.id DESC LIMIT 100`).all(user.id,user.id);
        return send({ conversations });
      }
      const match = path.match(/^\/conversations\/(\d+)\/(messages|read)$/);
      if (match) {
        const conversationId = id(match[1]);
        const c = participant(conversationId,user.id);
        if (match[2] === 'messages' && method === 'GET') {
          const after = Number(url.searchParams.get('after') || 0);
          if (!Number.isSafeInteger(after) || after < 0) fail(400, '无效消息游标');
          const messages = db.prepare('SELECT id,sender_id senderId,text,created_at createdAt FROM messages WHERE conversation_id=? AND id>? ORDER BY id LIMIT 100').all(conversationId,after);
          return send({ messages, hasMore: messages.length === 100 });
        }
        if (match[2] === 'messages' && method === 'POST') {
          limit(`message:${user.id}`,30);
          const peer = c.user_id === user.id ? c.ai_id : c.user_id;
          if (blocked(user.id,peer)) fail(403, '已拉黑，无法发送消息');
          if (db.prepare('SELECT banned FROM users WHERE id=?').get(peer).banned) fail(403, '对方账号不可用');
          const data = await body(req);
          const text = typeof data.text === 'string' ? data.text.trim() : '';
          if (!text || text.length > 2000) fail(400, '消息需为1–2000个字符');
          const result = db.prepare('INSERT INTO messages(conversation_id,sender_id,text,created_at) VALUES(?,?,?,?)').run(conversationId,user.id,text,Date.now());
          return send({ messageId: Number(result.lastInsertRowid) },201);
        }
        if (match[2] === 'read' && method === 'POST') {
          const data = await body(req);
          const messageId = id(data.messageId);
          if (!db.prepare('SELECT 1 FROM messages WHERE id=? AND conversation_id=?').get(messageId,conversationId)) fail(400,'消息不属于此对话');
          const column = c.user_id === user.id ? 'user_read' : 'ai_read';
          db.prepare(`UPDATE conversations SET ${column}=MAX(${column},?) WHERE id=?`).run(messageId,conversationId);
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
        return send({ ok: true });
      }
      if (path === '/reports' && method === 'POST') {
        limit(`report:${user.id}`,5);
        const data = await body(req);
        const messageId = id(data.messageId);
        const message = db.prepare('SELECT * FROM messages WHERE id=?').get(messageId);
        if (!message) fail(404,'消息不存在');
        participant(message.conversation_id,user.id);
        if (message.sender_id === user.id) fail(400,'不能举报自己的消息');
        const reason = typeof data.reason === 'string' ? data.reason.trim() : '';
        if (!reason || reason.length > 300) fail(400,'举报原因需为1–300个字符');
        db.prepare('INSERT INTO reports(reporter_id,message_id,reason,created_at) VALUES(?,?,?,?)').run(user.id,messageId,reason,Date.now());
        return send({ ok: true },201);
      }
      fail(404,'接口不存在');
    } catch (error) {
      if (!error.status) console.error('Request failed:', error.message);
      if (!res.headersSent) send({ error: error.status ? error.message : '服务暂时不可用' },error.status || 500);
      else res.end();
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.once('close', () => { clearInterval(cleanup); db.close(); });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createApp();
  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || '127.0.0.1';
  server.listen(port,host,() => console.log(`人机？后端已启动：http://${host}:${port}/health\n数据库：server/data/chat.db；按 Ctrl+C 停止。`));
}
