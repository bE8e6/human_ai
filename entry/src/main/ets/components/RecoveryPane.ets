@Component
export struct RecoveryPane {
  @Link email: string;
  @Link code: string;
  @Link password: string;
  @Prop busy: boolean = false;
  @Prop requested: boolean = false;
  @Prop expiresAt: number = 0;
  onBack: () => void = () => {};
  onRequest: () => void = () => {};
  onReset: () => void = () => {};
  build() {
    Scroll() {
      Column({space:16}) {
        Row({space:12}) {
          Button('返回登录').onClick(() => {this.onBack();})
          Text('找回密码').fontSize(26).fontWeight(FontWeight.Bold)
        }.width('100%')
        Text('使用已绑定并验证的邮箱找回密码。').fontSize(14).fontColor($r('app.color.text_secondary'))
        TextInput({text:this.email,placeholder:'已验证的邮箱'}).type(InputType.Email).maxLength(254)
          .onChange((value:string) => {this.email=value;}).accessibilityText('找回密码的邮箱')
        Button(this.requested?'重新获取验证码':'获取验证码').enabled(!this.busy && this.email.includes('@'))
          .onClick(() => {this.onRequest();})
        if (this.requested) {
          Text('若该邮箱已绑定并验证，将收到邮件。验证码有效至 '+new Date(this.expiresAt).toLocaleTimeString()+ '，最多尝试5次。')
            .fontSize(13).fontColor($r('app.color.text_secondary'))
          TextInput({text:this.code,placeholder:'邮件中的6位验证码'}).type(InputType.Number).maxLength(6)
            .onChange((value:string) => {this.code=value;}).accessibilityText('密码找回验证码')
          TextInput({text:this.password,placeholder:'新密码（8–128位）'}).type(InputType.Password).maxLength(128)
            .onChange((value:string) => {this.password=value;}).accessibilityText('找回后使用的新密码')
          Button('重置密码并退出旧设备').backgroundColor($r('app.color.accent'))
            .enabled(!this.busy && /^\d{6}$/.test(this.code) && this.password.length>=8)
            .onClick(() => {this.onReset();})
          Text('密码重置后，所有旧登录都会撤销。请用新密码重新登录。').fontSize(13).fontColor($r('app.color.text_secondary'))
        }
      }.padding(24).width('100%').alignItems(HorizontalAlign.Start)
    }.width('100%').height('100%')
  }
}
