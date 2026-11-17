import { http } from '@kit.NetworkKit';

export interface Account { id: number; username: string; accepting: boolean; }
export interface Conversation { id: number; peerId: number; peerName: string; lastText: string; unread: number; }
export interface ChatMessage { id: number; senderId: number; text: string; createdAt: number; }
export interface ApiResult {
  token?: string;
  user?: Account;
  users?: Account[];
  conversations?: Conversation[];
  conversationId?: number;
  messages?: ChatMessage[];
  hasMore?: boolean;
  error?: string;
}
export class Api {
  static async request(base: string, path: string, token: string = '', payload: string = ''): Promise<ApiResult> {
    const client = http.createHttp();
    try {
      const response = await client.request(base.replace(/\/$/, '') + path, {
        method: payload.length > 0 ? http.RequestMethod.POST : http.RequestMethod.GET,
        header: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        extraData: payload, connectTimeout: 5000, readTimeout: 10000, usingCache: false
      });
      const result = JSON.parse(response.result as string) as ApiResult;
      if (response.responseCode < 200 || response.responseCode >= 300) throw new Error(result.error || '请求失败');
      return result;
    } catch (error) {
      const failure = error as Error;
      throw new Error(failure.message || '网络请求失败，请检查后端地址和网络连接');
    } finally { client.destroy(); }
  }
}
