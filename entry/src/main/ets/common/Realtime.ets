import { webSocket, connection } from '@kit.NetworkKit';
import { BusinessError } from '@kit.BasicServicesKit';

export interface RealtimeEvent { type: string; conversationId?: number; messageId?: number; userId?: number; code?: string; error?: string; }

export class RealtimeConnection {
  private socket?: webSocket.WebSocket;
  private active: boolean = false;
  private connected: boolean = false;
  private base: string = '';
  private token: string = '';
  private generation: number = 0;
  private backoff: number = 1000;
  private lastSignal: number = 0;
  private reconnectTimer: number = -1;
  private connectTimer: number = -1;
  private heartbeatTimer: number = -1;
  private view: number = 0;
  private onEvent: (event: RealtimeEvent) => void;
  private onStatus: (status: string) => void;
  constructor(onEvent: (event: RealtimeEvent) => void,onStatus: (status: string) => void) {
    this.onEvent = onEvent; this.onStatus = onStatus;
  }
  isConnected(): boolean { return this.connected; }
  start(base: string,token: string): void {
    if (this.active && this.base === base && this.token === token) return;
    this.stop(); this.base = base; this.token = token; this.active = true; this.backoff = 1000;
    this.connect();
  }
  stop(): void {
    this.active = false; this.connected = false; this.generation++;
    if (this.reconnectTimer >= 0) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = -1;
    this.releaseSocket();
    this.token = '';
  }
  setView(conversationId: number): void {
    this.view = conversationId;
    if (this.connected && this.socket) this.send(JSON.stringify({ type: 'view',conversationId: conversationId }));
  }
  private releaseSocket(): void {
    if (this.connectTimer >= 0) clearTimeout(this.connectTimer);
    if (this.heartbeatTimer >= 0) clearInterval(this.heartbeatTimer);
    this.connectTimer = -1; this.heartbeatTimer = -1;
    const socket = this.socket; this.socket = undefined;
    if (socket) {
      try {
        socket.off('open'); socket.off('message'); socket.off('error'); socket.off('close');
        socket.close().catch(() => {});
      } catch {}
    }
  }
  private connect(): void {
    if (!this.active) return;
    const ticket = ++this.generation;
    this.onStatus('connecting');
    try {
      const socket = webSocket.createWebSocket(); this.socket = socket;
      socket.on('open',(error: BusinessError) => {
        if (ticket !== this.generation || !this.active) return;
        if (error && error.code) { this.failed(ticket); return; }
        this.connected = true; this.backoff = 1000; this.lastSignal = Date.now();
        if (this.connectTimer >= 0) clearTimeout(this.connectTimer);
        this.connectTimer = -1;
        this.onStatus('connected'); this.setView(this.view);
        this.heartbeatTimer = setInterval(() => {
          if (Date.now()-this.lastSignal > 45_000) { this.failed(ticket); return; }
          this.send(JSON.stringify({ type: 'ping' }));
        },15_000);
      });
      socket.on('message',(error: BusinessError,value: string | ArrayBuffer) => {
        if (ticket !== this.generation || !this.active) return;
        if (error && error.code) { this.failed(ticket); return; }
        this.lastSignal = Date.now();
        if (typeof value !== 'string') return;
        try {
          const event = JSON.parse(value) as RealtimeEvent;
          if (event.type === 'ping') this.send(JSON.stringify({ type: 'pong' }));
          else if (event.type !== 'pong') this.onEvent(event);
        } catch {}
      });
      socket.on('error',() => { this.failed(ticket); });
      socket.on('close',() => { this.failed(ticket); });
      this.connectTimer = setTimeout(() => { this.failed(ticket); },8000);
      socket.connect(this.base.replace(/^http/,'ws').replace(/\/$/,'') + '/realtime',
        { header: { Authorization: 'Bearer ' + this.token } }).then((ok: boolean) => { if (!ok) this.failed(ticket); }).catch(() => { this.failed(ticket); });
    } catch { this.failed(ticket); }
  }
  private send(value: string): void {
    if (!this.socket || !this.connected) return;
    const ticket = this.generation;
    try { this.socket.send(value).catch(() => { this.failed(ticket); }); }
    catch { this.failed(ticket); }
  }
  private failed(ticket: number): void {
    if (ticket !== this.generation || !this.active || this.reconnectTimer >= 0) return;
    this.connected = false; this.releaseSocket(); this.onStatus('fallback');
    this.classifyNetwork(ticket);
    const delay = this.backoff + Math.floor(Math.random()*300);
    this.backoff = Math.min(this.backoff*2,30_000);
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = -1; this.connect(); },delay);
  }
  private async classifyNetwork(ticket: number): Promise<void> {
    try {
      const online = await connection.hasDefaultNet();
      if (ticket === this.generation && this.active && !this.connected) this.onStatus(online ? 'fallback' : 'offline');
    } catch {}
  }
}
