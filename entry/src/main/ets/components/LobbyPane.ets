import { Account, Conversation, UnreadTotals } from '../common/Api';
import { ListSource } from '../common/ListSource';

@Component
export struct LobbyPane {
  @Prop myName: string = '';
  @Prop displayName: string = '';
  @Prop role: string = 'user';
  @Prop accepting: boolean = false;
  @Prop busy: boolean = false;
  @Prop @Watch('updateSources') ais: Account[] = [];
  @Prop @Watch('updateSources') conversations: Conversation[] = [];
  @Prop aiBusy: boolean = false;
  @Prop activeChats: number = 0;
  @Prop maxChats: number = 10;
  @Prop unread: UnreadTotals = { user: 0, ai: 0 };
  @Prop hasMore: boolean = false;
  @Prop aiHasMore: boolean = false;
  @Link search: string;
  @Link aiSort: string;
  private aiSource: ListSource<Account> = new ListSource<Account>((row:Account) => row.id.toString());
  private conversationSource: ListSource<Conversation> = new ListSource<Conversation>((row:Conversation) => row.id.toString());
  onRole: (role: string) => void = () => {};
  onAccepting: () => void = () => {};
  onBegin: (ai: Account) => void = () => {};
  onOpen: (conversation: Conversation) => void = () => {};
  onMore: () => void = () => {};
  onAiMore: () => void = () => {};
  onRefresh: () => void = () => {};
  onSettings: () => void = () => {};
  onPin: (conversation: Conversation) => void = () => {};
  onHide: (conversation: Conversation) => void = () => {};
  aboutToAppear(): void {this.updateSources();}
  private updateSources(): void {this.aiSource.replace(this.ais);this.conversationSource.replace(this.conversations);}

  build() {
    Column({ space: 12 }) {
      Row() {
        Column({ space: 4 }) {
          Text('人机？').fontSize(26).fontWeight(FontWeight.Bold).fontColor($r('app.color.accent'))
          Text((this.displayName || this.myName)+' · @'+this.myName).fontSize(13).maxLines(1)
            .textOverflow({overflow:TextOverflow.Ellipsis}).fontColor($r('app.color.text_secondary'))
        }.alignItems(HorizontalAlign.Start).layoutWeight(1)
        Button('设置').onClick(() => { this.onSettings(); })
      }.width('100%').padding({ left: 16, right: 16, top: 12 })
      Row({ space: 12 }) {
        Button('用户 · ' + this.unread.user).layoutWeight(1)
          .backgroundColor(this.role === 'user' ? $r('app.color.accent') : $r('app.color.inactive'))
          .onClick(() => { this.onRole('user'); })
        Button('AI · ' + this.unread.ai).layoutWeight(1)
          .backgroundColor(this.role === 'ai' ? $r('app.color.accent') : $r('app.color.inactive'))
          .onClick(() => { this.onRole('ai'); })
      }.width('100%').padding({ left: 16, right: 16 })
      Row({ space: 8 }) {
        TextInput({ text: this.search, placeholder: '搜索联系人或聊天关键词' }).layoutWeight(1).maxLength(100)
          .onChange((value: string) => { this.search = value; }).onSubmit(() => { this.onRefresh(); })
          .accessibilityText('搜索联系人或聊天关键词')
        Button('查找').onClick(() => { this.onRefresh(); })
      }.padding({ left: 16, right: 16 })
      List({ space: 12 }) {
        if (this.role === 'ai') {
          ListItem() {
            Column({ space: 8 }) {
              Text('你以 AI 身份回复，聊天内容由你本人输入。').fontSize(13)
              Button(this.accepting ? '暂停新对话' : '开放接聊').backgroundColor($r('app.color.accent'))
                .enabled(!this.busy).onClick(() => { this.onAccepting(); })
              Text('暂停接聊后，已有对话仍可回复。').fontSize(12).fontColor($r('app.color.text_secondary'))
              Text((this.aiBusy?'当前忙碌 · ':'')+'接聊 '+this.activeChats+'/'+this.maxChats+' · 在设置中修改状态和上限')
                .fontSize(12).fontColor($r('app.color.text_secondary'))
            }.width('100%')
          }
        } else {
          ListItem() {
            Row() {
              Text('可聊天的 AI').fontSize(20).fontWeight(FontWeight.Bold).layoutWeight(1)
              Select([{value:'最近加入'},{value:'可接聊优先'},{value:'昵称排序'}])
                .selected(this.aiSort==='available'?1:this.aiSort==='name'?2:0).font({size:13})
                .onSelect((index:number) => {this.aiSort=index===1?'available':index===2?'name':'recent';this.onRefresh();})
            }.width('100%')
          }
          if (this.ais.length === 0) {
            ListItem() { Text('暂无符合条件的 AI，可刷新或换个关键词。').fontColor($r('app.color.text_secondary')) }
          }
          LazyForEach(this.aiSource, (ai: Account) => {
            ListItem() {
              Row({ space: 12 }) {
                Text((ai.nickname || ai.username).substring(0, 1).toUpperCase()).fontSize(22).fontWeight(FontWeight.Bold)
                  .width(42).height(42).textAlign(TextAlign.Center).backgroundColor($r('app.color.bubble_self')).borderRadius(21)
                Column({ space: 4 }) {
                  Text(ai.nickname || ai.username).fontWeight(FontWeight.Bold).maxLines(1).textOverflow({overflow:TextOverflow.Ellipsis})
                  Text('真人回复 · '+(ai.busy?'忙碌':ai.available===false?'名额已满':'开放接聊')+' · ' + (ai.online ? '在线' : '离线')).fontSize(12).fontColor($r('app.color.text_secondary'))
                  if (ai.aiStyle || ai.bio) {Text(ai.aiStyle || ai.bio || '').fontSize(12).maxLines(1).textOverflow({overflow:TextOverflow.Ellipsis}).fontColor($r('app.color.text_secondary'))}
                  if (ai.aiTopics) {Text('话题：'+ai.aiTopics).fontSize(12).maxLines(1).textOverflow({overflow:TextOverflow.Ellipsis}).fontColor($r('app.color.text_secondary'))}
                }.alignItems(HorizontalAlign.Start).layoutWeight(1)
                Button('聊聊').backgroundColor($r('app.color.accent')).enabled(!this.busy)
                  .onClick(() => { this.onBegin(ai); })
              }.padding(12).width('100%').backgroundColor($r('app.color.surface')).borderRadius(14)
            }
          }, (ai: Account) => ai.id.toString())
          if (this.aiHasMore) { ListItem() { Button('更多 AI').onClick(() => { this.onAiMore(); }) } }
        }
        ListItem() {
          Row() {
            Text(this.role === 'user' ? '我的对话' : '收到的对话').fontSize(20).fontWeight(FontWeight.Bold).layoutWeight(1)
            Button('刷新').onClick(() => { this.onRefresh(); })
          }.width('100%')
        }
        if (this.conversations.length === 0) { ListItem() { Text('还没有符合条件的对话').fontColor($r('app.color.text_secondary')) } }
        LazyForEach(this.conversationSource, (conversation: Conversation) => {
          ListItem() {
            Column({ space: 8 }) {
              Column({space:8}) {
                Row({ space: 6 }) {
                  Text((conversation.pinned ? '置顶 · ' : '') + conversation.peerName).fontWeight(FontWeight.Bold).layoutWeight(1)
                  if (conversation.unread > 0) { Text(conversation.unread + ' 未读').fontSize(12).fontColor($r('app.color.error')) }
                }.width('100%')
                Text(conversation.lastText).maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
                  .fontSize(14).fontColor($r('app.color.text_secondary')).width('100%')
                Text(conversation.lastAt ? new Date(conversation.lastAt).toLocaleString() : '还没有消息').fontSize(10)
                  .fontColor($r('app.color.text_secondary'))
              }.width('100%').alignItems(HorizontalAlign.Start).onClick(() => { this.onOpen(conversation); })
              Row({ space: 8 }) {
                Blank().layoutWeight(1)
                if (conversation.muted) { Text('免打扰').fontSize(12) }
                Button(conversation.pinned ? '取消置顶' : '置顶').fontSize(12)
                  .onClick(() => { this.onPin(conversation); })
                Button('移出列表').fontSize(12).onClick(() => { this.onHide(conversation); })
              }.width('100%')
            }.padding(14).width('100%').backgroundColor($r('app.color.surface')).borderRadius(14)
          }
        }, (conversation: Conversation) => conversation.id.toString())
        if (this.hasMore) { ListItem() { Button('加载更多会话').onClick(() => { this.onMore(); }) } }
      }.layoutWeight(1).width('100%').padding({ left: 16, right: 16 }).cachedCount(4)
    }.width('100%').height('100%')
  }
}
