import { common } from '@kit.AbilityKit';
import { util } from '@kit.ArkTS';
import { connection } from '@kit.NetworkKit';
import { KeyboardAvoidMode as AppKeyboardAvoidMode } from '@kit.ArkUI';
import { Api, ApiFailure, ApiResult, Account, Conversation, ChatMessage, PendingMessage, LoginDevice, UnreadTotals, UserReport, ServiceNotice } from '../common/Api';
import { AppConfig } from '../common/AppConfig';
import { POLICY_VERSION } from '../common/Policy';
import { LocalStore, SavedSession, ConversationDraft } from '../common/LocalStore';
import { MessageSource, MessageRow } from '../common/MessageSource';
import { RealtimeConnection, RealtimeEvent } from '../common/Realtime';
import { LoginPane } from '../components/LoginPane';
import { LobbyPane } from '../components/LobbyPane';
import { ChatPane } from '../components/ChatPane';
import { SettingsPane } from '../components/SettingsPane';
import { RecoveryPane } from '../components/RecoveryPane';
import { ManagementPane } from '../components/ManagementPane';
import { PolicyPane } from '../components/PolicyPane';
import { ReportPane } from '../components/ReportPane';

@Entry
@Preview
@Component
struct Index {
  @State baseUrl: string = AppConfig.defaultBase();
  @State username: string = '';
  @State password: string = '';
  @State loginMode: string = 'login';
  @State termsAccepted: boolean = false;
  @State token: string = '';
  @State myId: number = 0;
  @State myName: string = '';
  @State displayName: string = '';
  @State role: string = 'user';
  @State page: string = 'lobby';
  @State accepting: boolean = false;
  @State ais: Account[] = [];
  @State conversations: Conversation[] = [];
  @State unread: UnreadTotals = { user: 0, ai: 0 };
  @State conversationId: number = 0;
  @State peerId: number = 0;
  @State peerName: string = '';
  @State messages: ChatMessage[] = [];
  @State outbox: PendingMessage[] = [];
  @State rowCount: number = 0;
  @State draft: string = '';
  @State search: string = '';
  @State aiSort: string = 'recent';
  @State status: string = '';
  @State connection: string = '尚未连接';
  @State busy: boolean = false;
  @State restoring: boolean = true;
  @State loadingHistory: boolean = false;
  @State loadingMessages: boolean = false;
  @State hasEarlier: boolean = false;
  @State conversationHasMore: boolean = false;
  @State aiHasMore: boolean = false;
  @State newMessages: number = 0;
  @State peerReadId: number = 0;
  @State blocked: boolean = false;
  @State selfBlocked: boolean = false;
  @State peerUnavailable: boolean = false;
  @State muted: boolean = false;
  @State reportMessageId: number = 0;
  @State reportReason: string = '';
  @State reportCategory: string = 'harassment';
  @State currentPassword: string = '';
  @State newPassword: string = '';
  @State devices: LoginDevice[] = [];
  @State nickname: string = '';
  @State bio: string = '';
  @State aiStyle: string = '';
  @State aiTopics: string = '';
  @State aiBusy: boolean = false;
  @State activeChats: number = 0;
  @State maxChatsValue: number = 10;
  @State acceptingChoice: boolean = false;
  @State busyChoice: boolean = false;
  @State maxChats: string = '10';
  @State notificationEnabled: boolean = true;
  @State notificationPreview: boolean = true;
  @State profileDirty: boolean = false;
  @State availabilityDirty: boolean = false;
  @State preferencesDirty: boolean = false;
  @State boundEmail: string = '';
  @State emailVerified: boolean = false;
  @State emailInput: string = '';
  @State emailCode: string = '';
  @State emailChallengeId: string = '';
  @State emailExpiresAt: number = 0;
  @State mailAvailable: boolean = false;
  @State capabilitiesKnown: boolean = false;
  @State recoveryEmail: string = '';
  @State recoveryCode: string = '';
  @State recoveryPassword: string = '';
  @State recoveryChallengeId: string = '';
  @State recoveryExpiresAt: number = 0;
  @State managementKind: string = 'blocks';
  @State blockedUsers: Account[] = [];
  @State reports: UserReport[] = [];
  @State notices: ServiceNotice[] = [];
  @State managementLoading: boolean = false;
  @State managementHasMore: boolean = false;
  @State policyKind: string = 'privacy';
  @StorageLink('appActive') @Watch('activityChanged') appActive: boolean = true;
  private store?: LocalStore;
  private drafts: ConversationDraft[] = [];
  private source: MessageSource = new MessageSource();
  private scroller: Scroller = new Scroller();
  private timer: number = -1;
  private draftTimer: number = -1;
  private readTimer: number = -1;
  private accountEpoch: number = 0;
  private viewEpoch: number = 0;
  private authAttempt: number = 0;
  private refreshingEpoch: number = -1;
  private drainingEpoch: number = -1;
  private nextOrder: number = 1;
  private syncCursor: number = 0;
  private historyVersion: number = 0;
  private initializedMessages: boolean = false;
  private lastReadId: number = 0;
  private visibleReadId: number = 0;
  private atBottom: boolean = true;
  private nextConversationCursor: string = '';
  private nextAiCursor: string = '';
  private storageReady: boolean = false;
  private realtime?: RealtimeConnection;
  private needsRefresh: boolean = false;
  private networkError: boolean = false;
  private managementCursor: string = '';
  private policyReturnPage: string = 'lobby';
  private conversationQuery: string = '';
  private conversationRole: string = '';
  private aiQuery: string = '';
  private aiSortSnapshot: string = '';

  aboutToAppear(): void { this.prepare(); }
  onPageShow(): void { this.startPolling(); this.startRealtime(); this.refresh(); }
  onPageHide(): void { this.stopPolling(); this.persistDraft(); if (this.realtime) this.realtime.stop(); }
  aboutToDisappear(): void {
    this.stopPolling(); this.persistDraft(); this.viewEpoch++;
    if (this.realtime) this.realtime.stop();
    if (this.readTimer >= 0) clearTimeout(this.readTimer);
  }
  onBackPress(): boolean {
    if (this.page==='policy') {this.backPolicy();return true;}
    if (!this.token && this.loginMode==='recovery') {this.backRecovery();return true;}
    if (this.reportMessageId>0) {this.cancelReport();return true;}
    if (this.conversationId > 0) { this.closeChat(); return true; }
    if (this.page==='manage') {this.page='settings';this.viewEpoch++;return true;}
    if (this.page !== 'lobby') { this.page = 'lobby'; this.viewEpoch++; this.refresh(); return true; }
    return false;
  }
  private async prepare(): Promise<void> {
    const attempt = this.authAttempt;
    try {
      const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
      if (!context) return;
      this.getUIContext().setKeyboardAvoidMode(AppKeyboardAvoidMode.RESIZE);
      const store = new LocalStore(context);
      await store.initialize(context);
      this.store = store;
      const base = await store.getBase();
      if (attempt !== this.authAttempt) return;
      if (base && AppConfig.development) this.baseUrl = base;
      const saved = await store.readSession();
      if (attempt !== this.authAttempt || !saved) return;
      if (!AppConfig.development && saved.base!==AppConfig.serviceUrl) {await this.logout('服务地址已更新，请重新登录');return;}
      if (saved.expiresAt <= Date.now()) { await this.logout('登录已过期，请重新登录'); return; }
      await this.bindSession(saved,attempt);
      if (attempt !== this.authAttempt) return;
      this.restoring = false;
      this.startPolling(); this.startRealtime();
      await this.refresh();
    } catch (error) { if (attempt === this.authAttempt) this.showError(error as Error); }
    finally { if (attempt === this.authAttempt) this.restoring = false; }
  }
  private async bindSession(saved: SavedSession, attempt: number): Promise<void> {
    if (!this.store) throw new Error('安全存储尚未准备好');
    const role = await this.store.getRole(saved.base,saved.user.id);
    if (attempt !== this.authAttempt) return;
    const local = this.store.readState(saved.base,saved.user.id);
    this.accountEpoch++; this.viewEpoch++;
    this.baseUrl = saved.base; this.token = saved.token;
    this.myId = saved.user.id; this.applyAccount(saved.user);
    this.role = role; this.page = 'lobby';
    this.drafts = local.drafts; this.outbox = local.outbox; this.storageReady = true;
    this.nextOrder = this.outbox.reduce((max: number,item: PendingMessage) => Math.max(max,item.order+1),1);
  }
  private startPolling(): void {
    this.stopPolling();
    if (!this.token || !this.appActive || this.restoring) return;
    this.timer = setInterval(() => { this.refresh(); },this.realtime?.isConnected() ? 30_000 : 5000);
  }
  private stopPolling(): void { if (this.timer >= 0) clearInterval(this.timer); this.timer = -1; }
  private activityChanged(): void {
    if (this.appActive) { this.startPolling(); this.startRealtime(); this.refresh(); }
    else { this.stopPolling(); this.persistDraft(); if (this.realtime) this.realtime.stop(); }
  }
  private startRealtime(): void {
    if (!this.token || !this.appActive || this.restoring) return;
    if (!this.realtime) this.realtime = new RealtimeConnection((event: RealtimeEvent) => { this.realtimeEvent(event); },(state: string) => {
      if (!this.token || !this.appActive) return;
      this.connection = state === 'connected' ? '已连接 · 实时更新' : state === 'offline' ? '网络已断开' : state === 'connecting' ? '正在连接 · 轮询补齐中' : '实时连接不可用 · 已回退轮询';
      this.startPolling();
      if (state === 'connected') this.refresh();
    });
    this.realtime.setView(this.conversationId);
    this.realtime.start(this.baseUrl,this.token);
  }
  private realtimeEvent(event: RealtimeEvent): void {
    if (!this.token || !this.appActive) return;
    if (event.type === 'auth_invalid') { this.logout(event.error || '登录已失效，请重新登录'); return; }
    if (event.type === 'directory') {
      if (this.conversationId>0) {this.refresh();return;}
      if (this.role === 'user' && this.page === 'lobby' && this.conversationId === 0) this.loadAis(false,true).catch((error: Error) => { this.showError(error); });
      return;
    }
    if (event.type==='history_changed' && event.conversationId===this.conversationId) {
      this.viewEpoch++;this.resetHistory();this.refresh();return;
    }
    if (event.type==='reports' && this.page==='manage' && this.managementKind==='reports') this.loadManagement(false);
    if (event.conversationId) this.syncConversation(event.conversationId);
    this.refresh();
  }
  private async syncConversation(id: number): Promise<void> {
    const ticket = this.viewEpoch;
    try {
      const result = await this.request('/conversations/' + id);
      if (ticket !== this.viewEpoch || !result.conversation) return;
      const row = result.conversation;
      if (id === this.conversationId) { this.muted = row.muted; this.peerName=row.peerName;this.blocked = row.blocked || false; this.selfBlocked = row.selfBlocked || false;this.peerUnavailable=row.peerUnavailable || false; }
      if (row.role !== this.role || this.search) return;
      const list = this.conversations.filter((c: Conversation) => c.id !== id);
      if (!row.hidden) list.push(row);
      this.conversations = list.sort((a: Conversation,b: Conversation) => Number(b.pinned)-Number(a.pinned) || b.lastMessageId-a.lastMessageId || b.id-a.id);
    } catch (error) { if (ticket === this.viewEpoch) this.showError(error as Error); }
  }
  private async request(path: string, payload: string = ''): Promise<ApiResult> {
    const account = this.accountEpoch;
    const result = await Api.request(this.baseUrl,path,this.token,payload);
    if (account !== this.accountEpoch) throw new ApiFailure('操作已取消',0,'STALE_ACCOUNT');
    return result;
  }
  private showError(error: Error): void {
    this.networkError=false;
    if (error instanceof ApiFailure) {
      if (error.code === 'STALE_ACCOUNT') return;
      if (error.status === 401 && this.token) { this.logout(error.message); return; }
      this.networkError=error.status===0 || error.status>=500;
      if (error.status === 0) this.classifyConnection(this.accountEpoch);
      else if (error.status >= 500) this.connection = '服务器暂时不可用';
    }
    this.status = error.message || '请求失败，请重试';
  }
  private networkRecovered(): void {
    this.connection = this.realtime?.isConnected() ? '已连接 · 实时更新' : '已连接 · 轮询更新';
    if (this.networkError) this.status = '';
    this.networkError=false;
  }
  private async classifyConnection(account:number): Promise<void> {
    try {
      const online=await connection.hasDefaultNet();
      if (account===this.accountEpoch && this.networkError) this.connection=online?'无法连接服务器 · 重试中':'网络已断开';
    } catch {if (account===this.accountEpoch) this.connection='无法连接服务 · 重试中';}
  }
  private applyAccount(user:Account): void {
    this.myName=user.username;this.displayName=user.nickname || user.username;this.accepting=user.accepting;
    this.aiBusy=user.busy || false;this.activeChats=user.activeChats || 0;this.maxChatsValue=user.maxChats || 10;
    this.boundEmail=user.email || '';this.emailVerified=user.emailVerified || false;
    if (!this.profileDirty) {this.nickname=user.nickname || user.username;this.bio=user.bio || '';this.aiStyle=user.aiStyle || '';this.aiTopics=user.aiTopics || '';}
    if (!this.availabilityDirty) {this.acceptingChoice=user.accepting;this.busyChoice=user.busy || false;this.maxChats=String(user.maxChats || 10);}
    if (!this.preferencesDirty) {this.notificationEnabled=user.notificationEnabled!==false;this.notificationPreview=user.notificationPreview!==false;}
  }
  private async saveBase(): Promise<void> {
    if (!AppConfig.development || !this.store || this.busy) return;
    const base=this.baseUrl.trim().replace(/\/$/,'');
    if (!/^https?:\/\/[^\s]+$/.test(base)) {this.status='请输入完整服务地址';return;}
    try {await this.store.setBase(base);this.baseUrl=base;this.status='开发地址已保存';}
    catch(error) {this.showError(error as Error);}
  }
  private async authenticate(register: boolean): Promise<void> {
    if (this.busy || this.restoring) return;
    this.baseUrl = this.baseUrl.trim().replace(/\/$/,'');
    if (!AppConfig.development) this.baseUrl=AppConfig.serviceUrl;
    if (!/^https?:\/\/[^\s]+$/.test(this.baseUrl)) { this.status = '请输入完整服务地址'; return; }
    if (!this.store) { this.status = '安全存储尚未准备好，请重新打开应用'; return; }
    this.busy = true; this.status = '';
    const attempt = ++this.authAttempt;
    const base = this.baseUrl;
    const loginName = this.username;
    const loginPassword = this.password;
    try {
      const deviceId = await this.store.getDeviceId();
      await this.store.setBase(base);
      const result = await Api.request(base,register ? '/auth/register' : '/auth/login','',
        JSON.stringify({ username: loginName,password: loginPassword,deviceId: deviceId,deviceName: 'HarmonyOS 设备',
          acceptPolicy:register && this.termsAccepted,policyVersion:POLICY_VERSION }));
      if (attempt !== this.authAttempt) return;
      if (!result.user || !result.token || !result.expiresAt) throw new Error('登录响应不完整，请更新后端');
      const saved: SavedSession = { base: base,token: result.token,user: result.user,expiresAt: result.expiresAt };
      try { await this.store.saveSession(saved); }
      catch (error) { Api.request(saved.base,'/auth/logout',saved.token,'{}').catch(() => {}); throw error as Error; }
      await this.bindSession(saved,attempt);
      if (attempt !== this.authAttempt) return;
      this.password = ''; this.startPolling(); this.startRealtime(); await this.refresh();
    } catch (error) { if (attempt === this.authAttempt) this.showError(error as Error); }
    finally { if (attempt === this.authAttempt) this.busy = false; }
  }
  private async refresh(): Promise<void> {
    if (!this.token || !this.appActive || this.restoring) return;
    if (this.refreshingEpoch === this.viewEpoch) { this.needsRefresh = true; return; }
    const ticket = this.viewEpoch, account = this.accountEpoch, selected = this.conversationId;
    this.refreshingEpoch = ticket;
    try {
      if (selected > 0) {
        let more = true;
        while (more) {
          const path = '/conversations/' + selected + '/messages' + (this.initializedMessages ? '?after=' + this.syncCursor : '');
          const result = await this.request(path);
          if (ticket !== this.viewEpoch) return;
          const first = !this.initializedMessages;
          if (!first && (result.historyVersion || 0)!==this.historyVersion) {this.resetHistory();continue;}
          this.historyVersion=result.historyVersion || 0;
          if (first) this.hasEarlier = result.hasEarlier || false;
          this.initializedMessages = true; this.syncCursor = result.cursor || this.syncCursor;
          this.loadingMessages=false;
          this.peerReadId = Math.max(this.peerReadId,result.peerReadId || 0);
          this.blocked = result.blocked || false; this.selfBlocked = result.selfBlocked || false;
          this.peerUnavailable=result.peerUnavailable || false;if (result.peerName) this.peerName=result.peerName;
          if ((result.messages || []).length) this.mergeMessages(result.messages || []);
          more = result.hasMore || false;
          if (first) this.scrollBottom();
        }
        this.scheduleRead();
      } else if (this.page === 'lobby') {
        await this.loadConversations(false,true);
        if (ticket !== this.viewEpoch) return;
        if (this.role === 'user') await this.loadAis(false,true);
      }
      const counts = await this.request('/me/unread');
      if (ticket !== this.viewEpoch) return;
      this.unread = counts.unread || { user: 0,ai: 0 };
      const me = await this.request('/me');
      if (ticket !== this.viewEpoch) return;
      if (me.user) this.applyAccount(me.user);
      this.networkRecovered();
    } catch (error) { if (ticket === this.viewEpoch && account === this.accountEpoch) this.showError(error as Error); }
    finally {
      if (this.refreshingEpoch === ticket) this.refreshingEpoch = -1;
      if (ticket===this.viewEpoch && selected>0) this.loadingMessages=false;
      if (this.needsRefresh && account === this.accountEpoch) { this.needsRefresh = false; this.refresh(); }
    }
  }
  private async loadConversations(more: boolean, preserve: boolean = false): Promise<void> {
    const ticket = this.viewEpoch,query=this.search,role=this.role;
    if (more && (query!==this.conversationQuery || role!==this.conversationRole)) {await this.loadConversations(false);return;}
    let cursor = more ? this.nextConversationCursor : '';
    if (more && !cursor) return;
    const desired=preserve && !more?Math.max(50,this.conversations.length):0;
    const rows = new Map<number,Conversation>();
    if (more) this.conversations.forEach((row: Conversation) => { rows.set(row.id,row); });
    let hasMore=false;
    do {
      const result = await this.request('/conversations?role=' + role + '&q=' + encodeURIComponent(query) + (cursor ? '&cursor=' + cursor : ''));
      if (ticket!==this.viewEpoch || query!==this.search) return;
      (result.conversations || []).forEach((row:Conversation) => {rows.set(row.id,row);});
      cursor=result.nextCursor || '';hasMore=result.hasMore || false;
    } while (preserve && !more && rows.size<desired && hasMore && cursor);
    const conversations: Conversation[] = [];
    rows.forEach((row: Conversation) => { conversations.push(row); });
    conversations.sort((a: Conversation,b: Conversation) => Number(b.pinned)-Number(a.pinned) || b.lastMessageId-a.lastMessageId || b.id-a.id);
    this.conversations = conversations;
    this.nextConversationCursor=cursor;this.conversationHasMore=hasMore;this.conversationQuery=query;this.conversationRole=role;
  }
  private async loadAis(more: boolean, preserve: boolean = false): Promise<void> {
    const ticket = this.viewEpoch,query=this.search,sort=this.aiSort;
    if (more && (query!==this.aiQuery || sort!==this.aiSortSnapshot)) {await this.loadAis(false);return;}
    let cursor = more ? this.nextAiCursor : '';
    if (more && !cursor) return;
    const desired=preserve && !more?Math.max(50,this.ais.length):0;
    const rows = new Map<number,Account>();
    if (more) this.ais.forEach((row: Account) => { rows.set(row.id,row); });
    let hasMore=false;
    do {
      const result = await this.request('/ais?q=' + encodeURIComponent(query)+'&sort='+sort + (cursor ? '&cursor=' + cursor : ''));
      if (ticket!==this.viewEpoch || query!==this.search || sort!==this.aiSort) return;
      (result.users || []).forEach((row:Account) => {rows.set(row.id,row);});
      cursor=result.nextCursor || '';hasMore=result.hasMore || false;
    } while (preserve && !more && rows.size<desired && hasMore && cursor);
    const ais: Account[] = [];
    rows.forEach((row: Account) => { ais.push(row); }); this.ais = ais;
    this.nextAiCursor=cursor;this.aiHasMore=hasMore;this.aiQuery=query;this.aiSortSnapshot=sort;
  }
  private async reloadLobby(): Promise<void> {
    const ticket = ++this.viewEpoch;
    try {
      await this.loadConversations(false);
      if (ticket !== this.viewEpoch) return;
      if (this.role === 'user') await this.loadAis(false);
      if (ticket === this.viewEpoch) this.networkRecovered();
    } catch (error) { if (ticket === this.viewEpoch) this.showError(error as Error); }
  }
  private switchRole(role: string): void {
    if (this.role === role) return;
    this.viewEpoch++; this.role = role; this.conversations = []; this.ais = []; this.search = '';
    this.nextConversationCursor = ''; this.nextAiCursor = ''; this.status = '';
    if (this.store) this.store.setRole(this.baseUrl,this.myId,role).catch((error: Error) => { this.showError(error); });
    this.refresh();
  }
  private async beginChat(ai: Account): Promise<void> {
    await this.runAction(async () => {
      const result = await this.request('/conversations',JSON.stringify({ aiId: ai.id }));
      if (result.conversationId) this.openChat(result.conversationId,ai.id,ai.nickname || ai.username,false);
    });
  }
  private openChat(id: number, peerId: number, name: string, muted: boolean): void {
    this.persistDraft(); this.viewEpoch++; this.page = 'lobby';
    this.conversationId = id; this.peerId = peerId; this.peerName = name; this.muted = muted;
    this.messages = []; this.draft = this.drafts.find((item: ConversationDraft) => item.conversationId === id)?.text || '';
    this.initializedMessages = false; this.syncCursor = 0; this.lastReadId = 0; this.visibleReadId = 0;
    this.historyVersion=0;this.loadingMessages=true;this.peerUnavailable=false;
    if (this.readTimer>=0) clearTimeout(this.readTimer);this.readTimer=-1;
    this.hasEarlier = false; this.peerReadId = 0; this.newMessages = 0; this.blocked = false; this.selfBlocked = false;
    this.reportMessageId = 0; this.reportReason = ''; this.atBottom = true; this.status = '';
    this.loadingHistory = false;
    if (this.realtime) this.realtime.setView(id);
    this.updateRows(); this.refresh();
  }
  private closeChat(): void {
    this.persistDraft(); this.viewEpoch++; this.conversationId = 0; this.messages = []; this.source.replace([]);
    this.draft = ''; this.reportMessageId = 0; this.reportReason = ''; this.status = ''; this.refresh();
    this.loadingMessages=false;if (this.readTimer>=0) clearTimeout(this.readTimer);this.readTimer=-1;
    if (this.realtime) this.realtime.setView(0);
  }
  private resetHistory(): void {
    this.messages=[];this.initializedMessages=false;this.syncCursor=0;this.hasEarlier=false;this.loadingMessages=true;
    this.lastReadId=0;this.visibleReadId=0;this.newMessages=0;
    if (this.readTimer>=0) clearTimeout(this.readTimer);this.readTimer=-1;
    this.updateRows();
  }
  private mergeMessages(incoming: ChatMessage[]): void {
    const known = new Set<number>(), rows = new Map<number,ChatMessage>();
    this.messages.forEach((message: ChatMessage) => { known.add(message.id); rows.set(message.id,message); });
    incoming.forEach((message: ChatMessage) => { rows.set(message.id,message); });
    const messages: ChatMessage[] = [];
    rows.forEach((message: ChatMessage) => { messages.push(message); });
    this.messages = messages.sort((a: ChatMessage,b: ChatMessage) => a.id-b.id);
    const pending = this.outbox.filter((item: PendingMessage) => !incoming.some((message: ChatMessage) =>
      item.conversationId === this.conversationId && message.senderId === this.myId && message.clientMessageId === item.clientMessageId && message.text===item.text));
    if (pending.length !== this.outbox.length) this.persistOutbox(pending);
    if (!this.atBottom) this.newMessages += incoming.filter((message: ChatMessage) => !known.has(message.id) && message.senderId !== this.myId && message.id > this.lastReadId).length;
    this.updateRows();
    if (this.atBottom && incoming.length) this.scrollBottom();
  }
  private updateRows(): void {
    const rows: MessageRow[] = this.messages.map((message: ChatMessage): MessageRow => ({
      id: message.id,senderId: message.senderId,text: message.text,createdAt: message.createdAt,clientMessageId: message.clientMessageId,redacted:message.redacted,state: 'sent',error: '',order: 0
    }));
    this.outbox.filter((item: PendingMessage) => item.conversationId === this.conversationId)
      .sort((a: PendingMessage,b: PendingMessage) => a.order-b.order).forEach((item: PendingMessage) => {
        rows.push({ id: 0,senderId: this.myId,text: item.text,createdAt: item.createdAt,clientMessageId: item.clientMessageId,state: item.state,error: item.error,order: item.order });
      });
    this.source.replace(rows); this.rowCount = rows.length;
  }
  private scrollBottom(): void {
    this.atBottom = true; this.newMessages = 0;
    const ticket = this.viewEpoch;
    setTimeout(() => { if (ticket === this.viewEpoch && this.conversationId > 0) this.scroller.scrollEdge(Edge.Bottom); },50);
  }
  private onVisible(start: number,end: number): void {
    this.atBottom = end >= this.source.totalCount()-1;
    if (this.atBottom) this.newMessages = 0;
    if (!this.appActive || this.conversationId === 0 || this.reportMessageId>0 || this.page==='policy') return;
    let visible = 0;
    for (let i=Math.max(0,start);i<=Math.min(end,this.source.totalCount()-1);i++) visible = Math.max(visible,this.source.getData(i).id);
    this.visibleReadId = Math.max(this.visibleReadId,visible); this.scheduleRead();
  }
  private scheduleRead(): void {
    if (this.readTimer >= 0 || !this.appActive || this.reportMessageId>0 || this.page==='policy' || this.visibleReadId <= this.lastReadId || !this.token || !this.conversationId) return;
    const ticket = this.viewEpoch;
    this.readTimer = setTimeout(async () => {
      this.readTimer = -1;
      if (ticket !== this.viewEpoch || !this.appActive) return;
      const messageId = this.visibleReadId;
      try {
        await this.request('/conversations/' + this.conversationId + '/read',JSON.stringify({ messageId: messageId }));
        if (ticket === this.viewEpoch) this.lastReadId = Math.max(this.lastReadId,messageId);
      } catch (error) { if (ticket === this.viewEpoch) this.showError(error as Error); }
    },200);
  }
  private async loadEarlier(): Promise<void> {
    if (this.loadingHistory || !this.hasEarlier || !this.messages.length) return;
    const ticket = this.viewEpoch; this.loadingHistory = true;
    try {
      const result = await this.request('/conversations/' + this.conversationId + '/messages?before=' + this.messages[0].id);
      if (ticket !== this.viewEpoch) return;
      if ((result.historyVersion || 0)!==this.historyVersion) {this.viewEpoch++;this.loadingHistory=false;this.resetHistory();this.refresh();return;}
      this.atBottom = false; this.hasEarlier = result.hasEarlier || false;
      const rows = new Map<number,ChatMessage>();
      (result.messages || []).concat(this.messages).forEach((message: ChatMessage) => { rows.set(message.id,message); });
      const messages: ChatMessage[] = [];
      rows.forEach((message: ChatMessage) => { messages.push(message); });
      this.messages = messages.sort((a: ChatMessage,b: ChatMessage) => a.id-b.id);
      this.updateRows(); this.networkRecovered();
    } catch (error) { if (ticket === this.viewEpoch) this.showError(error as Error); }
    finally { if (ticket === this.viewEpoch) this.loadingHistory = false; }
  }
  private changeDraft(value: string): void {
    this.draft = value;
    const id = this.conversationId;
    this.drafts = this.drafts.filter((item: ConversationDraft) => item.conversationId !== id);
    if (value.length) this.drafts.push({ conversationId: id,text: value });
    if (this.draftTimer >= 0) clearTimeout(this.draftTimer);
    this.draftTimer = setTimeout(() => { this.draftTimer = -1; this.persistDraft(); },400);
  }
  private persistDraft(): void {
    if (this.draftTimer >= 0) clearTimeout(this.draftTimer);
    this.draftTimer = -1;
    if (!this.token || !this.store || !this.storageReady) return;
    try { this.store.saveState({ ownerId: this.myId,base: this.baseUrl,drafts: this.drafts,outbox: this.outbox }); }
    catch (error) { this.status = (error as Error).message; }
  }
  private persistOutbox(outbox: PendingMessage[]): void {
    if (!this.store || !this.storageReady) throw new Error('本地消息存储尚未准备好');
    this.store.saveState({ ownerId: this.myId,base: this.baseUrl,drafts: this.drafts,outbox: outbox }); this.outbox = outbox;
  }
  private send(): void {
    const text = this.draft.trim();
    if (!text || !this.token || !this.conversationId || this.blocked || this.peerUnavailable) return;
    if (this.outbox.length >= 100) { this.status = '待发送消息过多，请先处理失败消息'; return; }
    const item: PendingMessage = { clientMessageId: util.generateRandomUUID(),conversationId: this.conversationId,text: text,createdAt: Date.now(),order: this.nextOrder++,state: 'queued',error: '' };
    if (this.outbox.some((row: PendingMessage) => row.conversationId === item.conversationId && row.state === 'failed')) {
      item.state = 'failed'; item.error = '请先重试前一条消息';
    }
    const previousDrafts = this.drafts;
    try {
      this.drafts = this.drafts.filter((draft: ConversationDraft) => draft.conversationId !== this.conversationId);
      this.persistOutbox(this.outbox.concat([item])); this.draft = ''; this.status = '';
      this.updateRows(); this.scrollBottom(); this.drainOutbox();
    } catch (error) { this.drafts = previousDrafts; this.showError(error as Error); }
  }
  private retry(clientId: string): void {
    if (this.blocked || this.peerUnavailable) return;
    const item = this.outbox.find((row: PendingMessage) => row.clientMessageId === clientId);
    if (!item) return;
    if (this.outbox.some((row: PendingMessage) => row.conversationId === item.conversationId && row.order < item.order && row.state === 'failed')) {
      this.status = '请先重试该会话中更早的失败消息'; return;
    }
    try {
      this.persistOutbox(this.outbox.map((row: PendingMessage): PendingMessage => ({
        clientMessageId: row.clientMessageId,conversationId: row.conversationId,text: row.text,createdAt: row.createdAt,order: row.order,
        state: row.conversationId === item.conversationId && row.state === 'failed' ? 'queued' : row.state,error: row.conversationId === item.conversationId ? '' : row.error
      })));
      this.status = ''; this.updateRows(); this.drainOutbox();
    } catch (error) { this.showError(error as Error); }
  }
  private async drainOutbox(): Promise<void> {
    const account = this.accountEpoch;
    if (this.drainingEpoch === account || !this.token) return;
    this.drainingEpoch = account;
    try {
      while (account === this.accountEpoch && this.token) {
        const item = this.outbox.find((row: PendingMessage) => row.state === 'queued' && !this.outbox.some((earlier: PendingMessage) => earlier.conversationId === row.conversationId && earlier.order < row.order && earlier.state === 'failed'));
        if (!item) break;
        this.setPendingState(item.clientMessageId,'sending','');
        try {
          const result = await this.request('/conversations/' + item.conversationId + '/messages',JSON.stringify({ text: item.text,clientMessageId: item.clientMessageId }));
          if (account !== this.accountEpoch) return;
          const message = result.message;
          if (!message || message.id < 1 || message.senderId !== this.myId || message.clientMessageId !== item.clientMessageId || message.text !== item.text) throw new Error('未收到有效发送确认，请重试');
          if (item.conversationId === this.conversationId) this.mergeMessages([message]);
          else this.persistOutbox(this.outbox.filter((row: PendingMessage) => row.clientMessageId !== item.clientMessageId));
          this.updateRows(); this.networkRecovered(); this.refresh();
        } catch (error) {
          if (account !== this.accountEpoch) return;
          if (this.outbox.some((row: PendingMessage) => row.clientMessageId === item.clientMessageId)) {
            this.setPendingState(item.clientMessageId,'failed',(error as Error).message);
            this.outbox.filter((row: PendingMessage) => row.conversationId === item.conversationId && row.order > item.order && row.state === 'queued')
              .forEach((row: PendingMessage) => { this.setPendingState(row.clientMessageId,'failed','请先重试前一条消息'); });
            this.showError(error as Error);
          }
        }
      }
    } catch (error) { if (account === this.accountEpoch) this.showError(error as Error); }
    finally { if (this.drainingEpoch === account) this.drainingEpoch = -1; }
  }
  private setPendingState(clientId: string, state: string, error: string): void {
    this.persistOutbox(this.outbox.map((row: PendingMessage): PendingMessage => ({
      clientMessageId: row.clientMessageId,conversationId: row.conversationId,text: row.text,createdAt: row.createdAt,order: row.order,
      state: row.clientMessageId === clientId ? state : row.state,error: row.clientMessageId === clientId ? error : row.error
    }))); this.updateRows();
  }
  private async runAction(action: () => Promise<void>): Promise<void> {
    if (this.busy || !this.token) return;
    const account = this.accountEpoch; this.busy = true;
    try { await action(); }
    catch (error) { if (account === this.accountEpoch) this.showError(error as Error); }
    finally { if (account === this.accountEpoch) this.busy = false; }
  }
  private async setAccepting(): Promise<void> {
    await this.runAction(async () => {
      const accepting = !this.accepting;
      await this.request('/me/accepting',JSON.stringify({ accepting: accepting }));
      this.accepting = accepting;if (!this.availabilityDirty) this.acceptingChoice=accepting;
      this.status = accepting ? '已开放接聊' : '已暂停新对话，已有对话仍可回复';
    });
  }
  private async setConversation(conversationId: number, payload: string): Promise<void> {
    await this.runAction(async () => {
      await this.request('/conversations/' + conversationId + '/settings',payload);
      if (conversationId === this.conversationId) await this.syncConversation(conversationId);
      else await this.reloadLobby();
    });
  }
  private hideConversation(conversation: Conversation): void {
    this.getUIContext().showAlertDialog({ title: '移出自己的会话列表',message: '聊天记录仍保存在服务端，对方仍可查看。新消息到来时，会话会重新出现在你的列表。',
      primaryButton: { value: '取消',action: () => {} },secondaryButton: { value: '移出',action: () => { this.setConversation(conversation.id,JSON.stringify({ hidden: true })); } } });
  }
  private async block(blocked: boolean): Promise<void> {
    await this.runAction(async () => {
      await this.request('/blocks',JSON.stringify({ userId: this.peerId,blocked: blocked }));
      this.selfBlocked = blocked; await this.refresh(); this.status = blocked ? '已拉黑，双方发送已关闭' : '已解除你设置的拉黑';
    });
  }
  private async report(): Promise<void> {
    await this.runAction(async () => {
      await this.request('/reports',JSON.stringify({ messageId: this.reportMessageId,reason: this.reportReason,category:this.reportCategory }));
      this.cancelReport();this.status = '举报已提交，可在设置中查看处理状态';
    });
  }
  private chooseReport(messageId:number): void {
    this.persistDraft();this.viewEpoch++;this.reportMessageId=messageId;this.reportCategory='harassment';this.reportReason='';
    if (this.realtime) this.realtime.setView(0);
  }
  private cancelReport(): void {
    this.viewEpoch++;this.reportMessageId=0;this.reportReason='';this.page='lobby';
    if (this.realtime) this.realtime.setView(this.conversationId);this.refresh();
  }
  private showPolicy(kind:string): void {
    this.persistDraft();this.policyReturnPage=this.page;this.page='policy';this.policyKind=kind;this.viewEpoch++;
    if (this.realtime) this.realtime.setView(0);
  }
  private backPolicy(): void {
    this.page=this.policyReturnPage;this.viewEpoch++;
    if (this.realtime) this.realtime.setView(this.reportMessageId>0?0:this.conversationId);
    this.refresh();
  }
  private showRecovery(): void {this.password='';this.loginMode='recovery';this.status='';}
  private backRecovery(): void {
    this.authAttempt++;this.busy=false;this.loginMode='login';this.recoveryEmail='';this.recoveryCode='';
    this.recoveryPassword='';this.recoveryChallengeId='';this.recoveryExpiresAt=0;this.status='';
  }
  private async requestRecovery(): Promise<void> {
    if (this.busy || this.token) return;
    const base=AppConfig.development?this.baseUrl.trim().replace(/\/$/,''):AppConfig.serviceUrl;
    if (!/^https?:\/\/[^\s]+$/.test(base)) {this.status='请先设置完整服务地址';return;}
    const attempt=++this.authAttempt;this.busy=true;this.status='';
    try {
      if (this.store && AppConfig.development) await this.store.setBase(base);
      const result=await Api.request(base,'/auth/recovery/request','',JSON.stringify({email:this.recoveryEmail}));
      if (attempt!==this.authAttempt) return;
      if (!result.challengeId || !result.expiresAt) throw new Error('验证码请求响应不完整');
      this.baseUrl=base;this.recoveryChallengeId=result.challengeId;this.recoveryExpiresAt=result.expiresAt;this.recoveryCode='';
      this.networkRecovered();
    } catch(error) {if (attempt===this.authAttempt) this.showError(error as Error);}
    finally {if (attempt===this.authAttempt) this.busy=false;}
  }
  private async resetPassword(): Promise<void> {
    if (this.busy || this.token || !this.recoveryChallengeId) return;
    const attempt=++this.authAttempt;this.busy=true;
    try {
      await Api.request(this.baseUrl,'/auth/recovery/reset','',JSON.stringify({challengeId:this.recoveryChallengeId,code:this.recoveryCode,newPassword:this.recoveryPassword}));
      if (attempt!==this.authAttempt) return;
      this.backRecovery();this.status='密码已重置，旧登录已撤销，请用新密码登录';
    } catch(error) {if (attempt===this.authAttempt) this.showError(error as Error);}
    finally {if (attempt===this.authAttempt) this.busy=false;}
  }
  private async saveProfile(): Promise<void> {
    await this.runAction(async () => {
      const result=await this.request('/me/profile',JSON.stringify({nickname:this.nickname,bio:this.bio,aiStyle:this.aiStyle,aiTopics:this.aiTopics}));
      this.profileDirty=false;if (result.user) this.applyAccount(result.user);this.status='个人资料已保存';
    });
  }
  private async saveAvailability(): Promise<void> {
    const max=Number(this.maxChats);
    if (!/^\d{1,3}$/.test(this.maxChats) || !Number.isInteger(max) || max<1 || max>100) {this.status='接聊数量上限需为1–100';return;}
    await this.runAction(async () => {
      const result=await this.request('/me/availability',JSON.stringify({accepting:this.acceptingChoice,busy:this.busyChoice,maxChats:max}));
      this.availabilityDirty=false;if (result.user) this.applyAccount(result.user);this.status='接聊状态与上限已保存';
    });
  }
  private async savePreferences(): Promise<void> {
    await this.runAction(async () => {
      const result=await this.request('/me/preferences',JSON.stringify({notificationEnabled:this.notificationEnabled,notificationPreview:this.notificationPreview}));
      this.preferencesDirty=false;if (result.user) this.applyAccount(result.user);this.status='通知设置已保存，系统推送仍待接入';
    });
  }
  private async requestEmail(): Promise<void> {
    await this.runAction(async () => {
      const result=await this.request('/me/email/request',JSON.stringify({email:this.emailInput,currentPassword:this.currentPassword}));
      if (!result.challengeId || !result.expiresAt) throw new Error('邮箱验证码请求响应不完整');
      this.emailChallengeId=result.challengeId;this.emailExpiresAt=result.expiresAt;this.emailCode='';this.currentPassword='';
      this.status='验证码已发送，请检查邮箱';
    });
  }
  private async verifyEmail(): Promise<void> {
    await this.runAction(async () => {
      const result=await this.request('/me/email/verify',JSON.stringify({challengeId:this.emailChallengeId,code:this.emailCode}));
      if (result.user) this.applyAccount(result.user);
      this.emailChallengeId='';this.emailCode='';this.status='邮箱已验证，可用于找回密码';
    });
  }
  private unbindEmail(): void {
    this.getUIContext().showAlertDialog({title:'解绑邮箱',message:'解绑后无法使用该邮箱找回密码。确认当前密码后可继续。',
      primaryButton:{value:'取消',action:()=>{}},secondaryButton:{value:'解绑',action:()=>{this.runAction(async () => {
        await this.request('/me/email/unbind',JSON.stringify({currentPassword:this.currentPassword}));
        this.boundEmail='';this.emailVerified=false;this.emailInput='';this.emailChallengeId='';this.emailCode='';this.currentPassword='';this.status='邮箱已解绑';
      });}}});
  }
  private deleteAccount(): void {
    this.getUIContext().showAlertDialog({title:'永久注销账号',message:'将立即退出所有设备，移除资料、邮箱和本人发送的消息正文。对方自己的消息仍保留；必要举报证据及备份按隐私政策的期限处理。此操作无法撤销。',
      primaryButton:{value:'取消',action:()=>{}},secondaryButton:{value:'确认注销',action:()=>{this.runAction(async () => {
        await this.request('/me/delete',JSON.stringify({currentPassword:this.currentPassword,confirm:'注销账号'}));
        await this.logout('账号已注销，本人资料与消息正文已移除');
      });}}});
  }
  private async loadCapabilities(): Promise<void> {
    const result=await this.request('/service/config');this.mailAvailable=result.mailAvailable || false;this.capabilitiesKnown=true;
  }
  private showManagement(kind:string): void {
    this.page='manage';this.managementKind=kind;this.managementCursor='';this.managementHasMore=false;this.viewEpoch++;
    this.blockedUsers=[];this.reports=[];this.notices=[];this.loadManagement(false);
  }
  private async loadManagement(more:boolean): Promise<void> {
    const ticket=this.viewEpoch,kind=this.managementKind,cursor=more?this.managementCursor:'';
    if (more && !cursor) return;this.managementLoading=true;
    try {
      const path=kind==='notices'?'/me/notices':'/'+kind+(cursor?'?before='+cursor:'');
      const result=await this.request(path);if (ticket!==this.viewEpoch || this.page!=='manage') return;
      if (kind==='blocks') {
        const rows=new Map<number,Account>();if (more) this.blockedUsers.forEach((row:Account) => {rows.set(row.id,row);});
        (result.users || []).forEach((row:Account) => {rows.set(row.id,row);});
        const users:Account[]=[];rows.forEach((row:Account) => {users.push(row);});this.blockedUsers=users;
      } else if (kind==='reports') {
        const rows=new Map<number,UserReport>();if (more) this.reports.forEach((row:UserReport) => {rows.set(row.id,row);});
        (result.reports || []).forEach((row:UserReport) => {rows.set(row.id,row);});
        const reports:UserReport[]=[];rows.forEach((row:UserReport) => {reports.push(row);});this.reports=reports;
      } else this.notices=result.notices || [];
      this.managementCursor=result.nextCursor || '';this.managementHasMore=result.hasMore || false;this.networkRecovered();
    } catch(error) {if (ticket===this.viewEpoch) this.showError(error as Error);}
    finally {if (ticket===this.viewEpoch) this.managementLoading=false;}
  }
  private async unblockUser(userId:number): Promise<void> {
    await this.runAction(async () => {await this.request('/blocks',JSON.stringify({userId:userId,blocked:false}));await this.loadManagement(false);this.status='已解除拉黑';});
  }
  private async showSettings(): Promise<void> {
    this.persistDraft(); this.viewEpoch++; this.page = 'settings';
    try { await Promise.all([this.loadDevices(),this.loadCapabilities()]); } catch (error) { this.showError(error as Error); }
  }
  private async loadDevices(): Promise<void> { const result = await this.request('/auth/devices'); this.devices = result.devices || []; }
  private async revokeDevice(sessionId: string): Promise<void> {
    await this.runAction(async () => {
      await this.request('/auth/devices/revoke',JSON.stringify(sessionId ? { sessionId: sessionId } : { otherDevices: true }));
      await this.loadDevices();
    });
  }
  private async changePassword(): Promise<void> {
    await this.runAction(async () => {
      await this.request('/auth/password',JSON.stringify({ currentPassword: this.currentPassword,newPassword: this.newPassword }));
      await this.logout('密码已修改，旧登录凭据已全部撤销，请用新密码登录');
    });
  }
  private async logout(reason: string = ''): Promise<void> {
    const token = this.token, base = this.baseUrl;
    this.authAttempt++; this.accountEpoch++; this.viewEpoch++; this.stopPolling();
    if (this.realtime) this.realtime.stop();
    this.needsRefresh = false;
    const account = this.accountEpoch;
    if (this.draftTimer >= 0) clearTimeout(this.draftTimer);
    if (this.readTimer >= 0) clearTimeout(this.readTimer);
    this.draftTimer = -1; this.readTimer = -1;
    this.token = ''; this.myId = 0; this.myName = '';this.displayName=''; this.password = ''; this.username = '';
    this.currentPassword = ''; this.newPassword = ''; this.accepting = false; this.conversationId = 0;
    this.peerId = 0; this.peerName = ''; this.conversations = []; this.ais = []; this.messages = [];
    this.outbox = []; this.drafts = []; this.draft = ''; this.search = ''; this.devices = [];
    this.unread = { user: 0,ai: 0 }; this.reportMessageId = 0; this.reportReason = '';
    this.nickname='';this.bio='';this.aiStyle='';this.aiTopics='';this.aiBusy=false;this.activeChats=0;this.maxChatsValue=10;
    this.acceptingChoice=false;this.busyChoice=false;this.maxChats='10';this.notificationEnabled=true;this.notificationPreview=true;
    this.profileDirty=false;this.availabilityDirty=false;this.preferencesDirty=false;this.boundEmail='';this.emailVerified=false;
    this.emailInput='';this.emailCode='';this.emailChallengeId='';this.emailExpiresAt=0;this.mailAvailable=false;this.capabilitiesKnown=false;
    this.recoveryEmail='';this.recoveryCode='';this.recoveryPassword='';this.recoveryChallengeId='';this.recoveryExpiresAt=0;
    this.blockedUsers=[];this.reports=[];this.notices=[];this.managementLoading=false;this.managementHasMore=false;this.managementCursor='';
    this.termsAccepted=false;this.loginMode='login';this.role='user';this.aiSort='recent';this.networkError=false;
    this.loadingMessages=false;this.loadingHistory=false;this.initializedMessages=false;this.syncCursor=0;this.historyVersion=0;
    this.nextConversationCursor='';this.nextAiCursor='';this.conversationHasMore=false;this.aiHasMore=false;this.peerUnavailable=false;
    this.source.replace([]); this.rowCount = 0; this.page = 'lobby'; this.status = reason;
    this.connection = '尚未连接'; this.busy = false; this.restoring = false; this.storageReady = false;
    if (this.store) {
      try { this.store.clearState(); } catch (error) { if (account === this.accountEpoch) this.status = reason + ' ' + (error as Error).message; }
      try { await this.store.clearSession(); } catch (error) { if (account === this.accountEpoch) this.status = reason + ' ' + (error as Error).message; }
    }
    if (token) Api.request(base,'/auth/logout',token,'{}').catch(() => {});
  }

  build() {
    Column() {
      if (this.restoring) {
        Column({ space: 16 }) {
          LoadingProgress().width(40).height(40)
          Text('正在恢复登录…')
          Button('使用其他账号').onClick(() => { this.logout(); })
        }.layoutWeight(1).justifyContent(FlexAlign.Center)
      } else if (this.page==='policy') {
        PolicyPane({kind:this.policyKind,onBack:() => {this.backPolicy();}}).layoutWeight(1)
      } else if (!this.token && this.loginMode==='recovery') {
        RecoveryPane({email:$recoveryEmail,code:$recoveryCode,password:$recoveryPassword,busy:this.busy,
          requested:this.recoveryChallengeId.length>0,expiresAt:this.recoveryExpiresAt,onBack:() => {this.backRecovery();},
          onRequest:() => {this.requestRecovery();},onReset:() => {this.resetPassword();}}).layoutWeight(1)
      } else if (!this.token) {
        LoginPane({ baseUrl: $baseUrl,username: $username,password: $password,loginMode: $loginMode,termsAccepted:$termsAccepted,busy: this.busy,
          onAuthenticate: (register: boolean) => { this.authenticate(register); },onRecovery:() => {this.showRecovery();},
          onPolicy:(kind:string) => {this.showPolicy(kind);},onSaveBase:() => {this.saveBase();} }).layoutWeight(1)
      } else if (this.reportMessageId>0) {
        ReportPane({peerName:this.peerName,busy:this.busy,category:$reportCategory,reason:$reportReason,
          onBack:() => {this.cancelReport();},onSubmit:() => {this.report();},onPolicy:() => {this.showPolicy('privacy');}}).layoutWeight(1)
      } else if (this.conversationId > 0) {
        ChatPane({ source: this.source,scroller: this.scroller,myId: this.myId,peerName: this.peerName,role: this.role,
          hasEarlier: this.hasEarlier,loading: this.loadingHistory,initialLoading:this.loadingMessages,messagesReady:this.initializedMessages,
          blocked: this.blocked,selfBlocked: this.selfBlocked,peerUnavailable:this.peerUnavailable,muted: this.muted,
          newCount: this.newMessages,peerReadId: this.peerReadId,rowCount: this.rowCount,draft: $draft,
          onBack: () => { this.closeChat(); },onEarlier: () => { this.loadEarlier(); },onSend: () => { this.send(); },
          onRetry: (clientId: string) => { this.retry(clientId); },onDraft: (value: string) => { this.changeDraft(value); },
          onVisible: (start:number,end: number) => { this.onVisible(start,end); },onBottom: () => { this.scrollBottom(); },onBlock: (blocked: boolean) => { this.block(blocked); },
          onMute: () => { this.setConversation(this.conversationId,JSON.stringify({ muted: !this.muted })); },onReportMessage:(id:number) => {this.chooseReport(id);} }).layoutWeight(1)
      } else if (this.page==='manage') {
        ManagementPane({kind:this.managementKind,users:this.blockedUsers,reports:this.reports,notices:this.notices,
          loading:this.managementLoading || this.busy,hasMore:this.managementHasMore,onBack:() => {this.page='settings';this.viewEpoch++;},
          onRefresh:() => {this.loadManagement(false);},onMore:() => {this.loadManagement(true);},
          onUnblock:(id:number) => {this.unblockUser(id);}}).layoutWeight(1)
      } else if (this.page === 'settings') {
        SettingsPane({ myName: this.myName,busy: this.busy,devices: this.devices,currentPassword: $currentPassword,newPassword: $newPassword,
          nickname:$nickname,bio:$bio,aiStyle:$aiStyle,aiTopics:$aiTopics,acceptingChoice:$acceptingChoice,busyChoice:$busyChoice,maxChats:$maxChats,
          notificationEnabled:$notificationEnabled,notificationPreview:$notificationPreview,emailInput:$emailInput,emailCode:$emailCode,
          boundEmail:this.boundEmail,emailVerified:this.emailVerified,emailRequested:this.emailChallengeId.length>0,emailExpiresAt:this.emailExpiresAt,
          mailAvailable:this.mailAvailable,capabilitiesKnown:this.capabilitiesKnown,activeChats:this.activeChats,profileDirty:this.profileDirty,
          availabilityDirty:this.availabilityDirty,preferencesDirty:this.preferencesDirty,onProfile:() => {this.saveProfile();},
          onAvailability:() => {this.saveAvailability();},onPreferences:() => {this.savePreferences();},
          onProfileDirty:() => {this.profileDirty=true;},onAvailabilityDirty:() => {this.availabilityDirty=true;},onPreferencesDirty:() => {this.preferencesDirty=true;},
          onEmailRequest:() => {this.requestEmail();},onEmailVerify:() => {this.verifyEmail();},onEmailUnbind:() => {this.unbindEmail();},
          onManage:(kind:string) => {this.showManagement(kind);},onPolicy:(kind:string) => {this.showPolicy(kind);},onDelete:() => {this.deleteAccount();},
          onBack: () => { this.page = 'lobby'; this.viewEpoch++; this.refresh(); },onLogout: () => { this.logout(); },onPassword: () => { this.changePassword(); },
          onDevices: () => { this.runAction(async () => { await this.loadDevices(); }); },onRevoke: (id: string) => { this.revokeDevice(id); },onRevokeOthers: () => { this.revokeDevice(''); } }).layoutWeight(1)
      } else {
        LobbyPane({ myName: this.myName,displayName:this.displayName,role: this.role,accepting: this.accepting,busy: this.busy,ais: this.ais,conversations: this.conversations,
          aiBusy:this.aiBusy,activeChats:this.activeChats,maxChats:this.maxChatsValue,
          unread: this.unread,hasMore: this.conversationHasMore,aiHasMore: this.aiHasMore,search: $search,aiSort:$aiSort,
          onRole: (role: string) => { this.switchRole(role); },onAccepting: () => { this.setAccepting(); },onBegin: (ai: Account) => { this.beginChat(ai); },
          onOpen: (c: Conversation) => { this.openChat(c.id,c.peerId,c.peerName,c.muted); },
          onMore: () => { this.runAction(async () => { await this.loadConversations(true); }); },onAiMore: () => { this.runAction(async () => { await this.loadAis(true); }); },
          onRefresh: () => { this.reloadLobby(); },onSettings: () => { this.showSettings(); },
          onPin: (c: Conversation) => { this.setConversation(c.id,JSON.stringify({ pinned: !c.pinned })); },onHide: (c: Conversation) => { this.hideConversation(c); } }).layoutWeight(1)
      }
      if (this.token) { Text(this.connection).fontSize(11).fontColor($r('app.color.text_secondary')).padding(4) }
      if (this.busy) { Text('正在处理…').fontSize(12).fontColor($r('app.color.text_secondary')).padding(4) }
      if (this.status.length > 0) {
        Row({ space: 8 }) {
          Text(this.status).fontSize(13).fontColor($r('app.color.error')).layoutWeight(1)
          if (this.token) { Button('重试连接').fontSize(12).onClick(() => { this.refresh(); }) }
        }.padding(10).width('100%')
      }
    }.height('100%').width('100%').backgroundColor($r('app.color.background'))
  }
}
