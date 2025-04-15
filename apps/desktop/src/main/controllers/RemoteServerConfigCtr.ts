import { safeStorage } from 'electron';

import { createLogger } from '@/utils/logger';

import { ControllerModule, ipcClientEvent } from './index';

// Create logger
const logger = createLogger('controllers:RemoteServerConfigCtr');

/**
 * Remote Server Configuration Controller
 * Used to manage custom remote LobeChat server configuration
 */
export default class RemoteServerConfigCtr extends ControllerModule {
  /**
   * Get remote server configuration
   */
  @ipcClientEvent('getRemoteServerConfig')
  async getRemoteServerConfig() {
    logger.debug('Getting remote server configuration');
    const { storeManager } = this.app;

    const config = {
      isRemoteServerActive: storeManager.get('isRemoteServerActive', false),
      remoteServerUrl: storeManager.get('remoteServerUrl', ''),
    };

    logger.debug(
      `Remote server config: active=${config.isRemoteServerActive}, url=${config.remoteServerUrl}`,
    );
    return config;
  }

  /**
   * Set remote server configuration
   */
  @ipcClientEvent('setRemoteServerConfig')
  async setRemoteServerConfig(config: { isRemoteServerActive: boolean; remoteServerUrl: string }) {
    logger.info(
      `Setting remote server config: active=${config.isRemoteServerActive}, url=${config.remoteServerUrl}`,
    );
    const { storeManager } = this.app;

    // Save configuration
    storeManager.set('remoteServerUrl', config.remoteServerUrl);
    storeManager.set('isRemoteServerActive', config.isRemoteServerActive);

    return true;
  }

  /**
   * Clear remote server configuration
   */
  @ipcClientEvent('clearRemoteServerConfig')
  async clearRemoteServerConfig() {
    logger.info('Clearing remote server configuration');
    const { storeManager } = this.app;

    // Clear instance configuration
    storeManager.delete('remoteServerUrl');
    storeManager.set('isRemoteServerActive', false);

    // Clear tokens (if any)
    await this.clearTokens();

    return true;
  }

  /**
   * Encrypted tokens
   * Tokens are only stored in memory, not persisted to storage
   */
  private encryptedAccessToken?: string;
  private encryptedRefreshToken?: string;

  /**
   * Whether token refresh is in progress
   */
  private isRefreshing = false;

  /**
   * Encrypt and store tokens
   * @param accessToken Access token
   * @param refreshToken Refresh token
   */
  async saveTokens(accessToken: string, refreshToken: string) {
    logger.info('Saving encrypted tokens');

    // If platform doesn't support secure storage, store raw tokens
    if (!safeStorage.isEncryptionAvailable()) {
      logger.warn('Safe storage not available, storing tokens unencrypted');
      this.encryptedAccessToken = accessToken;
      this.encryptedRefreshToken = refreshToken;
      return;
    }

    // Encrypt tokens
    logger.debug('Encrypting tokens using safe storage');
    this.encryptedAccessToken = Buffer.from(safeStorage.encryptString(accessToken)).toString(
      'base64',
    );

    this.encryptedRefreshToken = Buffer.from(safeStorage.encryptString(refreshToken)).toString(
      'base64',
    );
  }

  /**
   * Get decrypted access token
   */
  async getAccessToken(): Promise<string | null> {
    logger.debug('Getting access token');
    if (!this.encryptedAccessToken) {
      logger.debug('No access token stored');
      return null;
    }

    // If platform doesn't support secure storage, return stored token
    if (!safeStorage.isEncryptionAvailable()) {
      logger.debug('Safe storage not available, returning unencrypted token');
      return this.encryptedAccessToken;
    }

    try {
      // Decrypt token
      logger.debug('Decrypting access token');
      const encryptedData = Buffer.from(this.encryptedAccessToken, 'base64');
      return safeStorage.decryptString(encryptedData);
    } catch (error) {
      logger.error('Failed to decrypt access token:', error);
      return null;
    }
  }

  /**
   * Get decrypted refresh token
   */
  async getRefreshToken(): Promise<string | null> {
    logger.debug('Getting refresh token');
    if (!this.encryptedRefreshToken) {
      logger.debug('No refresh token stored');
      return null;
    }

    // If platform doesn't support secure storage, return stored token
    if (!safeStorage.isEncryptionAvailable()) {
      logger.debug('Safe storage not available, returning unencrypted token');
      return this.encryptedRefreshToken;
    }

    try {
      // Decrypt token
      logger.debug('Decrypting refresh token');
      const encryptedData = Buffer.from(this.encryptedRefreshToken, 'base64');
      return safeStorage.decryptString(encryptedData);
    } catch (error) {
      logger.error('Failed to decrypt refresh token:', error);
      return null;
    }
  }

  /**
   * Clear tokens
   */
  async clearTokens() {
    logger.info('Clearing access and refresh tokens');
    this.encryptedAccessToken = undefined;
    this.encryptedRefreshToken = undefined;
  }

  /**
   * Get refresh status
   */
  isTokenRefreshing() {
    return this.isRefreshing;
  }

  /**
   * Set refresh status
   */
  setTokenRefreshing(status: boolean) {
    logger.debug(`Setting token refresh status: ${status}`);
    this.isRefreshing = status;
  }
}
