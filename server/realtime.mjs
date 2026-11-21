import { WebSocketServer, WebSocket } from 'ws';

export function createRealtime(server, { authenticate, authorizeView, limit, onPresence, heartbeatMs = 15_000, timeoutMs = 45_000, allowedOrigin = '' }) {
  const wss = new WebSocketServer({ noServer: true,maxPayload:4096,perMessageDeflate:false,clientTracking:false });
  const clients = new Set();
  let closed = false;
  function send(client, event) {
    if (client.ws.readyState !== WebSocket.OPEN) return;
    if (client.ws.bufferedAmount > 65_536) { client.ws.terminate(); return; }
    client.ws.send(JSON.stringify(event));
  }
  function invalidate(client, error) {
    send(client,{type:'auth_invalid',code:error.code || 'SESSION_EXPIRED',error:error.message || '登录已失效'});
    client.ws.close(4001,'Session invalid');
    // Do not retain an unauthorized upgraded connection during the closing handshake.
    client.ws.terminate();
  }
  function revalidate() {
    for (const client of clients) {
      try { authenticate(client.digest); }
      catch (error) { invalidate(client,error); }
    }
  }
  const heartbeat = setInterval(() => {
    revalidate();
    for (const client of clients) {
      if (Date.now()-client.lastPong > timeoutMs) { client.ws.terminate(); continue; }
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.ping();
        send(client,{type:'ping',at:Date.now()});
      }
    }
  },heartbeatMs);
  heartbeat.unref();
  server.on('upgrade',(req,socket,head) => {
    try {
      if (closed || new URL(req.url,'http://localhost').pathname !== '/realtime') throw Object.assign(new Error('接口不存在'),{status:404});
      if (req.headers.origin && allowedOrigin && req.headers.origin !== allowedOrigin) throw Object.assign(new Error('来源不允许'),{status:403});
      limit(req);
      const identity = authenticate(null,req);
      const active = [...clients].filter(c=>c.userId===identity.user.id).length;
      if (active >= 8) throw Object.assign(new Error('实时连接设备过多'),{status:429});
      wss.handleUpgrade(req,socket,head,ws => {
        const client = {ws,digest:identity.digest,userId:identity.user.id,view:0,lastPong:Date.now(),messages:0,window:Date.now()};
        clients.add(client);
        ws.on('pong',()=> { client.lastPong=Date.now(); });
        ws.on('message',data => {
          try {
            authenticate(client.digest);
            if (Date.now()-client.window > 60_000) { client.messages=0; client.window=Date.now(); }
            if (++client.messages > 120) { ws.close(1008,'Rate limit'); return; }
            const value = JSON.parse(data.toString());
            if (value.type === 'pong') client.lastPong=Date.now();
            else if (value.type === 'ping') { client.lastPong=Date.now(); send(client,{type:'pong'}); }
            else if (value.type === 'view') {
              if (!Number.isSafeInteger(value.conversationId) || value.conversationId < 0) throw new Error('Invalid view');
              if (value.conversationId) authorizeView(value.conversationId,client.userId);
              client.view=value.conversationId;
            } else ws.close(1008,'Unsupported event');
          } catch (error) {
            if (error.status === 401) invalidate(client,error);
            else ws.close(1008,'Invalid event');
          }
        });
        ws.on('error',()=> {});
        ws.on('close',()=> { clients.delete(client); onPresence(client.userId); });
        send(client,{type:'ready',heartbeatMs,timeoutMs});
        onPresence(client.userId);
      });
    } catch (error) {
      const status = error.status || 401;
      socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    }
  });
  function publish(userIds,event) { for (const client of clients) if (userIds.includes(client.userId)) send(client,event); }
  function broadcast(event) { for (const client of clients) send(client,event); }
  function isOnline(userId) { return [...clients].some(c=>c.userId===userId && c.ws.readyState===WebSocket.OPEN && Date.now()-c.lastPong<=timeoutMs); }
  function onlineIds() { return [...new Set([...clients].filter(c=>c.ws.readyState===WebSocket.OPEN && Date.now()-c.lastPong<=timeoutMs).map(c=>c.userId))]; }
  function isViewing(userId,conversationId) { return [...clients].some(c=>c.userId===userId && c.view===conversationId && c.ws.readyState===WebSocket.OPEN); }
  function close() {
    if (closed) return;
    closed=true; clearInterval(heartbeat);
    for (const client of clients) { client.ws.close(1001,'Server shutting down'); client.ws.terminate(); }
    wss.close();
  }
  server.once('close',close);
  return { publish,broadcast,revalidate,isOnline,onlineIds,isViewing,close };
}
