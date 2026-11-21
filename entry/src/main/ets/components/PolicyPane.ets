import { PRIVACY_TEXT, RULES_TEXT } from '../common/Policy';

@Component
export struct PolicyPane {
  @Prop kind: string = 'privacy';
  onBack: () => void = () => {};
  build() {
    Column() {
      Row({space:12}) {
        Button('返回').onClick(() => {this.onBack();})
        Text(this.kind==='privacy'?'隐私政策':'使用规则').fontSize(22).fontWeight(FontWeight.Bold)
      }.padding(16).width('100%')
      Scroll() {
        Text(this.kind==='privacy'?PRIVACY_TEXT:RULES_TEXT).fontSize(16).fontColor($r('app.color.text_primary'))
          .lineHeight(26).copyOption(CopyOptions.LocalDevice).width('100%').padding(20)
      }.layoutWeight(1).width('100%')
    }.width('100%').height('100%')
  }
}
