import { LoginDevice } from '../common/Api';
import { AppConfig } from '../common/AppConfig';

@Component
export struct SettingsPane {
  @Prop myName: string = '';
  @Prop busy: boolean = false;
  @Prop devices: LoginDevice[] = [];
  @Link currentPassword: string;
  @Link newPassword: string;
  @Link nickname: string;
  @Link bio: string;
  @Link aiStyle: string;
  @Link aiTopics: string;
  @Link acceptingChoice: boolean;
  @Link busyChoice: boolean;
  @Link maxChats: string;
  @Link notificationEnabled: boolean;
  @Link notificationPreview: boolean;
  @Link emailInput: string;
  @Link emailCode: string;
  @Prop boundEmail: string = '';
  @Prop emailVerified: boolean = false;
  @Prop emailRequested: boolean = false;
  @Prop emailExpiresAt: number = 0;
  @Prop mailAvailable: boolean = false;
  @Prop capabilitiesKnown: boolean = false;
  @Prop activeChats: number = 0;
  @Prop profileDirty: boolean = false;
  @Prop availabilityDirty: boolean = false;
  @Prop preferencesDirty: boolean = false;
  onBack: () => void = () => {};
  onLogout: () => void = () => {};
  onPassword: () => void = () => {};
  onDevices: () => void = () => {};
  onRevoke: (sessionId: string) => void = () => {};
  onRevokeOthers: () => void = () => {};
  onProfile: () => void = () => {};
  onAvailability: () => void = () => {};
  onPreferences: () => void = () => {};
  onProfileDirty: () => void = () => {};
  onAvailabilityDirty: () => void = () => {};
  onPreferencesDirty: () => void = () => {};
  onEmailRequest: () => void = () => {};
  onEmailVerify: () => void = () => {};
  onEmailUnbind: () => void = () => {};
  onManage: (kind:string) => void = () => {};
  onPolicy: (kind:string) => void = () => {};
  onDelete: () => void = () => {};
  build() {
    Column() {
      Row({ space: 12 }) {
        Button('返回大厅').onClick(() => { this.onBack(); })
        Text('个人设置').fontSize(24).fontWeight(FontWeight.Bold)
      }.width('100%').padding(16)
      Scroll() {
        Column({ space: 16 }) {
          Text('@' + this.myName).fontSize(20)
          Text('用户名是固定登录标识。').fontSize(13).fontColor($r('app.color.text_secondary'))
          Text('个人资料').fontWeight(FontWeight.Bold).fontSize(20)
          TextInput({text:this.nickname,placeholder:'昵称（最多30字）'}).maxLength(30).enabled(!this.busy)
            .onChange((value:string) => {this.nickname=value;this.onProfileDirty();}).accessibilityText('昵称')
          TextArea({text:this.bio,placeholder:'个人简介（最多300字）'}).maxLength(300).height(90).enabled(!this.busy)
            .onChange((value:string) => {this.bio=value;this.onProfileDirty();}).accessibilityText('个人简介')
          TextArea({text:this.aiStyle,placeholder:'AI聊天风格（最多120字）'}).maxLength(120).height(70).enabled(!this.busy)
            .onChange((value:string) => {this.aiStyle=value;this.onProfileDirty();}).accessibilityText('AI聊天风格')
          TextInput({text:this.aiTopics,placeholder:'AI擅长话题（最多200字）'}).maxLength(200).enabled(!this.busy)
            .onChange((value:string) => {this.aiTopics=value;this.onProfileDirty();}).accessibilityText('AI擅长话题')
          Button('保存资料').enabled(!this.busy && this.profileDirty && this.nickname.trim().length>0).onClick(() => {this.onProfile();})
          Text('接聊设置').fontWeight(FontWeight.Bold).fontSize(20)
          Row() {
            Text('开放接收新对话').layoutWeight(1)
            Toggle({type:ToggleType.Switch,isOn:this.acceptingChoice}).enabled(!this.busy)
              .onChange((value:boolean) => {this.acceptingChoice=value;this.onAvailabilityDirty();}).accessibilityText('开放接聊')
          }.width('100%')
          Row() {
            Text('当前忙碌').layoutWeight(1)
            Toggle({type:ToggleType.Switch,isOn:this.busyChoice}).enabled(!this.busy)
              .onChange((value:boolean) => {this.busyChoice=value;this.onAvailabilityDirty();}).accessibilityText('忙碌状态')
          }.width('100%')
          TextInput({text:this.maxChats,placeholder:'接聊数量上限（1–100）'}).type(InputType.Number).maxLength(3).enabled(!this.busy)
            .onChange((value:string) => {this.maxChats=value;this.onAvailabilityDirty();}).accessibilityText('接聊数量上限')
          Text('当前可见的AI会话：'+this.activeChats+'。移出自己的AI会话可释放名额，暂停或忙碌时已有对话仍可回复。')
            .fontSize(12).fontColor($r('app.color.text_secondary'))
          Button('保存接聊设置').enabled(!this.busy && this.availabilityDirty).onClick(() => {this.onAvailability();})
          Text('通知设置').fontWeight(FontWeight.Bold).fontSize(20)
          Row() {
            Text('允许聊天提醒').layoutWeight(1)
            Toggle({type:ToggleType.Switch,isOn:this.notificationEnabled}).enabled(!this.busy)
              .onChange((value:boolean) => {this.notificationEnabled=value;this.onPreferencesDirty();}).accessibilityText('聊天通知开关')
          }.width('100%')
          Row() {
            Text('提醒中预览消息文字').layoutWeight(1)
            Toggle({type:ToggleType.Switch,isOn:this.notificationPreview}).enabled(!this.busy)
              .onChange((value:boolean) => {this.notificationPreview=value;this.onPreferencesDirty();}).accessibilityText('通知预览')
          }.width('100%')
          Button('保存通知设置').enabled(!this.busy && this.preferencesDirty).onClick(() => {this.onPreferences();})
          Text('后台和锁屏系统推送尚未接入，当前请在前台查看消息。会话免打扰可在聊天页面修改。')
            .fontSize(12).fontColor($r('app.color.text_secondary'))
          Text('确认当前密码').fontWeight(FontWeight.Bold).fontSize(20)
          Text('修改密码、绑定或解绑邮箱和注销账号时需要当前密码。').fontSize(12).fontColor($r('app.color.text_secondary'))
          TextInput({ text: this.currentPassword, placeholder: '当前密码' }).type(InputType.Password).maxLength(128).enabled(!this.busy)
            .onChange((value: string) => { this.currentPassword = value; }).accessibilityText('确认当前密码')
          Text('修改密码').fontWeight(FontWeight.Bold).fontSize(20)
          TextInput({ text: this.newPassword, placeholder: '新密码（8–128位）' }).type(InputType.Password).maxLength(128)
            .onChange((value: string) => { this.newPassword = value; })
          Button('修改并退出全部设备').enabled(!this.busy && this.currentPassword.length > 0 && this.newPassword.length >= 8)
            .onClick(() => { this.onPassword(); })
          Text('邮箱与找回密码').fontWeight(FontWeight.Bold).fontSize(20)
          Text(this.boundEmail?(this.boundEmail+(this.emailVerified?' · 已验证':' · 未验证')):'尚未绑定邮箱').fontSize(14)
          if (!this.mailAvailable) {
            Text(this.capabilitiesKnown?'邮件服务尚未启用，运营者完成配置后可绑定。':'连接服务后可获取邮件服务状态。')
              .fontSize(12).fontColor($r('app.color.text_secondary'))
          }
          TextInput({text:this.emailInput,placeholder:'要绑定或更换的邮箱'}).type(InputType.Email).maxLength(254).enabled(!this.busy)
            .onChange((value:string) => {this.emailInput=value;}).accessibilityText('邮箱地址')
          Button(this.emailRequested?'重新获取邮箱验证码':'发送邮箱验证码').enabled(!this.busy && this.mailAvailable && this.emailInput.includes('@') && this.currentPassword.length>=8)
            .onClick(() => {this.onEmailRequest();})
          if (this.emailRequested) {
            Text('验证码有效至 '+new Date(this.emailExpiresAt).toLocaleTimeString()+'，最多尝试5次。').fontSize(12).fontColor($r('app.color.text_secondary'))
            TextInput({text:this.emailCode,placeholder:'6位邮箱验证码'}).type(InputType.Number).maxLength(6)
              .onChange((value:string) => {this.emailCode=value;}).accessibilityText('邮箱验证码')
            Button('验证并绑定邮箱').enabled(!this.busy && /^\d{6}$/.test(this.emailCode)).onClick(() => {this.onEmailVerify();})
          }
          if (this.boundEmail) {Button('解绑邮箱').enabled(!this.busy && this.currentPassword.length>=8).onClick(() => {this.onEmailUnbind();})}
          Text('问题与安全').fontWeight(FontWeight.Bold).fontSize(20)
          Button('黑名单与解除拉黑').onClick(() => {this.onManage('blocks');})
          Button('我的举报与处理状态').onClick(() => {this.onManage('reports');})
          Button('管理员提醒').onClick(() => {this.onManage('notices');})
          Row({ space: 12 }) {
            Text('登录设备').fontSize(20).fontWeight(FontWeight.Bold).layoutWeight(1)
            Button('刷新').enabled(!this.busy).onClick(() => { this.onDevices(); })
          }.width('100%')
          ForEach(this.devices, (device: LoginDevice) => {
            Column({ space: 8 }) {
              Text(device.name + (device.current ? ' · 当前设备' : '')).fontWeight(FontWeight.Bold)
              Text('最近使用：' + new Date(device.lastSeen).toLocaleString()).fontSize(12)
              Text('到期时间：' + new Date(device.expiresAt).toLocaleString()).fontSize(12)
              if (!device.current) { Button('退出此设备').enabled(!this.busy).onClick(() => { this.onRevoke(device.id); }) }
            }.padding(14).width('100%').backgroundColor($r('app.color.surface')).borderRadius(14)
          }, (device: LoginDevice) => device.id)
          Button('退出其他设备').enabled(!this.busy).onClick(() => { this.onRevokeOthers(); })
          Button('退出账号 / 切换账号').backgroundColor($r('app.color.error')).onClick(() => { this.onLogout(); })
          Text('退出会清除本机草稿和待发送消息。断网时仍可退出；其他设备由服务端单独管理。')
            .fontSize(13).fontColor($r('app.color.text_secondary'))
          Row({space:12}) {
            Button('隐私政策').fontSize(12).onClick(() => {this.onPolicy('privacy');})
            Button('使用规则').fontSize(12).onClick(() => {this.onPolicy('rules');})
          }.width('100%')
          Button('注销账号').fontColor($r('app.color.error')).enabled(!this.busy && this.currentPassword.length>=8)
            .onClick(() => {this.onDelete();})
          Text('注销立即移除资料与本人消息正文，必要举报证据和备份按隐私政策的期限处理。').fontSize(12).fontColor($r('app.color.text_secondary'))
          Text('人机？ '+AppConfig.version+' · AI由真人回复').fontSize(13).fontColor($r('app.color.text_secondary'))
        }.padding(16).width('100%').alignItems(HorizontalAlign.Start)
      }.layoutWeight(1).width('100%')
    }.height('100%').width('100%')
  }
}
