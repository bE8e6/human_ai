@Component
export struct ReportPane {
  @Prop peerName: string = '';
  @Prop busy: boolean = false;
  @Link category: string;
  @Link reason: string;
  private categories: string[] = ['harassment','hate','sexual','scam','privacy','other'];
  onBack: () => void = () => {};
  onSubmit: () => void = () => {};
  onPolicy: () => void = () => {};
  build() {
    Scroll() {
      Column({space:16}) {
        Row({space:12}) {
          Button('返回聊天').onClick(() => {this.onBack();})
          Text('举报消息').fontSize(24).fontWeight(FontWeight.Bold)
        }.width('100%')
        Text('举报 '+this.peerName+' 的这条消息').fontSize(16)
        Select([{value:'骚扰'},{value:'辱骂与仇恨'},{value:'色情与不当内容'},{value:'诈骗'},{value:'侵犯隐私'},{value:'其他'}])
          .selected(this.categories.indexOf(this.category)).width('100%').enabled(!this.busy)
          .onSelect((index:number) => {this.category=this.categories[index];}).accessibilityText('举报分类')
        TextArea({text:this.reason,placeholder:'可补充原因和必要事实，最多300字'}).maxLength(300).height(150).enabled(!this.busy)
          .onChange((value:string) => {this.reason=value;}).accessibilityText('举报补充原因')
        Text('会保存被举报的一条消息作为必要证据。你可以在个人设置中查看处理状态，请如实举报。')
          .fontSize(13).fontColor($r('app.color.text_secondary'))
        Button('证据保存与隐私规则').enabled(!this.busy).onClick(() => {this.onPolicy();})
        Button('提交举报').enabled(!this.busy).backgroundColor($r('app.color.accent')).onClick(() => {this.onSubmit();})
      }.padding(20).width('100%').alignItems(HorizontalAlign.Start)
    }.width('100%').height('100%')
  }
}
