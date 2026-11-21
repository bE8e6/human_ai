import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../security.mjs';
import { readPassword } from './password-input.mjs';

const args=process.argv.slice(2),option=name=>{const i=args.indexOf(name);return i<0?'':args[i+1] || '';};
try {
  const environment=option('--environment') || 'test';
  if(!['test','production'].includes(environment))throw new Error();
  const output=resolve(option('--output') || fileURLToPath(new URL('../../deploy/.env.'+environment,import.meta.url)));
  if(existsSync(output)) {console.error('配置文件已存在，为避免覆盖密钥已停止。请直接编辑现有文件。');process.exit(1);}
  const domain=option('--domain');
  if(environment==='production' && (!domain || !/^[a-z0-9.-]+\.[a-z]{2,63}$/.test(domain) || domain.endsWith('.example.com'))) {
    console.error('公网配置需要 --domain 提供真实域名；尚无域名时先生成test配置。');process.exit(1);
  }
  const password=await readPassword();
  if(password.length<8 || password.length>128)throw new Error();
  const production=environment==='production',ip=production?'172.31.0.2':'172.30.0.2';
  const values={APP_ENV:environment,SERVICE_ENV:production?'production':'test',CHAT_IMAGE:'human-ai:2.0.0',
    LOCAL_PORT:production?'8787':'18787',PUBLIC_ORIGIN:production?'https://'+domain:'http://127.0.0.1:18787',
    DOMAIN:domain,NETWORK_SUBNET:production?'172.31.0.0/24':'172.30.0.0/24',PROXY_IP:ip,ADMIN_USERNAME:'operator',
    ADMIN_PASSWORD_HASH:await hashPassword(password),METRICS_KEY:randomBytes(32).toString('hex'),
    MAIL_API_KEY:'',MAIL_FROM:'',MAIL_CODE_SECRET:randomBytes(32).toString('hex'),BACKUP_INTERVAL_HOURS:'24',
    ALERT_WEBHOOK:'',MIN_FREE_MB:'512',MAX_DATA_MB:'1024',MAX_RSS_MB:'220'};
  mkdirSync(dirname(output),{recursive:true,mode:0o700});
  writeFileSync(output,Object.entries(values).map(([key,value])=>key+'='+value).join('\n')+'\n',{flag:'wx',mode:0o600});
  console.log('\n配置已写入 '+output+'。密码原文未保存，密钥未输出。');
} catch {console.error('配置未生成，请检查参数、密码长度与目录权限。');process.exitCode=1;}
