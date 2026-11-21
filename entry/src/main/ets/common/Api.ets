import { http } from '@kit.NetworkKit';

export interface Account {
  id: number; username: string; accepting: boolean; online?: boolean; nickname?: string; bio?: string;
  aiStyle?: string; aiTopics?: string; busy?: boolean; maxChats?: number; activeChats?: number; available?: boolean;
  email?: string; emailVerified?: boolean; notificationEnabled?: boolean; notificationPreview?: boolean;
}
export interface Conversation {
  id: number; peerId: number; peerName: string; lastText: string; unread: number;
  lastAt: number; lastMessageId: number; pinned: boolean; muted: boolean;
  role?: string; blocked?: boolean; selfBlocked?: boolean; peerBlocked?: boolean;
  hidden?: boolean;
  peerUnavailable?: boolean;
}
export interface ChatMessage { id: number; senderId: number; text: string; createdAt: number; clientMessageId?: string; redacted?: number; }
export interface PendingMessage {
  clientMessageId: string; conversationId: number; text: string; createdAt: number;
  order: number; state: string; error: string;
}
export interface LoginDevice { id: string; name: string; createdAt: number; lastSeen: number; expiresAt: number; current: boolean; }
export interface UnreadTotals { user: number; ai: number; }
export interface UserReport { id: number; messageId: number; category: string; reason: string; status: string; result: string; createdAt: number; handledAt?: number; }
export interface ServiceNotice { id: number; reason: string; createdAt: number; readAt?: number; }
export interface ApiResult {
  token?: string;
  expiresAt?: number;
  user?: Account;
  users?: Account[];
  conversations?: Conversation[];
  conversationId?: number;
  conversation?: Conversation;
  messages?: ChatMessage[];
  message?: ChatMessage;
  messageId?: number;
  replayed?: boolean;
  devices?: LoginDevice[];
  unread?: UnreadTotals;
  cursor?: number;
  nextCursor?: string;
  hasMore?: boolean;
  hasEarlier?: boolean;
  peerReadId?: number;
  selfBlocked?: boolean;
  peerBlocked?: boolean;
  blocked?: boolean;
  peerUnavailable?: boolean;
  historyVersion?: number;
  peerName?: string;
  reports?: UserReport[];
  notices?: ServiceNotice[];
  challengeId?: string;
  mailAvailable?: boolean;
  pushAvailable?: boolean;
  messageText?: string;
  error?: string;
  code?: string;
}
export class ApiFailure extends Error {
  status: number;
  code: string;
  constructor(message: string, status: number, code: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
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
      let result: ApiResult;
      try { result = JSON.parse(response.result as string) as ApiResult; }
      catch { throw new ApiFailure('服务暂时不可用',response.responseCode >= 500 ? response.responseCode : 502,'SERVER_UNAVAILABLE'); }
      if (!result) throw new ApiFailure('服务响应无效，请稍后重试',502,'SERVER_UNAVAILABLE');
      if (response.responseCode < 200 || response.responseCode >= 300) {
        throw new ApiFailure(result.error || '请求失败', response.responseCode, result.code || 'REQUEST_FAILED');
      }
      return result;
    } catch (error) {
      if (error instanceof ApiFailure) throw error;
      throw new ApiFailure('网络连接失败，请检查网络或稍后重试', 0, 'NETWORK_ERROR');
    } finally { client.destroy(); }
  }
}
