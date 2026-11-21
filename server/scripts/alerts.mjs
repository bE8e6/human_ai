export async function alert(code,summary,level='warning') {
  const event={level,code,summary,at:new Date().toISOString()};
  console[level==='info'?'log':'error'](JSON.stringify(event));
  const webhook=process.env.ALERT_WEBHOOK || '';
  if (!webhook) return;
  try {
    if (new URL(webhook).protocol!=='https:') throw new Error();
    const response=await fetch(webhook,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(event),signal:AbortSignal.timeout(5000)});
    if (!response.ok) throw new Error();
  } catch {console.error(JSON.stringify({level:'error',code:'ALERT_DELIVERY_FAILED',at:event.at}));}
}
