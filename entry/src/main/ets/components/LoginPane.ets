import { AppConfig } from '../common/AppConfig';

@Component
export struct LoginPane {
  @Link baseUrl: string;
  @Link username: string;
  @Link password: string;
  @Link loginMode: string;
  @Link termsAccepted: boolean;
  @Prop busy: boolean = false;
  @State submitted: boolean = false;
  onAuthenticate: (register: boolean) => void = () => {};
  onRecovery: () => void = () => {};
  onPolicy: (kind: string) => void = () => {};
  onSaveBase: () => void = () => {};
  private submit(): void {
    this.submitted = true;
    if (!/^[a-zA-Z0-9_]{3,24}$/.test(this.username.trim()) || this.password.length < 8) return;
    if (this.loginMode==='register' && !this.termsAccepted) return;
    this.onAuthenticate(this.loginMode === 'register');
  }
  build() {
    Scroll() {
      Column({ space: 16 }) {
        Text('人机？').fontSize(38).fontWeight(FontWeight.Bold).fontColor($r('app.color.accent'))
        Text('AI 的身份，真人的回应').fontSize(16).fontColor($r('app.color.text_secondary'))
        Text(this.loginMode === 'register' ? '创建账号' : '欢迎回来').fontSize(24).fontWeight(FontWeight.Bold)
        if (AppConfig.development) {
          TextInput({ text: this.baseUrl, placeholder: '开发服务地址 https://… 或 http://…' })
            .onChange((value: string) => { this.baseUrl = value; }).accessibilityText('开发服务地址')
          Button('保存开发地址').enabled(!this.busy).onClick(() => {this.onSaveBase();})
        }
        TextInput({ text: this.username, placeholder: '用户名（稳定的登录标识）' }).maxLength(24)
          .onChange((value: string) => { this.username = value; }).accessibilityText('用户名')
        if (this.submitted && !/^[a-zA-Z0-9_]{3,24}$/.test(this.username.trim())) {
          Text('用户名需为3–24位字母、数字或下划线').fontSize(13).fontColor($r('app.color.error'))
        }
        TextInput({ text: this.password, placeholder: '密码（8–128位）' }).type(InputType.Password).maxLength(128)
          .onChange((value: string) => { this.password = value; }).onSubmit(() => { this.submit(); })
          .accessibilityText('密码')
        if (this.submitted && this.password.length < 8) {
          Text('密码至少需要8位').fontSize(13).fontColor($r('app.color.error'))
        }
        if (this.loginMode==='register') {
          Row({space:8}) {
            Checkbox({name:'policy'}).select(this.termsAccepted).onChange((value:boolean) => {this.termsAccepted=value;})
              .accessibilityText('同意隐私政策和使用规则')
            Text('我已阅读并同意隐私政策和使用规则').layoutWeight(1).fontSize(13)
          }.width('100%')
        }
        Row({space:12}) {
          Button('隐私政策').fontSize(12).enabled(!this.busy).onClick(() => {this.onPolicy('privacy');})
          Button('使用规则').fontSize(12).enabled(!this.busy).onClick(() => {this.onPolicy('rules');})
        }
        Button(this.loginMode === 'register' ? '注册并登录' : '登录').width('100%')
          .backgroundColor($r('app.color.accent')).enabled(!this.busy && (this.loginMode!=='register' || this.termsAccepted)).onClick(() => { this.submit(); })
        Button(this.loginMode === 'register' ? '已有账号，返回登录' : '没有账号，创建账号')
          .enabled(!this.busy).onClick(() => {
            this.loginMode = this.loginMode === 'register' ? 'login' : 'register';
            this.submitted = false;
            this.password = '';
            this.termsAccepted = false;
          })
        if (this.loginMode==='login') {Button('忘记密码').enabled(!this.busy).onClick(() => {this.onRecovery();})}
        Text('AI 由真人扮演，回复可能需要等待。注册后可切换用户／AI身份。').fontSize(13)
          .fontColor($r('app.color.text_secondary'))
        Text('登录凭据保存在设备安全存储中，重启后可自动恢复登录。')
          .fontSize(12).fontColor($r('app.color.text_secondary'))
        Text(AppConfig.version + ' · 小范围测试版').fontSize(12).fontColor($r('app.color.text_secondary'))
      }.padding(24).width('100%')
    }.width('100%').height('100%')
  }
}
