export async function readPassword(prompt='管理员密码（8–128位）：') {
  process.stdout.write(prompt);
  if (!process.stdin.isTTY) {
    let text='';for await(const chunk of process.stdin){text+=chunk;if(text.length>4096)throw new Error('输入过长');}
    return text.replace(/\r?\n$/,'');
  }
  return new Promise((resolve,reject)=>{
    let value='';process.stdin.setRawMode(true);process.stdin.resume();
    function finish(error) {
      process.stdin.off('data',data);process.stdin.setRawMode(false);process.stdin.pause();process.stdout.write('\n');
      if(error)reject(error);else resolve(value);
    }
    function data(chunk) {
      for(const char of chunk.toString()) {
        if(char==='\u0003') {finish(new Error('已取消'));return;}
        if(char==='\r' || char==='\n') {finish();return;}
        if(char==='\u007f' || char==='\b') {if(value.length){value=value.slice(0,-1);process.stdout.write('\b \b');}continue;}
        if(char.charCodeAt(0)>=32 && value.length<128) {value+=char;process.stdout.write('*');}
      }
    }
    process.stdin.on('data',data);
  });
}
