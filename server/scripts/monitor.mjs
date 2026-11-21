import { statfsSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { alert } from './alerts.mjs';

const origin=process.env.MONITOR_ORIGIN || 'http://server:8787',directory=process.env.DATA_DIR || '/data',backupDir=process.env.BACKUP_DIR || '/backups';
let failures=0,lastCode='',lastAlert=0,busy=false;
async function check() {
  if (busy) return;busy=true;
  try {
    let code='',summary='';
    try {
      const response=await fetch(origin+'/internal/metrics',{headers:{'X-Metrics-Key':process.env.METRICS_KEY || ''},signal:AbortSignal.timeout(5000)});
      if (!response.ok) throw new Error();
      const metrics=await response.json();
      const disk=statfsSync(directory),free=disk.bavail*disk.bsize;
      if (free<Number(process.env.MIN_FREE_MB || 512)*1024*1024) {code='DISK_SPACE_LOW';summary='磁盘剩余空间低于设定值，请清理或扩容。';}
      else if (metrics.databaseBytes>Number(process.env.MAX_DATA_MB || 1024)*1024*1024) {code='DATA_SIZE_HIGH';summary='数据库容量超过设定值，请检查存储与费用。';}
      else if (metrics.rssBytes>Number(process.env.MAX_RSS_MB || 220)*1024*1024) {code='MEMORY_HIGH';summary='服务内存接近容器限制，请检查负载。';}
      const last=JSON.parse(readFileSync(join(backupDir,'last-success.json'),'utf8'));
      if (Date.now()-last.at>(Number(process.env.BACKUP_INTERVAL_HOURS || 24)+2)*3600_000) {code='BACKUP_STALE';summary='自动备份已超期，请检查备份容器。';}
      statSync(join(backupDir,last.file+'.json'));
      failures=0;
    } catch {if(++failures>=3){code='SERVICE_MONITOR_FAILED';summary='连续三次未通过服务或备份检查，请查看容器健康状态。';}}
    if (code && (code!==lastCode || Date.now()-lastAlert>900_000)) {await alert(code,summary);lastCode=code;lastAlert=Date.now();}
    else if (!code && !failures && lastCode) {await alert('SERVICE_RECOVERED','服务与备份检查已恢复。','info');lastCode='';}
  } finally {busy=false;}
}
const timer=setInterval(check,60_000);
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>{clearInterval(timer);});
await check();
