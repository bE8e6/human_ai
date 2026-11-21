import { isIP } from 'node:net';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export function startupConfig(env=process.env) {
  const production=env.NODE_ENV==='production',port=Number(env.PORT || 8787);
  function invalid(message) {throw Object.assign(new Error(message),{code:'CONFIG_INVALID',publicMessage:true});}
  if (!Number.isInteger(port) || port<1 || port>65535) invalid('PORT需为1–65535');
  const allowedOrigin=env.PUBLIC_ORIGIN || '';
  if (allowedOrigin) {
    let url;try{url=new URL(allowedOrigin);}catch{invalid('PUBLIC_ORIGIN需为完整服务地址');}
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.pathname!=='/' || url.search || url.hash) invalid('PUBLIC_ORIGIN只能包含协议、主机和端口');
    if (production && url.protocol!=='https:') invalid('公开服务需要HTTPS的PUBLIC_ORIGIN');
  } else if (production) invalid('公开服务需要配置PUBLIC_ORIGIN');
  const passwordHash=env.ADMIN_PASSWORD_HASH || '';
  if ((production || passwordHash) && !/^[^:\s]{1,128}:[a-f0-9]{128}$/.test(passwordHash)) invalid('请配置ADMIN_PASSWORD_HASH；使用hash-admin.mjs生成密码摘要');
  const metricsKey=env.METRICS_KEY || '';
  if ((production || metricsKey) && metricsKey.length<32) invalid('METRICS_KEY至少需要32位随机字符');
  if ((env.MAIL_API_KEY || env.MAIL_FROM) && (!env.MAIL_API_KEY || !env.MAIL_FROM || (env.MAIL_CODE_SECRET || '').length<32)) invalid('启用邮件需同时配置MAIL_API_KEY、MAIL_FROM和至少32位MAIL_CODE_SECRET');
  const trustedProxies=(env.TRUSTED_PROXIES || '').split(',').map(ip=>ip.trim()).filter(Boolean);
  if (trustedProxies.some(ip=>!isIP(ip))) invalid('TRUSTED_PROXIES需要填写明确的代理IP，以逗号分隔');
  return {host:env.HOST || '127.0.0.1',port,dbPath:resolve(env.DB_PATH || resolve(dirname(fileURLToPath(import.meta.url)),'data/chat.db')),
    adminUsername:env.ADMIN_USERNAME || 'operator',adminPasswordHash:passwordHash,metricsKey,allowedOrigin,trustedProxies};
}
