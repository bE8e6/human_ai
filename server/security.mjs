import { scrypt, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { isIP } from 'node:net';
const derive = promisify(scrypt);
export function secureEqual(a,b) {
  if (typeof a!=='string' || typeof b!=='string') return false;
  return timingSafeEqual(createHash('sha256').update(a).digest(),createHash('sha256').update(b).digest());
}
let passwordWork = 0;
async function passwordBytes(password,salt) {
  if (passwordWork >= 8) throw Object.assign(new Error('登录服务繁忙，请稍后重试'),{status:429,code:'AUTH_BUSY'});
  passwordWork++;
  try { return await derive(password,salt,64); }
  finally { passwordWork--; }
}
export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${(await passwordBytes(password,salt)).toString('hex')}`;
}
export async function verifyPassword(password,encoded) {
  // V1 also accepted non-hex salts. Preserve those hashes during migration.
  const valid = typeof encoded === 'string' && /^[^:\s]{1,128}:[a-f0-9]{128}$/.test(encoded);
  const [salt,hash] = valid ? encoded.split(':') : ['missing-user-salt','00'.repeat(64)];
  const result = timingSafeEqual(await passwordBytes(password,salt),Buffer.from(hash,'hex'));
  return valid && result;
}
function normalizeIp(value) { return value.startsWith('::ffff:') ? value.slice(7) : value; }
export function clientIp(req,trustedProxies=[]) {
  const remote = normalizeIp(req.socket.remoteAddress || 'unknown');
  const trusted = trustedProxies.map(normalizeIp);
  if (!trusted.includes(remote) || typeof req.headers['x-forwarded-for'] !== 'string') return remote;
  const chain = req.headers['x-forwarded-for'].split(',').map(value=>normalizeIp(value.trim()));
  if (chain.length > 10 || chain.some(value=>!isIP(value))) return remote;
  let current = remote;
  for (let i=chain.length-1;i>=0 && trusted.includes(current);i--) current=chain[i];
  return current;
}
