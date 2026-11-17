import { Api, Account, Conversation, ChatMessage } from '../common/Api';

@Entry
@Preview
@Component
struct Index {
  @State baseUrl: string = 'http://127.0.0.1:8787';
  @State username: string = '';
  @State password: string = '';
  @State token: string = '';
  @State myId: number = 0;
  @State myName: string = '';
  @State role: string = 'user';
  @State accepting: boolean = false;
  @State ais: Account[] = [];
  @State conversations: Conversation[] = [];
  @State conversationId: number = 0;
  @State peerId: number = 0;
  @State peerName: string = '';
  @State messages: ChatMessage[] = [];
  @State draft: string = '';
  @State status: string = '';
  @State busy: boolean = false;
  @State hasMore: boolean = false;
  @State reportMessageId: number = 0;
  @State reportReason: string = '';
  @StorageLink('appActive') @Watch('activityChanged') appActive: boolean = true;
  private timer: number = -1;
  private refreshing: boolean = false;
  private generation: number = 0;
  private lastReadId: number = 0;
  private scroller: Scroller = new Scroller();

  onPageShow(): void {
    this.stopPolling();
    this.timer = setInterval(() => { this.refresh(); }, 3000);
    this.refresh();
  }
  onPageHide(): void { this.stopPolling(); this.generation++; }
  aboutToDisappear(): void { this.stopPolling(); this.generation++; }
  onBackPress(): boolean {
    if (this.conversationId > 0 && !this.busy) { this.closeChat(); return true; }
    return this.busy;
  }
  private stopPolling(): void {
    if (this.timer >= 0) clearInterval(this.timer);
    this.timer = -1;
  }
  private activityChanged(): void {
    if (this.appActive) this.onPageShow();
    else { this.stopPolling(); this.generation++; }
  }
  private showError(error: Error): void {
    if (error.message === '请重新登录') {
      this.generation++;
      this.token = '';
      this.conversationId = 0;
      this.messages = [];
      this.conversations = [];
    }
    this.status = error.message || '连接失败，请检查后端地址、网络和服务';
  }
  private async authenticate(register: boolean): Promise<void> {
    if (this.busy) return;
    if (!/^https?:\/\/[^\s]+$/.test(this.baseUrl)) { this.status = '请输入完整后端地址'; return; }
    this.busy = true;
    this.status = '';
    try {
      const result = await Api.request(this.baseUrl, register ? '/auth/register' : '/auth/login', '',
        JSON.stringify({ username: this.username, password: this.password }));
      if (result.user && result.token) {
        this.generation++;
        this.token = result.token;
        this.myId = result.user.id;
        this.myName = result.user.username;
        this.accepting = result.user.accepting;
        this.password = '';
        this.role = 'user';
        await this.refresh();
      }
    } catch (error) { this.showError(error as Error); }
    finally { this.busy = false; }
  }
  private async refresh(): Promise<void> {
    if (!this.token || this.refreshing) return;
    this.refreshing = true;
    const generation = this.generation;
    const selected = this.conversationId;
    try {
      if (selected > 0) {
        const after = this.messages.length > 0 ? this.messages[this.messages.length - 1].id : 0;
        const result = await Api.request(this.baseUrl, '/conversations/' + selected + '/messages?after=' + after, this.token);
        if (generation !== this.generation) return;
        const incoming = result.messages || [];
        this.messages = this.messages.concat(incoming);
        this.hasMore = result.hasMore || false;
        const latest = this.messages.length > 0 ? this.messages[this.messages.length - 1].id : 0;
        if (latest > this.lastReadId) {
          await Api.request(this.baseUrl, '/conversations/' + selected + '/read', this.token,
            JSON.stringify({ messageId: latest }));
          if (generation !== this.generation) return;
          this.lastReadId = latest;
        }
        if (incoming.length > 0) this.scroller.scrollEdge(Edge.Bottom);
      } else {
        const result = await Api.request(this.baseUrl, '/conversations?role=' + this.role, this.token);
        if (generation !== this.generation) return;
        this.conversations = result.conversations || [];
        if (this.role === 'user') {
          const directory = await Api.request(this.baseUrl, '/ais', this.token);
          if (generation === this.generation) this.ais = directory.users || [];
        }
      }
    } catch (error) {
      if (generation === this.generation) this.showError(error as Error);
    } finally { this.refreshing = false; }
  }
  private switchRole(role: string): void {
    this.generation++;
    this.role = role;
    this.conversations = [];
    this.ais = [];
    this.status = '';
    this.refresh();
  }
  private openChat(id: number, peerId: number, name: string): void {
    this.generation++;
    this.conversationId = id;
    this.peerId = peerId;
    this.peerName = name;
    this.messages = [];
    this.draft = '';
    this.lastReadId = 0;
    this.status = '';
    this.hasMore = false;
    this.reportMessageId = 0;
    this.refresh();
  }
  private closeChat(): void {
    this.generation++;
    this.conversationId = 0;
    this.messages = [];
    this.reportMessageId = 0;
    this.status = '';
    this.refresh();
  }
  private async beginChat(ai: Account): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const result = await Api.request(this.baseUrl, '/conversations', this.token, JSON.stringify({ aiId: ai.id }));
      if (result.conversationId) this.openChat(result.conversationId, ai.id, ai.username);
    } catch (error) { this.showError(error as Error); }
    finally { this.busy = false; }
  }
  private async setAccepting(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await Api.request(this.baseUrl, '/me/accepting', this.token, JSON.stringify({ accepting: !this.accepting }));
      this.accepting = !this.accepting;
      this.status = this.accepting ? '已开放接聊；不代表设备在线' : '已暂停新对话，已有对话仍可回复';
    } catch (error) { this.showError(error as Error); }
    finally { this.busy = false; }
  }
  private async send(): Promise<void> {
    if (this.busy || !this.draft.trim()) return;
    this.busy = true;
    try {
      await Api.request(this.baseUrl, '/conversations/' + this.conversationId + '/messages', this.token,
        JSON.stringify({ text: this.draft }));
      this.draft = '';
      this.status = '';
      await this.refresh();
    } catch (error) { this.showError(error as Error); }
    finally { this.busy = false; }
  }
  private async block(blocked: boolean): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await Api.request(this.baseUrl, '/blocks', this.token, JSON.stringify({ userId: this.peerId, blocked: blocked }));
      this.status = blocked ? '已拉黑，双方无法发送消息。可点击解除拉黑恢复。' : '已解除你设置的拉黑';
    } catch (error) { this.showError(error as Error); }
    finally { this.busy = false; }
  }
  private async report(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await Api.request(this.baseUrl, '/reports', this.token,
        JSON.stringify({ messageId: this.reportMessageId, reason: this.reportReason }));
      this.reportMessageId = 0;
      this.reportReason = '';
      this.status = '举报已提交，等待管理员处理';
    } catch (error) { this.showError(error as Error); }
    finally { this.busy = false; }
  }
  private async logout(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await Api.request(this.baseUrl, '/auth/logout', this.token, '{}');
      this.generation++;
      this.token = '';
      this.conversationId = 0;
      this.conversations = [];
      this.messages = [];
      this.status = '';
    } catch (error) { this.showError(error as Error); }
    finally { this.busy = false; }
  }

  @Builder
  loginView() {
    Column({ space: 16 }) {
      Text('人机？').fontSize(38).fontWeight(FontWeight.Bold).fontColor('#176B59')
      Text('AI 的身份，真人的回应').fontSize(16).fontColor('#64756F')
      Text('文字聊天 · 本地试用版').fontSize(12).fontColor('#64756F')
      TextInput({ text: this.baseUrl, placeholder: '后端地址 http://电脑IP:8787' })
        .onChange((value: string) => { this.baseUrl = value; })
      TextInput({ text: this.username, placeholder: '用户名：3–24位字母、数字或下划线' })
        .maxLength(24).onChange((value: string) => { this.username = value; })
      TextInput({ text: this.password, placeholder: '密码：至少8位' }).type(InputType.Password)
        .maxLength(128).onChange((value: string) => { this.password = value; })
      Row({ space: 12 }) {
        Button('登录').layoutWeight(1).backgroundColor('#176B59').enabled(!this.busy)
          .onClick(() => { this.authenticate(false); })
        Button('注册账号').layoutWeight(1).backgroundColor('#385A77').enabled(!this.busy)
          .onClick(() => { this.authenticate(true); })
      }.width('100%')
      Text('注册后可自由切换用户／AI身份。AI由真人扮演，回复可能需要等待。请勿发送隐私信息。')
        .fontSize(13).fontColor('#64756F')
      Text('开发版暂不提供密码找回。重启应用后需重新登录。').fontSize(12).fontColor('#64756F')
    }.padding(24).width('100%')
  }
  @Builder
  lobbyView() {
    Row() {
      Column({ space: 4 }) {
        Text('人机？').fontSize(26).fontWeight(FontWeight.Bold).fontColor('#176B59')
        Text('@' + this.myName).fontSize(13).fontColor('#64756F')
      }.alignItems(HorizontalAlign.Start)
      Blank()
      Button('退出').enabled(!this.busy).onClick(() => { this.logout(); })
    }.width('100%').padding(16)
    Row({ space: 12 }) {
      Button('我是用户').layoutWeight(1).backgroundColor(this.role === 'user' ? '#176B59' : '#82948C')
        .enabled(!this.busy).onClick(() => { this.switchRole('user'); })
      Button('我是 AI').layoutWeight(1).backgroundColor(this.role === 'ai' ? '#176B59' : '#82948C')
        .enabled(!this.busy).onClick(() => { this.switchRole('ai'); })
    }.width('100%').padding({ left: 16, right: 16 })
    Scroll() {
      Column({ space: 12 }) {
        if (this.role === 'ai') {
          Text('你是以 AI 身份回复的真人。开关只控制新对话。').fontSize(13).fontColor('#64756F')
          Button(this.accepting ? '暂停接收新对话' : '开放接聊，让用户找到我')
            .backgroundColor('#176B59').enabled(!this.busy).onClick(() => { this.setAccepting(); })
        } else {
          Text('可聊天的 AI').fontSize(20).fontWeight(FontWeight.Bold)
          if (this.ais.length === 0) {
            Text('暂无开放接聊的 AI。请让另一个账号切到 AI 身份并开放接聊。').fontColor('#64756F').fontSize(14)
          }
          ForEach(this.ais, (ai: Account) => {
            Row() {
              Column({ space: 4 }) {
                Text(ai.username).fontWeight(FontWeight.Bold)
                Text('真人回复 · 开放接聊').fontSize(12).fontColor('#64756F')
              }.alignItems(HorizontalAlign.Start)
              Blank()
              Button('聊聊').backgroundColor('#176B59').enabled(!this.busy).onClick(() => { this.beginChat(ai); })
            }.width('100%').padding(14).backgroundColor(Color.White).borderRadius(14)
          }, (ai: Account) => ai.id.toString())
        }
        Row() {
          Text(this.role === 'user' ? '我的对话' : '收到的对话').fontSize(20).fontWeight(FontWeight.Bold)
          Blank()
          Button('刷新').onClick(() => { this.refresh(); })
        }.width('100%')
        if (this.conversations.length === 0) { Text('还没有对话').fontColor('#64756F') }
        ForEach(this.conversations, (conversation: Conversation) => {
          Column({ space: 6 }) {
            Row() {
              Text(conversation.peerName).fontWeight(FontWeight.Bold)
              Blank()
              if (conversation.unread > 0) {
                Text(conversation.unread.toString() + ' 未读').fontSize(12).fontColor('#B54735')
              }
            }.width('100%')
            Text(conversation.lastText).maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
              .fontSize(14).fontColor('#64756F').width('100%')
          }.padding(16).width('100%').backgroundColor(Color.White).borderRadius(14)
            .onClick(() => { if (!this.busy) this.openChat(conversation.id, conversation.peerId, conversation.peerName); })
        }, (conversation: Conversation) => conversation.id.toString())
      }.width('100%').padding(16).alignItems(HorizontalAlign.Start)
    }.layoutWeight(1).width('100%')
  }
  @Builder
  chatView() {
    Row({ space: 12 }) {
      Button('返回').enabled(!this.busy).onClick(() => { this.closeChat(); })
      Column({ space: 4 }) {
        Text(this.peerName).fontSize(20).fontWeight(FontWeight.Bold)
        Text(this.role === 'user' ? '对方是由真人扮演的 AI' : '你正在以 AI 身份回复').fontSize(12).fontColor('#64756F')
      }.alignItems(HorizontalAlign.Start).layoutWeight(1)
    }.width('100%').padding(16)
    Row({ space: 8 }) {
      Button('拉黑').fontSize(12).enabled(!this.busy).onClick(() => { this.block(true); })
      Button('解除拉黑').fontSize(12).enabled(!this.busy).onClick(() => { this.block(false); })
      Text('长按对方消息举报').fontSize(12).fontColor('#64756F')
    }.padding({ bottom: 8 })
    Scroll(this.scroller) {
      Column({ space: 12 }) {
        if (this.messages.length === 0) { Text('发送第一条消息吧').fontColor('#64756F') }
        ForEach(this.messages, (message: ChatMessage) => {
          Row() {
            if (message.senderId === this.myId) { Blank().layoutWeight(1) }
            Column({ space: 5 }) {
              Text(message.senderId === this.myId ? '我' : this.peerName).fontSize(12).fontColor('#64756F')
              Text(message.text).fontSize(16).fontColor('#20372F').width('100%')
              Text(new Date(message.createdAt).toLocaleString()).fontSize(10).fontColor('#64756F')
            }.alignItems(HorizontalAlign.Start).padding(12).width('82%')
              .backgroundColor(message.senderId === this.myId ? '#D9EEE3' : '#FFFFFF').borderRadius(14)
              .gesture(LongPressGesture().onAction(() => {
                if (message.senderId !== this.myId) { this.reportMessageId = message.id; this.reportReason = ''; }
              }))
            if (message.senderId !== this.myId) { Blank().layoutWeight(1) }
          }.width('100%')
        }, (message: ChatMessage) => message.id.toString())
        if (this.hasMore) { Button('继续加载消息').onClick(() => { this.refresh(); }) }
      }.padding(16).width('100%')
    }.layoutWeight(1).width('100%')
    if (this.reportMessageId > 0) {
      Column({ space: 8 }) {
        TextInput({ text: this.reportReason, placeholder: '举报原因（1–300个字符）' }).maxLength(300)
          .onChange((value: string) => { this.reportReason = value; })
        Row({ space: 12 }) {
          Button('提交举报').enabled(!this.busy && this.reportReason.trim().length > 0).onClick(() => { this.report(); })
          Button('取消').onClick(() => { this.reportMessageId = 0; })
        }
      }.padding(12)
    }
    Row({ space: 10 }) {
      TextInput({ text: this.draft, placeholder: '写一句话…' }).maxLength(2000).layoutWeight(1)
        .onChange((value: string) => { this.draft = value; }).onSubmit(() => { this.send(); })
      Button('发送').backgroundColor('#176B59').enabled(!this.busy && this.draft.trim().length > 0)
        .onClick(() => { this.send(); })
    }.width('100%').padding(12)
  }
  build() {
    Column() {
      if (!this.token) {
        Scroll() { this.loginView() }.layoutWeight(1).width('100%')
      } else if (this.conversationId > 0) { this.chatView() }
      else { this.lobbyView() }
      if (this.busy) { Text('正在处理…').fontSize(12).fontColor('#64756F').padding(6) }
      if (this.status.length > 0) { Text(this.status).fontSize(13).fontColor('#A3442D').padding(12).width('100%') }
    }.height('100%').width('100%').backgroundColor('#F3F6F1')
  }
}
