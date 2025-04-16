import { createLogger } from '@/utils/logger';
import { CustomRequestHandler } from '@/utils/next-electron-rsc';

import RemoteServerConfigCtr from './RemoteServerConfigCtr';
import { ControllerModule } from './index';

const trpcProxyPath = ['/trpc/lambda', '/trpc/tools', '/trpc/async'];

// Create logger
const logger = createLogger('controllers:RemoteServerSyncCtr');

/**
 * Remote Server Sync Controller
 * For handling data synchronization with remote servers, including intercepting and processing tRPC requests
 */
export default class RemoteServerSyncCtr extends ControllerModule {
  /**
   * Remote server configuration controller
   */
  private get remoteServerConfigCtr() {
    return this.app.getController(RemoteServerConfigCtr);
  }

  /**
   * Request interceptor unregister function
   */
  private unregisterRequestHandler?: () => void;

  /**
   * Controller initialization
   */
  afterAppReady() {
    logger.info('Initializing remote server sync controller');
    this.registerApiRequestHandler();
  }

  /**
   * Register tRPC request handler
   */
  registerApiRequestHandler() {
    // If already registered, unregister the old handler first
    if (this.unregisterRequestHandler) {
      this.unregisterRequestHandler();
      this.unregisterRequestHandler = undefined;
    }

    logger.info('Registering tRPC request handler');

    // Create request handler
    const handler: CustomRequestHandler = async (request) => {
      try {
        // Check if it's a tRPC request
        const isApiRequest = trpcProxyPath.some((path) => request.url.includes(path));

        if (!isApiRequest) return null; // Not an Api request, let other handlers process it

        // Get remote server configuration
        const config = await this.remoteServerConfigCtr.getRemoteServerConfig();

        // If remote server is not active, don't process the request
        if (!config.active || !config.remoteServerUrl) return null;

        // Get access token
        const accessToken = await this.remoteServerConfigCtr.getAccessToken();

        if (!accessToken) {
          logger.warn('No access token, trying to refresh token');
          // If no access token, try to refresh
          const refreshResult = await this.refreshTokenIfNeeded();
          if (!refreshResult) {
            logger.error('Unable to get valid access token');
            return null; // Refresh failed, let the original request continue
          }
        }

        // Get access token again (might have been just refreshed)
        const token = await this.remoteServerConfigCtr.getAccessToken();

        if (!token) {
          logger.error('Still unable to get access token, request will continue but may fail');
          return null;
        }

        // Build new request URL, pointing to remote server
        const originalUrl = new URL(request.url);
        const targetUrl = new URL(
          originalUrl.pathname + originalUrl.search,
          config.remoteServerUrl,
        );

        logger.debug(`Intercepting tRPC request: ${request.url} -> ${targetUrl.toString()}`);

        // Create new request headers, add Bearer token
        const headers = new Headers(request.headers);
        headers.set('Authorization', `Bearer ${token}`);

        // Forward request to remote server
        const response = await fetch(targetUrl.toString(), {
          body: request.body,
          headers,
          method: request.method,
          signal: request.signal,
        });

        // Check if token refresh is needed (401 error)
        if (response.status === 401) {
          logger.warn('Received 401 response, trying to refresh token');
          const refreshed = await this.refreshTokenIfNeeded();

          if (refreshed) {
            // Get new access token
            const newToken = await this.remoteServerConfigCtr.getAccessToken();

            if (newToken) {
              // Retry request with new token
              headers.set('Authorization', `Bearer ${newToken}`);

              logger.debug('Retrying request with new token');

              return fetch(targetUrl.toString(), {
                body: request.body,
                headers,
                method: request.method,
                signal: request.signal,
              });
            }
          }

          logger.error('Token refresh failed, returning original 401 response');
        }

        return response;
      } catch (error) {
        logger.error('Error processing tRPC request:', error);
        return null; // On error, let the original request continue
      }
    };

    // Register request handler
    this.unregisterRequestHandler = this.app.registerRequestHandler(handler);
  }

  /**
   * Refresh token if needed
   * @returns Whether token refresh was successful
   */
  private async refreshTokenIfNeeded(): Promise<boolean> {
    try {
      // Check if already refreshing
      if (this.remoteServerConfigCtr.isTokenRefreshing()) {
        logger.debug('Token refresh already in progress, waiting for completion');

        // Wait for some time to let refresh complete
        await new Promise((resolve) => {
          setTimeout(resolve, 2000);
        });
        return true;
      }

      // Check if remote server is active
      const config = await this.remoteServerConfigCtr.getRemoteServerConfig();
      if (!config.active) {
        logger.debug('Remote server not active, not refreshing token');
        return false;
      }

      logger.info('Refreshing access token');
      const result = await this.remoteServerConfigCtr.refreshAccessToken();

      return result.success;
    } catch (error) {
      logger.error('Error refreshing token:', error);
      return false;
    }
  }
}
