import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
try {
  const directory=process.env.BACKUP_DIR || 'backups',last=JSON.parse(readFileSync(join(directory,'last-success.json'),'utf8'));
  const hours=Number(process.env.BACKUP_INTERVAL_HOURS || 24);
  if (!Number.isSafeInteger(last.at) || Date.now()-last.at>(hours+2)*3600_000 || !/^chat-\d{8}T\d{6}Z-[a-f0-9]{8}\.db$/.test(last.file) ||
      !existsSync(join(directory,last.file+'.json'))) process.exitCode=1;
} catch {process.exitCode=1;}
