import { MessageSource, MessageRow } from '../common/MessageSource';

@Component
export struct ChatPane {
  source: MessageSource = new MessageSource();
  scroller: Scroller = new Scroller();
  @Prop myId: number = 0;
  @Prop peerName: string = '';
  @Prop role: string = 'user';
  @Prop hasEarlier: boolean = false;
  @Prop loading: boolean = false;
  @Prop initialLoading: boolean = false;
  @Prop messagesReady: boolean = false;
  @Prop blocked: boolean = false;
  @Prop selfBlocked: boolean = false;
  @Prop peerUnavailable: boolean = false;
  @Prop muted: boolean = false;
  @Prop newCount: number = 0;
  @Prop peerReadId: number = 0;
  @Prop rowCount: number = 0;
  @Link draft: string;
  onBack: () => void = () => {};
  onEarlier: () => void = () => {};
  onSend: () => void = () => {};
  onRetry: (clientId: string) => void = () => {};
  onDraft: (value: string) => void = () => {};
  onVisible: (start: number,end: number) => void = () => {};
  onBottom: () => void = () => {};
  onBlock: (blocked: boolean) => void = () => {};
  onMute: () => void = () => {};
  onReportMessage: (messageId:number) => void = () => {};
  private historyGesture: boolean = false;

  build() {
    Column() {
      Row({ space: 12 }) {
        Button('返回').onClick(() => { this.onBack(); })
        Column({ space: 4 }) {
          Text(this.peerName).fontSize(20).fontWeight(FontWeight.Bold)
          Text(this.role === 'user' ? '对方是由真人扮演的 AI' : '你正在以 AI 身份回复').fontSize(12)
            .fontColor($r('app.color.text_secondary'))
        }.alignItems(HorizontalAlign.Start).layoutWeight(1)
      }.width('100%').padding(12)
      Row({ space: 8 }) {
        Button(this.selfBlocked ? '解除拉黑' : '拉黑').fontSize(12)
          .onClick(() => { this.onBlock(!this.selfBlocked); })
        Button(this.muted ? '恢复提醒' : '免打扰').fontSize(12).onClick(() => { this.onMute(); })
        if (this.blocked) {
          Text(this.selfBlocked ? '你已拉黑对方，发送已关闭' : '对方已拉黑，发送已关闭')
            .fontSize(12).fontColor($r('app.color.error')).layoutWeight(1)
        }
      }.padding({ left: 12, right: 12, bottom: 8 }).width('100%')
      if (this.peerUnavailable) {Text('对方账号当前不可用，发送已关闭').fontSize(12).fontColor($r('app.color.error')).padding(6)}
      if (this.hasEarlier) { Button(this.loading ? '加载中…' : '加载更早历史').enabled(!this.loading).onClick(() => { this.onEarlier(); }) }
      List({ space: 12, scroller: this.scroller }) {
        if (this.rowCount === 0) {
          ListItem() { Text(this.initialLoading ? '正在加载最近消息…' : this.messagesReady?'发送第一条消息吧':'消息尚未载入，请重试连接').fontColor($r('app.color.text_secondary')) }
        }
        LazyForEach(this.source, (message: MessageRow) => {
          ListItem() {
            Row() {
              if (message.senderId === this.myId) { Blank().layoutWeight(1) }
              Column({ space: 6 }) {
                Text(message.senderId === this.myId ? '我' : this.peerName).fontSize(12).fontColor($r('app.color.text_secondary'))
                Text(message.text).fontSize(16).fontColor($r('app.color.text_primary')).width('100%')
                  .copyOption(CopyOptions.LocalDevice).accessibilityText(message.text)
                Text(new Date(message.createdAt).toLocaleString()).fontSize(10).fontColor($r('app.color.text_secondary'))
                if (message.senderId === this.myId) {
                  Text(message.state === 'failed' ? '发送失败 · ' + message.error : message.state === 'queued' || message.state === 'sending' ? '发送中…' : message.id <= this.peerReadId ? '已发送 · 对方已读' : '已发送')
                    .fontSize(12).fontColor(message.state === 'failed' ? $r('app.color.error') : $r('app.color.text_secondary'))
                  if (message.state === 'failed') {
                    Button('重试').fontSize(12).enabled(!this.blocked && !this.peerUnavailable)
                      .onClick(() => { this.onRetry(message.clientMessageId || ''); })
                  }
                } else {
                  if (!message.redacted) {Button('举报').fontSize(12).onClick(() => { this.onReportMessage(message.id); })}
                }
              }.alignItems(HorizontalAlign.Start).padding(12).width('82%')
                .backgroundColor(message.senderId === this.myId ? $r('app.color.bubble_self') : $r('app.color.surface')).borderRadius(14)
              if (message.senderId !== this.myId) { Blank().layoutWeight(1) }
            }.width('100%')
          }
        }, (message: MessageRow) => message.clientMessageId ? 'client:' + message.senderId + ':' + message.clientMessageId : 'server:' + message.id)
      }.layoutWeight(1).width('100%').padding({ left: 12, right: 12 }).cachedCount(6)
        .maintainVisibleContentPosition(true).onScrollIndex((start: number, end: number) => { this.onVisible(start,end); })
        .onWillScroll((offset: number, state: ScrollState, source: ScrollSource) => {
          if (source===ScrollSource.DRAG || source===ScrollSource.FLING || source===ScrollSource.OTHER_USER_INPUT ||
            source===ScrollSource.SCROLL_BAR || source===ScrollSource.SCROLL_BAR_FLING) this.historyGesture=true;
          else if (source===ScrollSource.SCROLLER || source===ScrollSource.SCROLLER_ANIMATION) this.historyGesture=false;
          return { offsetRemain: offset };
        })
        .onReachStart(() => {
          const gesture=this.historyGesture;this.historyGesture=false;
          if (gesture && this.hasEarlier && !this.loading && !this.initialLoading && this.messagesReady) this.onEarlier();
        }).onScrollStop(() => {this.historyGesture=false;})
      if (this.newCount > 0) { Button('有 ' + this.newCount + ' 条新消息').onClick(() => { this.onBottom(); }) }
      Row({ space: 10 }) {
        TextArea({ text: this.draft, placeholder: this.blocked || this.peerUnavailable ? '当前不能发送消息' : '输入文字，换行继续编辑' })
          .maxLength(2000).layoutWeight(1).constraintSize({ minHeight: 48, maxHeight: 120 })
          .enabled(!this.blocked && !this.peerUnavailable).onChange((value: string) => { this.onDraft(value); }).accessibilityText('聊天输入框')
        Button('发送').backgroundColor($r('app.color.accent')).enabled(!this.blocked && !this.peerUnavailable && this.draft.trim().length > 0)
          .onClick(() => { this.onSend(); })
      }.width('100%').padding(12)
    }.height('100%').width('100%')
  }
}
