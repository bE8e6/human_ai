import { createHash, randomBytes } from 'node:crypto';

// Every migration is atomic. Opening a newer database with older code fails closed.
export const SCHEMA_VERSION = 6;

export function migrate(db) {
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > SCHEMA_VERSION) throw new Error('数据库版本高于本服务支持的版本，请使用对应版本的服务或恢复升级前备份');
  const migrations = [
    () => db.exec(`
      CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL, accepting INTEGER NOT NULL DEFAULT 0, banned INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), ai_id INTEGER NOT NULL REFERENCES users(id), user_read INTEGER NOT NULL DEFAULT 0, ai_read INTEGER NOT NULL DEFAULT 0, UNIQUE(user_id,ai_id), CHECK(user_id != ai_id));
      CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL REFERENCES conversations(id), sender_id INTEGER NOT NULL REFERENCES users(id), text TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id,id);
      CREATE TABLE IF NOT EXISTS blocks(user_id INTEGER NOT NULL REFERENCES users(id), target_id INTEGER NOT NULL REFERENCES users(id), PRIMARY KEY(user_id,target_id));
      CREATE TABLE IF NOT EXISTS reports(id INTEGER PRIMARY KEY, reporter_id INTEGER NOT NULL REFERENCES users(id), message_id INTEGER NOT NULL REFERENCES messages(id), reason TEXT NOT NULL, created_at INTEGER NOT NULL);
    `),
    () => {
      db.exec(`
        ALTER TABLE messages ADD COLUMN client_id TEXT;
        CREATE UNIQUE INDEX messages_client_id ON messages(sender_id,client_id) WHERE client_id IS NOT NULL;
        ALTER TABLE sessions ADD COLUMN device_id TEXT NOT NULL DEFAULT '';
        ALTER TABLE sessions ADD COLUMN device_name TEXT NOT NULL DEFAULT '旧版设备';
        ALTER TABLE sessions ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE sessions ADD COLUMN last_seen INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE sessions ADD COLUMN revoked_reason TEXT;
        ALTER TABLE sessions ADD COLUMN session_id TEXT;
        CREATE INDEX sessions_user ON sessions(user_id);
        CREATE UNIQUE INDEX sessions_id ON sessions(session_id);
      `);
      // Preserve V1 sessions while replacing plaintext tokens with SHA-256 digests.
      for (const row of db.prepare('SELECT token FROM sessions').all()) {
        db.prepare('UPDATE sessions SET token=?,session_id=? WHERE token=?').run(tokenDigest(row.token), randomBytes(12).toString('hex'), row.token);
      }
    },
    () => db.exec(`
      ALTER TABLE conversations ADD COLUMN last_message_id INTEGER NOT NULL DEFAULT 0;
      UPDATE conversations SET last_message_id=COALESCE((SELECT MAX(id) FROM messages WHERE conversation_id=conversations.id),0);
      CREATE INDEX conversations_user_activity ON conversations(user_id,last_message_id DESC,id DESC);
      CREATE INDEX conversations_ai_activity ON conversations(ai_id,last_message_id DESC,id DESC);
      CREATE TABLE conversation_settings(conversation_id INTEGER NOT NULL REFERENCES conversations(id),user_id INTEGER NOT NULL REFERENCES users(id),hidden INTEGER NOT NULL DEFAULT 0,pinned INTEGER NOT NULL DEFAULT 0,muted INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(conversation_id,user_id));
      CREATE TRIGGER messages_activity AFTER INSERT ON messages BEGIN
        UPDATE conversations SET last_message_id=NEW.id WHERE id=NEW.conversation_id;
        UPDATE conversation_settings SET hidden=0 WHERE conversation_id=NEW.conversation_id;
      END;
    `),
    () => db.exec(`
      ALTER TABLE users ADD COLUMN nickname TEXT NOT NULL DEFAULT '';
      ALTER TABLE users ADD COLUMN bio TEXT NOT NULL DEFAULT '';
      ALTER TABLE users ADD COLUMN ai_style TEXT NOT NULL DEFAULT '';
      ALTER TABLE users ADD COLUMN ai_topics TEXT NOT NULL DEFAULT '';
      ALTER TABLE users ADD COLUMN busy INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN max_chats INTEGER NOT NULL DEFAULT 10;
      ALTER TABLE users ADD COLUMN email TEXT;
      ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN notification_enabled INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE users ADD COLUMN notification_preview INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE users ADD COLUMN deleted_at INTEGER;
      ALTER TABLE users ADD COLUMN banned_until INTEGER;
      ALTER TABLE users ADD COLUMN ban_reason TEXT NOT NULL DEFAULT '';
      UPDATE users SET nickname=username;
      CREATE UNIQUE INDEX users_email ON users(email) WHERE email IS NOT NULL;
      CREATE TABLE email_challenges(id TEXT PRIMARY KEY,user_id INTEGER REFERENCES users(id),email TEXT NOT NULL,purpose TEXT NOT NULL,code_hash TEXT NOT NULL,expires INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,used_at INTEGER,created_at INTEGER NOT NULL);
      CREATE INDEX email_challenges_user ON email_challenges(user_id);
      CREATE TABLE rate_limits(key TEXT PRIMARY KEY,count INTEGER NOT NULL,until INTEGER NOT NULL);
    `),
    () => db.exec(`
      ALTER TABLE messages ADD COLUMN redacted INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE reports ADD COLUMN category TEXT NOT NULL DEFAULT 'other';
      ALTER TABLE reports ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';
      ALTER TABLE reports ADD COLUMN result TEXT NOT NULL DEFAULT '';
      ALTER TABLE reports ADD COLUMN handled_at INTEGER;
      ALTER TABLE reports ADD COLUMN handled_by TEXT NOT NULL DEFAULT '';
      ALTER TABLE reports ADD COLUMN evidence_text TEXT NOT NULL DEFAULT '';
      ALTER TABLE reports ADD COLUMN evidence_sender_id INTEGER;
      ALTER TABLE reports ADD COLUMN evidence_conversation_id INTEGER;
      UPDATE reports SET evidence_text=COALESCE((SELECT text FROM messages WHERE id=message_id),''),
        evidence_sender_id=(SELECT sender_id FROM messages WHERE id=message_id),
        evidence_conversation_id=(SELECT conversation_id FROM messages WHERE id=message_id);
      CREATE INDEX reports_reporter ON reports(reporter_id,id DESC);
      CREATE INDEX reports_status ON reports(status,id DESC);
      CREATE INDEX reports_duplicate ON reports(reporter_id,message_id);
      CREATE TABLE admin_sessions(token TEXT PRIMARY KEY,username TEXT NOT NULL,csrf TEXT NOT NULL,expires INTEGER NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE admin_audit(id INTEGER PRIMARY KEY,actor TEXT NOT NULL,action TEXT NOT NULL,target_id INTEGER,report_id INTEGER,reason TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL);
      CREATE INDEX admin_audit_time ON admin_audit(created_at);
      CREATE TABLE account_notices(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),reason TEXT NOT NULL,created_at INTEGER NOT NULL,read_at INTEGER);
      CREATE INDEX account_notices_user ON account_notices(user_id,id DESC);
      CREATE TABLE account_deletions(user_id INTEGER PRIMARY KEY,identity_digest TEXT NOT NULL,deleted_at INTEGER NOT NULL);
    `),
    () => db.exec(`
      ALTER TABLE conversations ADD COLUMN history_version INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN policy_version TEXT NOT NULL DEFAULT '';
      ALTER TABLE users ADD COLUMN policy_accepted_at INTEGER NOT NULL DEFAULT 0;
    `)
  ];
  for (let i = version; i < SCHEMA_VERSION; i++) {
    db.exec('BEGIN IMMEDIATE');
    try {
      migrations[i]();
      db.exec(`PRAGMA user_version=${i + 1}; COMMIT;`);
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

export function tokenDigest(token) { return createHash('sha256').update(token).digest('hex'); }
