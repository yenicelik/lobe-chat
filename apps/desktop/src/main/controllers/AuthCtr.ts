import { BrowserWindow, shell } from 'electron';
import crypto from 'node:crypto';
import querystring from 'node:querystring';
import { URL } from 'node:url';

import RemoteServerConfigCtr from './RemoteServerConfigCtr';
import { ControllerModule, ipcClientEvent } from './index';

/**
 * 认证控制器
 * 用于实现OAuth授权流程
 */
export default class AuthCtr extends ControllerModule {
  /**
   * 远程服务器配置控制器
   */
  private remoteServerConfigCtr: RemoteServerConfigCtr;

  constructor(app) {
    super(app);

    // 获取远程服务器配置控制器
    this.remoteServerConfigCtr = app.controllers.get(RemoteServerConfigCtr);

    // 注册自定义协议处理
    this.registerProtocolHandler();
  }

  /**
   * 当前的 PKCE 参数
   */
  private codeVerifier: string | null = null;
  private authRequestState: string | null = null;

  /**
   * 请求 OAuth 授权
   */
  @ipcClientEvent('requestAuthorization')
  async requestAuthorization(serverUrl: string) {
    try {
      // 首先更新服务器URL配置
      await this.remoteServerConfigCtr.setRemoteServerConfig({
        isRemoteServerActive: false,
        remoteServerUrl: serverUrl, // 授权成功后再设置为true
      });

      // 生成 PKCE 参数
      const codeVerifier = this.generateCodeVerifier();
      const codeChallenge = await this.generateCodeChallenge(codeVerifier);
      this.codeVerifier = codeVerifier;

      // 生成状态参数，用于防止CSRF攻击
      this.authRequestState = crypto.randomBytes(16).toString('hex');

      // 构造授权URL
      const authUrl = new URL('/oauth/authorize', serverUrl);

      // 添加查询参数
      authUrl.search = querystring.stringify({
        client_id: 'lobe-chat-desktop',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        redirect_uri: 'lobe-chat-desktop://auth/callback',
        response_type: 'code',
        scope: 'profile sync api',
        state: this.authRequestState,
      });

      // 在默认浏览器中打开授权URL
      await shell.openExternal(authUrl.toString());

      return { success: true };
    } catch (error) {
      console.error('请求授权失败:', error);
      return { error: error.message, success: false };
    }
  }

  /**
   * 注册自定义协议处理
   */
  private registerProtocolHandler() {
    // 处理自定义协议回调
    // 实际上这个应该通过 app.setAsDefaultProtocolClient 和 app.on('open-url') 注册
    // 但这个函数需要在App.ts的启动流程中调用
    console.log('已注册 auth/callback 自定义协议处理');
  }

  /**
   * 处理授权回调
   * 当浏览器重定向到我们的自定义协议时调用此方法
   */
  async handleAuthCallback(callbackUrl: string) {
    try {
      const url = new URL(callbackUrl);
      const params = new URLSearchParams(url.search);

      // 获取授权码
      const code = params.get('code');
      const state = params.get('state');

      // 验证状态参数，防止CSRF攻击
      if (state !== this.authRequestState) {
        throw new Error('Invalid state parameter');
      }

      if (!code) {
        throw new Error('No authorization code received');
      }

      // 获取配置信息
      const config = await this.remoteServerConfigCtr.getRemoteServerConfig();

      if (!config.remoteServerUrl) {
        throw new Error('No server URL configured');
      }

      // 获取之前保存的code_verifier
      const codeVerifier = this.codeVerifier;
      if (!codeVerifier) {
        throw new Error('No code verifier found');
      }

      // 交换授权码获取令牌
      const result = await this.exchangeCodeForToken(config.remoteServerUrl, code, codeVerifier);

      if (result.success) {
        // 通知渲染进程授权成功
        this.broadcastAuthorizationSuccessful();
      } else {
        // 通知渲染进程授权失败
        this.broadcastAuthorizationFailed(result.error || 'Unknown error');
      }

      return result;
    } catch (error) {
      console.error('处理授权回调失败:', error);

      // 通知渲染进程授权失败
      this.broadcastAuthorizationFailed(error.message);

      return { error: error.message, success: false };
    } finally {
      // 清除授权请求状态
      this.authRequestState = null;
      this.codeVerifier = null;
    }
  }

  /**
   * 交换授权码获取令牌
   */
  private async exchangeCodeForToken(serverUrl: string, code: string, codeVerifier: string) {
    try {
      const tokenUrl = new URL('/oauth/token', serverUrl);

      // 构造请求体
      const body = querystring.stringify({
        client_id: 'lobe-chat-desktop',
        code,
        code_verifier: codeVerifier,
        grant_type: 'authorization_code',
        redirect_uri: 'lobe-chat-desktop://auth/callback',
      });

      // 发送请求获取令牌
      const response = await fetch(tokenUrl.toString(), {
        body,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        method: 'POST',
      });

      if (!response.ok) {
        // 尝试解析错误响应
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          `获取令牌失败: ${response.status} ${response.statusText} ${
            errorData.error_description || errorData.error || ''
          }`,
        );
      }

      // 解析响应
      const data = await response.json();

      // 确保响应包含必要的字段
      if (!data.access_token || !data.refresh_token) {
        throw new Error('Invalid token response: missing required fields');
      }

      // 保存令牌
      await this.remoteServerConfigCtr.saveTokens(data.access_token, data.refresh_token);

      // 设置服务器为激活状态
      await this.remoteServerConfigCtr.setRemoteServerConfig({
        isRemoteServerActive: true,
        remoteServerUrl: serverUrl,
      });

      return { success: true };
    } catch (error) {
      console.error('交换授权码失败:', error);
      return { error: error.message, success: false };
    }
  }

  /**
   * 刷新访问令牌
   */
  @ipcClientEvent('refreshAccessToken')
  async refreshAccessToken() {
    try {
      // 检查是否已在刷新
      if (this.remoteServerConfigCtr.isTokenRefreshing()) {
        return { error: 'Token refresh already in progress', success: false };
      }

      // 标记为正在刷新
      this.remoteServerConfigCtr.setTokenRefreshing(true);

      // 获取配置信息
      const config = await this.remoteServerConfigCtr.getRemoteServerConfig();

      if (!config.remoteServerUrl || !config.isRemoteServerActive) {
        throw new Error('Remote server not active');
      }

      // 获取刷新令牌
      const refreshToken = await this.remoteServerConfigCtr.getRefreshToken();
      if (!refreshToken) {
        throw new Error('No refresh token available');
      }

      // 构造刷新请求
      const tokenUrl = new URL('/oauth/token', config.remoteServerUrl);

      // 构造请求体
      const body = querystring.stringify({
        client_id: 'lobe-chat-desktop',
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      });

      // 发送请求
      const response = await fetch(tokenUrl.toString(), {
        body,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        method: 'POST',
      });

      if (!response.ok) {
        // 尝试解析错误响应
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          `刷新令牌失败: ${response.status} ${response.statusText} ${
            errorData.error_description || errorData.error || ''
          }`,
        );
      }

      // 解析响应
      const data = await response.json();

      // 确保响应包含必要的字段
      if (!data.access_token) {
        throw new Error('Invalid token response: missing required fields');
      }

      // 保存新令牌
      await this.remoteServerConfigCtr.saveTokens(
        data.access_token,
        data.refresh_token || refreshToken, // 如果没有新的刷新令牌，使用旧的
      );

      // 通知渲染进程令牌已刷新
      this.broadcastTokenRefreshed();

      return { success: true };
    } catch (error) {
      console.error('刷新令牌失败:', error);

      // 刷新失败，清除令牌并禁用远程服务器
      await this.remoteServerConfigCtr.clearTokens();
      await this.remoteServerConfigCtr.setRemoteServerConfig({
        isRemoteServerActive: false,
        remoteServerUrl: await this.remoteServerConfigCtr
          .getRemoteServerConfig()
          .then((c) => c.remoteServerUrl || ''),
      });

      // 通知渲染进程需要重新授权
      this.broadcastAuthorizationRequired();

      return { error: error.message, success: false };
    } finally {
      // 标记为不再刷新
      this.remoteServerConfigCtr.setTokenRefreshing(false);
    }
  }

  /**
   * 广播令牌已刷新事件
   */
  private broadcastTokenRefreshed() {
    const allWindows = BrowserWindow.getAllWindows();

    for (const win of allWindows) {
      if (!win.isDestroyed()) {
        win.webContents.send('tokenRefreshed');
      }
    }
  }

  /**
   * 广播授权成功事件
   */
  private broadcastAuthorizationSuccessful() {
    const allWindows = BrowserWindow.getAllWindows();

    for (const win of allWindows) {
      if (!win.isDestroyed()) {
        win.webContents.send('authorizationSuccessful');
      }
    }
  }

  /**
   * 广播授权失败事件
   */
  private broadcastAuthorizationFailed(error: string) {
    const allWindows = BrowserWindow.getAllWindows();

    for (const win of allWindows) {
      if (!win.isDestroyed()) {
        win.webContents.send('authorizationFailed', { error });
      }
    }
  }

  /**
   * 广播需要重新授权事件
   */
  private broadcastAuthorizationRequired() {
    const allWindows = BrowserWindow.getAllWindows();

    for (const win of allWindows) {
      if (!win.isDestroyed()) {
        win.webContents.send('authorizationRequired');
      }
    }
  }

  /**
   * 生成 PKCE 的 codeVerifier
   */
  private generateCodeVerifier(): string {
    // 生成至少 43 字符的随机字符串
    return crypto
      .randomBytes(32)
      .toString('base64')
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/, '');
  }

  /**
   * 根据 codeVerifier 生成 codeChallenge (S256 方法)
   */
  private async generateCodeChallenge(codeVerifier: string): Promise<string> {
    // 使用 SHA-256 哈希 codeVerifier
    const encoder = new TextEncoder();
    const data = encoder.encode(codeVerifier);
    const digest = await crypto.subtle.digest('SHA-256', data);

    // 将哈希结果转换为 base64url 编码
    return Buffer.from(digest)
      .toString('base64')
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/, '');
  }
}
