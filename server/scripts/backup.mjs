import { resolve } from 'node:path';
import { createBackup, listBackups, verifyBackup, restoreBackup } from '../backup.mjs';

const args=process.argv.slice(2),action=args.shift();
function option(name) {const index=args.indexOf(name);return index<0?undefined:args[index+1];}
try {
  let result;
  if (action==='create') result=await createBackup({dbPath:resolve(args[0] || process.env.DB_PATH || 'data/chat.db'),backupDir:resolve(args[1] || process.env.BACKUP_DIR || 'backups')});
  else if (action==='list') result=listBackups(resolve(args[0] || process.env.BACKUP_DIR || 'backups')).map(entry=>({file:entry.file,createdAt:entry.createdAt,counts:entry.counts}));
  else if (action==='verify') result=await verifyBackup(resolve(args[0]));
  else if (action==='restore') result=await restoreBackup({backupPath:resolve(args[0]),targetPath:resolve(args[1] || process.env.DB_PATH || 'data/chat.db'),
    latestJournalPath:option('--latest-journal'),replace:args.includes('--replace'),stopped:args.includes('--stopped'),preserveSchema:args.includes('--preserve-schema')});
  else throw Object.assign(new Error('用法：backup.mjs create <db> <dir> | list <dir> | verify <backup.db> | restore <backup.db> <target.db> --latest-journal <path> --stopped [--replace]'),{publicMessage:true,code:'INVALID_BACKUP_COMMAND'});
  console.log(JSON.stringify(result,null,2));
} catch(error) {
  console.error(JSON.stringify({level:'error',code:error.code || 'BACKUP_FAILED',message:error.publicMessage?error.message:'备份或恢复失败，请检查数据库、磁盘和操作说明'}));process.exitCode=1;
}
