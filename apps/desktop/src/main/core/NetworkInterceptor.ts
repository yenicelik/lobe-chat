import { app, session } from 'electron';
import { URL } from 'node:url';

import AuthCtr from '@/controllers/AuthCtr';
import RemoteServerConfigCtr from '@/controllers/RemoteServerConfigCtr';

import { App } from './App';

/**
 * 网络拦截器
 * 用于拦截和转发网络请求到远程服务器
 */
export class NetworkInterceptor {
  private app: App;
  private remoteServerConfigCtr: RemoteServerConfigCtr;

  // 是否已经初始化
  private initialized = false;

  constructor(app: App) {
    this.app = app;

    // 获取远程服务器配置控制器
    this.remoteServerConfigCtr = app.getController(RemoteServerConfigCtr);
  }

  /**
   * 初始化网络拦截器
   */
  public initialize() {
    if (this.initialized) return;

    // 注册协议处理器
    this.registerProtocolHandlers();

    // 设置请求拦截
    this.setupRequestInterception();

    // 标记为已初始化
    this.initialized = true;
  }

  /**
   * 注册自定义协议处理器
   */
  private registerProtocolHandlers() {
    // 设置应用为默认协议处理器
    if (process.env.NODE_ENV !== 'development') {
      app.setAsDefaultProtocolClient('lobe-chat-desktop');
    }

    // 注册协议处理
    this.setupProtocolHandlers();
  }

  /**
   * 设置协议处理器
   */
  private setupProtocolHandlers() {
    // macOS 需要在 open-url 事件中处理
    app.on('open-url', (event, url) => {
      event.preventDefault();
      this.handleUrlOpen(url);
    });

    // Windows 需要在 second-instance 事件中处理
    app.on('second-instance', (event, argv) => {
      // 在 Windows 上，协议 URL 可能是命令行参数
      const deepLinkUrl = argv.find((arg) => arg.startsWith('lobe-chat-desktop://'));
      if (deepLinkUrl) {
        this.handleUrlOpen(deepLinkUrl);
      }
    });
  }

  /**
   * 处理 URL 打开事件
   */
  private async handleUrlOpen(url: string) {
    try {
      // 检查 URL 是否是授权回调
      if (url.startsWith('lobe-chat-desktop://auth/callback')) {
        // 获取 Auth 控制器处理授权回调
        const authCtr = this.app.getController(AuthCtr);
        if (authCtr && typeof authCtr.handleAuthCallback === 'function') {
          await authCtr.handleAuthCallback(url);
        } else {
          console.error('AuthCtr not found or handleAuthCallback not a function');
        }
      }
    } catch (error) {
      console.error('处理协议 URL 失败:', error);
    }
  }

  /**
   * 设置请求拦截
   */
  private setupRequestInterception() {
    // 获取默认会话
    const defaultSession = session.defaultSession;
    if (!defaultSession) {
      console.error('默认会话不可用，无法设置请求拦截');
      return;
    }

    // 请求重定向 - 在请求发起前
    defaultSession.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, async (details, callback) => {
      try {
        // 检查是否启用远程服务器
        const config = await this.remoteServerConfigCtr.getRemoteServerConfig();
        if (!config.isRemoteServerActive || !config.remoteServerUrl) {
          callback({});
          return;
        }

        // 解析请求 URL
        const urlObj = new URL(details.url);

        // 判断是否是我们需要转发的 API 请求
        // 检查是否匹配 /api/, /trpc/, /webapi/ 前缀
        const isApiRequest = ['/api/', '/trpc/', '/webapi/'].some((prefix) =>
          urlObj.pathname.startsWith(prefix),
        );

        // 检查是否来自我们的应用（而不是外部网站）
        // 通常从 http://localhost:3015/ 加载的内容需要被当作应用内容
        // 或者从 file:// 协议加载的资源
        const isInternalRequest =
          urlObj.origin === 'http://localhost:3015' ||
          urlObj.protocol === 'file:' ||
          // 在生产环境中，应用可能从 app://.-._.... 加载
          urlObj.protocol === 'app:';

        if (isInternalRequest && isApiRequest) {
          // 构造新的 URL
          const newUrl = new URL(urlObj.pathname + urlObj.search, config.remoteServerUrl);

          // 重定向请求
          callback({ redirectURL: newUrl.toString() });
          return;
        }
      } catch (error) {
        console.error('拦截请求失败:', error);
      }

      // 默认不做任何修改
      callback({});
    });

    // 添加授权头 - 在请求头发送前
    defaultSession.webRequest.onBeforeSendHeaders(
      { urls: ['*://*/*'] },
      async (details, callback) => {
        try {
          // 检查是否启用远程服务器
          const config = await this.remoteServerConfigCtr.getRemoteServerConfig();
          if (!config.isRemoteServerActive || !config.remoteServerUrl) {
            callback({ requestHeaders: details.requestHeaders });
            return;
          }

          // 解析请求 URL
          const urlObj = new URL(details.url);

          // 检查请求是否指向远程服务器
          const serverUrlObj = new URL(config.remoteServerUrl);
          const isRemoteServerRequest = urlObj.origin === serverUrlObj.origin;

          if (isRemoteServerRequest) {
            // 获取访问令牌
            const accessToken = await this.remoteServerConfigCtr.getAccessToken();

            if (accessToken) {
              // 添加授权头
              details.requestHeaders['Authorization'] = `Bearer ${accessToken}`;
            }
          }
        } catch (error) {
          console.error('修改请求头失败:', error);
        }

        // 返回修改后的请求头
        callback({ requestHeaders: details.requestHeaders });
      },
    );

    // 处理响应 - 主要用于检测 401 错误并刷新令牌
    // 注意：这在 Electron 主进程无法完全实现，因为响应体已经发送给渲染进程
    // 我们只能检测状态码，具体的重试逻辑需要在渲染进程实现
    defaultSession.webRequest.onHeadersReceived(
      { urls: ['*://*/*'] },
      async (details, callback) => {
        try {
          // 检查是否启用远程服务器
          const config = await this.remoteServerConfigCtr.getRemoteServerConfig();
          if (!config.isRemoteServerActive || !config.remoteServerUrl) {
            callback({ responseHeaders: details.responseHeaders });
            return;
          }

          // 解析请求 URL
          const urlObj = new URL(details.url);

          // 检查请求是否指向远程服务器
          const serverUrlObj = new URL(config.remoteServerUrl);
          const isRemoteServerRequest = urlObj.origin === serverUrlObj.origin;

          // 如果是 401 错误，可能需要刷新令牌
          if (isRemoteServerRequest && details.statusCode === 401) {
            // 我们不能在这里中断响应流程，只能通知渲染进程需要刷新令牌
            // 由渲染进程通过 IPC 调用 refreshAccessToken 并重试请求
            console.log('检测到 401 错误，可能需要刷新令牌');
          }
        } catch (error) {
          console.error('处理响应头失败:', error);
        }

        // 返回原始响应头
        callback({ responseHeaders: details.responseHeaders });
      },
    );
  }
}
