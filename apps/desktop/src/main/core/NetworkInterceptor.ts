import { session } from 'electron';
import { URL } from 'node:url';

import RemoteServerConfigCtr from '@/controllers/RemoteServerConfigCtr';
import { createLogger } from '@/utils/logger';

import { App } from './App';

// Create logger
const logger = createLogger('core:NetworkInterceptor');

/**
 * Network Interceptor
 * Used for intercepting and forwarding network requests to remote server
 */
export class NetworkInterceptor {
  private app: App;
  private remoteServerConfigCtr: RemoteServerConfigCtr;

  // Whether initialization has completed
  private initialized = false;

  constructor(app: App) {
    logger.debug('Initializing NetworkInterceptor');
    this.app = app;

    // Get remote server config controller
    this.remoteServerConfigCtr = app.getController(RemoteServerConfigCtr);
  }

  /**
   * Initialize network interceptor
   */
  public initialize() {
    if (this.initialized) {
      logger.debug('NetworkInterceptor already initialized, skipping');
      return;
    }

    logger.info('Starting NetworkInterceptor initialization');

    // Set up request interception
    this.setupRequestInterception();

    // Mark as initialized
    this.initialized = true;
    logger.info('NetworkInterceptor initialization completed');
  }

  /**
   * Set up request interception
   */
  private setupRequestInterception() {
    logger.debug('Setting up request interception');
    // Get default session
    const defaultSession = session.defaultSession;
    if (!defaultSession) {
      logger.error('Default session unavailable, cannot set up request interception');
      console.error('Default session unavailable, cannot set up request interception');
      return;
    }

    // Request redirection - before request is made
    defaultSession.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, async (details, callback) => {
      try {
        // Check if remote server is enabled
        const config = await this.remoteServerConfigCtr.getRemoteServerConfig();
        if (!config.isRemoteServerActive || !config.remoteServerUrl) {
          logger.verbose('Remote server not enabled, not intercepting request:', details.url);
          callback({});
          return;
        }

        // Parse request URL
        const urlObj = new URL(details.url);
        logger.verbose('Processing request:', details.url);

        // Determine if this is an API request we need to forward
        // Check if it matches /api/, /trpc/, /webapi/ prefixes
        const isApiRequest = ['/api/', '/trpc/', '/webapi/'].some((prefix) =>
          urlObj.pathname.startsWith(prefix),
        );

        // Check if request is from our app (not external websites)
        // Usually content loaded from http://localhost:3015/ should be treated as app content
        // Or resources loaded from file:// protocol
        const isInternalRequest =
          urlObj.origin === 'http://localhost:3015' ||
          urlObj.protocol === 'file:' ||
          // In production, app might be loaded from app://.-._....
          urlObj.protocol === 'app:';

        if (isInternalRequest && isApiRequest) {
          // Construct new URL
          const newUrl = new URL(urlObj.pathname + urlObj.search, config.remoteServerUrl);
          logger.debug('Redirecting API request:', details.url, 'to:', newUrl.toString());

          // Redirect request
          callback({ redirectURL: newUrl.toString() });
          return;
        }
      } catch (error) {
        logger.error('Failed to intercept request:', error);
        console.error('Failed to intercept request:', error);
      }

      // Default: no modification
      callback({});
    });

    // Add authorization header - before headers are sent
    defaultSession.webRequest.onBeforeSendHeaders(
      { urls: ['*://*/*'] },
      async (details, callback) => {
        try {
          // Check if remote server is enabled
          const config = await this.remoteServerConfigCtr.getRemoteServerConfig();
          if (!config.isRemoteServerActive || !config.remoteServerUrl) {
            logger.verbose(
              'Remote server not enabled, not modifying request headers:',
              details.url,
            );
            callback({ requestHeaders: details.requestHeaders });
            return;
          }

          // Parse request URL
          const urlObj = new URL(details.url);
          logger.verbose('Processing request headers:', details.url);

          // Check if request is directed to remote server
          const serverUrlObj = new URL(config.remoteServerUrl);
          const isRemoteServerRequest = urlObj.origin === serverUrlObj.origin;

          if (isRemoteServerRequest) {
            logger.debug('Found request to remote server:', details.url);
            // Get access token
            const accessToken = await this.remoteServerConfigCtr.getAccessToken();

            if (accessToken) {
              // Add authorization header
              details.requestHeaders['Authorization'] = `Bearer ${accessToken}`;
              logger.debug('Added authorization header to request');
            } else {
              logger.debug('No access token available');
            }
          }
        } catch (error) {
          logger.error('Failed to modify request headers:', error);
          console.error('Failed to modify request headers:', error);
        }

        // Return modified request headers
        callback({ requestHeaders: details.requestHeaders });
      },
    );

    // Handle response - mainly to detect 401 errors and refresh token
    // Note: This cannot be fully implemented in Electron main process because the response body
    // has already been sent to the renderer process. We can only detect status codes,
    // and the specific retry logic needs to be implemented in the renderer process.
    defaultSession.webRequest.onHeadersReceived(
      { urls: ['*://*/*'] },
      async (details, callback) => {
        try {
          // Check if remote server is enabled
          const config = await this.remoteServerConfigCtr.getRemoteServerConfig();
          if (!config.isRemoteServerActive || !config.remoteServerUrl) {
            callback({ responseHeaders: details.responseHeaders });
            return;
          }

          // Parse request URL
          const urlObj = new URL(details.url);
          logger.verbose(
            'Processing response headers:',
            details.url,
            'status code:',
            details.statusCode,
          );

          // Check if request is directed to remote server
          const serverUrlObj = new URL(config.remoteServerUrl);
          const isRemoteServerRequest = urlObj.origin === serverUrlObj.origin;

          // If 401 error, might need to refresh token
          if (isRemoteServerRequest && details.statusCode === 401) {
            // We cannot interrupt the response flow here, can only notify renderer process
            // that token refresh is needed. The renderer process will call refreshAccessToken
            // via IPC and retry the request.
            logger.warn('Detected 401 error, token refresh may be needed, URL:', details.url);
            console.log('Detected 401 error, token refresh may be needed');
          }
        } catch (error) {
          logger.error('Failed to process response headers:', error);
          console.error('Failed to process response headers:', error);
        }

        // Return original response headers
        callback({ responseHeaders: details.responseHeaders });
      },
    );

    logger.info('Request interception setup completed');
  }
}
