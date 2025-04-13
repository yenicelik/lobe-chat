import { safeStorage } from 'electron';

import { ControllerModule, ipcClientEvent } from './index';

/**
 * 远程服务器配置控制器
 * 用于管理自定义远程LobeChat服务器的配置
 */
export default class RemoteServerConfigCtr extends ControllerModule {
  /**
   * 获取远程服务器配置
   */
  @ipcClientEvent('getRemoteServerConfig')
  async getRemoteServerConfig() {
    const { storeManager } = this.app;

    return {
      isRemoteServerActive: storeManager.get('isRemoteServerActive', false),
      remoteServerUrl: storeManager.get('remoteServerUrl', ''),
    };
  }

  /**
   * 设置远程服务器配置
   */
  @ipcClientEvent('setRemoteServerConfig')
  async setRemoteServerConfig(config: { isRemoteServerActive: boolean; remoteServerUrl: string }) {
    const { storeManager } = this.app;

    // 保存配置
    storeManager.set('remoteServerUrl', config.remoteServerUrl);
    storeManager.set('isRemoteServerActive', config.isRemoteServerActive);

    return true;
  }

  /**
   * 清除远程服务器配置
   */
  @ipcClientEvent('clearRemoteServerConfig')
  async clearRemoteServerConfig() {
    const { storeManager } = this.app;

    // 清除实例配置
    storeManager.delete('remoteServerUrl');
    storeManager.set('isRemoteServerActive', false);

    // 清除令牌（如果有）
    await this.clearTokens();

    return true;
  }

  /**
   * 保存加密后的令牌
   * 令牌只存储在内存中，不持久化到存储中
   */
  private encryptedAccessToken?: string;
  private encryptedRefreshToken?: string;

  /**
   * 是否正在刷新 Token
   */
  private isRefreshing = false;

  /**
   * 加密并存储令牌
   * @param accessToken 访问令牌
   * @param refreshToken 刷新令牌
   */
  async saveTokens(accessToken: string, refreshToken: string) {
    // 如果平台不支持安全存储，直接存储原始令牌
    if (!safeStorage.isEncryptionAvailable()) {
      this.encryptedAccessToken = accessToken;
      this.encryptedRefreshToken = refreshToken;
      return;
    }

    // 加密令牌
    this.encryptedAccessToken = Buffer.from(safeStorage.encryptString(accessToken)).toString(
      'base64',
    );

    this.encryptedRefreshToken = Buffer.from(safeStorage.encryptString(refreshToken)).toString(
      'base64',
    );
  }

  /**
   * 获取解密后的访问令牌
   */
  async getAccessToken(): Promise<string | null> {
    if (!this.encryptedAccessToken) return null;

    // 如果平台不支持安全存储，直接返回存储的令牌
    if (!safeStorage.isEncryptionAvailable()) {
      return this.encryptedAccessToken;
    }

    try {
      // 解密令牌
      const encryptedData = Buffer.from(this.encryptedAccessToken, 'base64');
      return safeStorage.decryptString(encryptedData);
    } catch (error) {
      console.error('解密访问令牌失败:', error);
      return null;
    }
  }

  /**
   * 获取解密后的刷新令牌
   */
  async getRefreshToken(): Promise<string | null> {
    if (!this.encryptedRefreshToken) return null;

    // 如果平台不支持安全存储，直接返回存储的令牌
    if (!safeStorage.isEncryptionAvailable()) {
      return this.encryptedRefreshToken;
    }

    try {
      // 解密令牌
      const encryptedData = Buffer.from(this.encryptedRefreshToken, 'base64');
      return safeStorage.decryptString(encryptedData);
    } catch (error) {
      console.error('解密刷新令牌失败:', error);
      return null;
    }
  }

  /**
   * 清除令牌
   */
  async clearTokens() {
    this.encryptedAccessToken = undefined;
    this.encryptedRefreshToken = undefined;
  }

  /**
   * 获取刷新状态
   */
  isTokenRefreshing() {
    return this.isRefreshing;
  }

  /**
   * 设置刷新状态
   */
  setTokenRefreshing(status: boolean) {
    this.isRefreshing = status;
  }
}
