import { hashPassword } from '../security.mjs';
import { readPassword } from './password-input.mjs';
try {
  const password=await readPassword();
  if(password.length<8 || password.length>128)throw new Error('密码长度需为8–128位');
  console.log('\nADMIN_PASSWORD_HASH='+await hashPassword(password));
} catch {console.error('未生成密码摘要，请检查输入或重新操作。');process.exitCode=1;}
