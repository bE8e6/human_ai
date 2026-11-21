import { Account, UserReport, ServiceNotice } from '../common/Api';
import { ListSource } from '../common/ListSource';

@Component
export struct ManagementPane {
  @Prop kind: string = 'blocks';
  @Prop @Watch('updateSources') users: Account[] = [];
  @Prop @Watch('updateSources') reports: UserReport[] = [];
  @Prop @Watch('updateSources') notices: ServiceNotice[] = [];
  @Prop loading: boolean = false;
  @Prop hasMore: boolean = false;
  private userSource: ListSource<Account> = new ListSource<Account>((row:Account) => row.id.toString());
  private reportSource: ListSource<UserReport> = new ListSource<UserReport>((row:UserReport) => row.id.toString());
  private noticeSource: ListSource<ServiceNotice> = new ListSource<ServiceNotice>((row:ServiceNotice) => row.id.toString());
  onBack: () => void = () => {};
  onRefresh: () => void = () => {};
  onMore: () => void = () => {};
  onUnblock: (userId:number) => void = () => {};
  aboutToAppear(): void {this.updateSources();}
  private updateSources(): void {this.userSource.replace(this.users);this.reportSource.replace(this.reports);this.noticeSource.replace(this.notices);}
  private category(value:string): string {
    switch(value) {
      case 'harassment': return '骚扰';
      case 'hate': return '辱骂与仇恨';
      case 'sexual': return '色情与不当内容';
      case 'scam': return '诈骗';
      case 'privacy': return '侵犯隐私';
      default: return '其他';
    }
  }
  build() {
    Column({space:12}) {
      Row({space:12}) {
        Button('返回设置').onClick(() => {this.onBack();})
        Text(this.kind==='blocks'?'黑名单':this.kind==='reports'?'我的举报':'服务提醒').fontSize(22).fontWeight(FontWeight.Bold).layoutWeight(1)
        Button('刷新').enabled(!this.loading).onClick(() => {this.onRefresh();})
      }.width('100%').padding(12)
      List({space:12}) {
        if (this.kind==='blocks') {
          if (!this.users.length) {ListItem() {Text(this.loading?'正在加载…':'黑名单为空').fontColor($r('app.color.text_secondary'))}}
          LazyForEach(this.userSource,(user:Account) => {
            ListItem() {
              Row({space:12}) {
                Text(user.nickname || user.username).layoutWeight(1).fontWeight(FontWeight.Bold)
                Button('解除拉黑').enabled(!this.loading).onClick(() => {this.onUnblock(user.id);})
              }.padding(16).width('100%').backgroundColor($r('app.color.surface')).borderRadius(14)
            }
          },(user:Account) => user.id.toString())
        } else if (this.kind==='reports') {
          if (!this.reports.length) {ListItem() {Text(this.loading?'正在加载…':'还没有提交的举报').fontColor($r('app.color.text_secondary'))}}
          LazyForEach(this.reportSource,(report:UserReport) => {
            ListItem() {
              Column({space:8}) {
                Text(this.category(report.category)+' · #'+report.id).fontWeight(FontWeight.Bold)
                Text(report.status==='pending'?'等待处理':report.status==='resolved'?'已处理':'不予处理').fontColor($r('app.color.accent'))
                if (report.reason) {Text(report.reason).fontSize(14)}
                if (report.result) {Text('处理结果：'+report.result).fontSize(14)}
                Text('提交：'+new Date(report.createdAt).toLocaleString()).fontSize(12).fontColor($r('app.color.text_secondary'))
                if (report.handledAt) {Text('处理：'+new Date(report.handledAt).toLocaleString()).fontSize(12).fontColor($r('app.color.text_secondary'))}
              }.padding(16).width('100%').alignItems(HorizontalAlign.Start).backgroundColor($r('app.color.surface')).borderRadius(14)
            }
          },(report:UserReport) => report.id.toString())
        } else {
          if (!this.notices.length) {ListItem() {Text(this.loading?'正在加载…':'暂无服务提醒').fontColor($r('app.color.text_secondary'))}}
          LazyForEach(this.noticeSource,(notice:ServiceNotice) => {
            ListItem() {
              Column({space:8}) {
                Text(notice.reason).fontSize(16)
                Text(new Date(notice.createdAt).toLocaleString()).fontSize(12).fontColor($r('app.color.text_secondary'))
              }.padding(16).width('100%').alignItems(HorizontalAlign.Start).backgroundColor($r('app.color.surface')).borderRadius(14)
            }
          },(notice:ServiceNotice) => notice.id.toString())
        }
        if (this.hasMore) {ListItem() {Button(this.loading?'正在加载…':'加载更多').enabled(!this.loading).onClick(() => {this.onMore();})}}
      }.layoutWeight(1).width('100%').padding({left:16,right:16}).cachedCount(4)
    }.width('100%').height('100%')
  }
}
