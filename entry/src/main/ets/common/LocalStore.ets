import { asset } from '@kit.AssetStoreKit';
import { preferences } from '@kit.ArkData';
import { fileIo } from '@kit.CoreFileKit';
import { common } from '@kit.AbilityKit';
import { util } from '@kit.ArkTS';
import { BusinessError } from '@kit.BasicServicesKit';
import { Account, PendingMessage } from './Api';

export interface SavedSession { base: string; token: string; user: Account; expiresAt: number; }
export interface ConversationDraft { conversationId: number; text: string; }
export interface LocalChatState { ownerId: number; base: string; drafts: ConversationDraft[]; outbox: PendingMessage[]; }

// Tokens never enter Preferences or application backup. AssetStore encrypts them.
export class LocalStore {
  private config?: preferences.Preferences;
  private filePath: string;
  private alias: Uint8Array = util.TextEncoder.create().encodeInto('human-ai.session.v2');
  private operations: Promise<void> = Promise.resolve();
  constructor(context: common.UIAbilityContext) { this.filePath = context.filesDir + '/chat-state.json'; }
  async initialize(context: common.UIAbilityContext): Promise<void> {
    try { this.config = await preferences.getPreferences(context, { name: 'human-ai.config.v2' }); }
    catch { throw new Error('本地设置初始化失败，请检查设备存储'); }
  }
  private query(): asset.AssetMap {
    const query = new Map<asset.Tag, asset.Value>();
    query.set(asset.Tag.ALIAS, this.alias);
    return query;
  }
  async getBase(): Promise<string> {
    try { return this.config ? await this.config.get('base', '') as string : ''; }
    catch { throw new Error('无法读取服务地址设置'); }
  }
  async setBase(base: string): Promise<void> {
    if (!this.config) throw new Error('本地设置尚未准备好');
    try { await this.config.put('base', base); await this.config.flush(); }
    catch { throw new Error('无法保存服务地址'); }
  }
  async getDeviceId(): Promise<string> {
    if (!this.config) throw new Error('本地设置尚未准备好');
    try {
      let deviceId = await this.config.get('deviceId', '') as string;
      if (!deviceId) {
        deviceId = util.generateRandomUUID();
        await this.config.put('deviceId', deviceId); await this.config.flush();
      }
      return deviceId;
    } catch { throw new Error('无法保存设备编号'); }
  }
  async getRole(base: string, userId: number): Promise<string> {
    try {
      const role = this.config ? await this.config.get('role:' + base + ':' + userId, 'user') as string : 'user';
      return role === 'ai' ? 'ai' : 'user';
    } catch { throw new Error('无法读取上次身份'); }
  }
  async setRole(base: string, userId: number, role: string): Promise<void> {
    if (!this.config) return;
    try { await this.config.put('role:' + base + ':' + userId, role); await this.config.flush(); }
    catch { throw new Error('无法保存身份设置'); }
  }
  async readSession(): Promise<SavedSession | undefined> {
    // This tombstone also prevents login restoration if AssetStore removal failed.
    const query = this.query();
    query.set(asset.Tag.RETURN_TYPE, asset.ReturnType.ALL);
    try {
      if (!this.config || await this.config.get('loggedOut', true) as boolean) return undefined;
      const rows = await asset.query(query);
      if (rows.length === 0) return undefined;
      const secret = rows[0].get(asset.Tag.SECRET) as Uint8Array;
      return JSON.parse(util.TextDecoder.create('utf-8').decodeToString(secret)) as SavedSession;
    } catch (error) {
      if ((error as BusinessError).code === 24000002) return undefined;
      throw new Error('无法读取安全登录凭据，请解锁设备后重试或重新登录');
    }
  }
  saveSession(session: SavedSession): Promise<void> {
    // Keep the encrypted secret small; profile and email stay on the server.
    const minimal: SavedSession = {base:session.base,token:session.token,expiresAt:session.expiresAt,
      user:{id:session.user.id,username:session.user.username,accepting:session.user.accepting}};
    const work = this.operations.then(async () => {
      const values = this.query();
      values.set(asset.Tag.SECRET, util.TextEncoder.create().encodeInto(JSON.stringify(minimal)));
      values.set(asset.Tag.ACCESSIBILITY, asset.Accessibility.DEVICE_UNLOCKED);
      values.set(asset.Tag.SYNC_TYPE, asset.SyncType.NEVER);
      values.set(asset.Tag.CONFLICT_RESOLUTION, asset.ConflictResolution.OVERWRITE);
      await asset.add(values);
      if (!this.config) throw new Error('本地设置尚未准备好');
      await this.config.put('loggedOut', false);
      await this.config.flush();
    });
    this.operations = work.catch(() => {});
    return work;
  }
  clearSession(): Promise<void> {
    const work = this.operations.then(async () => {
      if (!this.config) throw new Error('本地设置尚未准备好');
      await this.config.put('loggedOut', true);
      await this.config.flush();
      try { await asset.remove(this.query()); }
      catch (error) { if ((error as BusinessError).code !== 24000002) throw new Error('登录已关闭，但安全凭据清理失败，请再次退出或重新登录'); }
    });
    this.operations = work.catch(() => {});
    return work;
  }
  readState(base: string, ownerId: number): LocalChatState {
    const empty: LocalChatState = { ownerId: ownerId, base: base, drafts: [], outbox: [] };
    try {
      if (!fileIo.accessSync(this.filePath)) return empty;
      const state = JSON.parse(fileIo.readTextSync(this.filePath)) as LocalChatState;
      if (state.ownerId !== ownerId || state.base !== base) return empty;
      state.outbox.forEach((item: PendingMessage) => {
        item.state = 'failed';
        item.error = '上次发送未确认，点击重试';
      });
      return state;
    } catch { throw new Error('无法读取本地草稿和待发送消息，请检查设备存储'); }
  }
  saveState(state: LocalChatState): void {
    const text = JSON.stringify(state);
    if (text.length > 1_000_000) throw new Error('本地草稿和待发送消息过多，请先处理失败消息');
    try {
      const temporary = this.filePath + '.tmp';
      const file = fileIo.openSync(temporary, fileIo.OpenMode.CREATE | fileIo.OpenMode.WRITE_ONLY | fileIo.OpenMode.TRUNC);
      try {
        if (fileIo.writeSync(file.fd, text) !== util.TextEncoder.create().encodeInto(text).byteLength) throw new Error('本地存储未完整写入');
        fileIo.fsyncSync(file.fd);
      } finally { fileIo.closeSync(file); }
      fileIo.renameSync(temporary, this.filePath);
    } catch { throw new Error('本地消息保存失败，请检查设备存储'); }
  }
  clearState(): void {
    try {
      if (fileIo.accessSync(this.filePath)) fileIo.unlinkSync(this.filePath);
      if (fileIo.accessSync(this.filePath + '.tmp')) fileIo.unlinkSync(this.filePath + '.tmp');
    } catch { throw new Error('本机聊天数据清理失败，请检查设备存储'); }
  }
}
