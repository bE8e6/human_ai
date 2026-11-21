export function configuredMail({ apiKey = process.env.MAIL_API_KEY || '',from = process.env.MAIL_FROM || '' } = {}) {
  if (!apiKey || !from) return null;
  return async ({to,subject,text}) => {
    const response = await fetch('https://api.resend.com/emails',{
      method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},
      body:JSON.stringify({from,to:[to],subject,text}),signal:AbortSignal.timeout(8000)
    });
    if (!response.ok) throw Object.assign(new Error('邮件服务暂时不可用'),{code:'MAIL_DELIVERY_FAILED'});
  };
}
