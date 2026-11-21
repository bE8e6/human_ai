import { resolve } from 'node:path';
import { createBackup } from '../backup.mjs';
import { alert } from './alerts.mjs';

const hours=Number(process.env.BACKUP_INTERVAL_HOURS || 24);
if (!Number.isFinite(hours) || hours<1 || hours>168) throw new Error('备份间隔需为1–168小时');
let closing=false,timer;
for (const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>{closing=true;if(timer)clearTimeout(timer);});
async function run() {
  try {
    const result=await createBackup({dbPath:resolve(process.env.DB_PATH || 'data/chat.db'),backupDir:resolve(process.env.BACKUP_DIR || 'backups')});
    console.log(JSON.stringify({level:'info',code:'BACKUP_CREATED',file:result.file,at:result.createdAt,counts:result.counts}));
    if (!closing) timer=setTimeout(run,hours*3600_000);
  } catch {
    await alert('BACKUP_FAILED','自动备份失败，请检查持久化目录和磁盘空间。');
    if (!closing) timer=setTimeout(run,60_000);
  }
}
await run();
