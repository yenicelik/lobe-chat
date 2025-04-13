/**
 * 远程服务器配置相关的事件
 */
export interface RemoteServerDispatchEvents {
  clearRemoteServerConfig: () => boolean;

  getRemoteServerConfig: () => {
    isRemoteServerActive: boolean;
    remoteServerUrl: string;
  };

  refreshAccessToken: () => {
    error?: string;
    success: boolean;
  };

  requestAuthorization: (serverUrl: string) => {
    error?: string;
    success: boolean;
  };

  setRemoteServerConfig: (config: {
    isRemoteServerActive: boolean;
    remoteServerUrl: string;
  }) => boolean;
}

/**
 * 从主进程广播的远程服务器相关事件
 */
export interface RemoteServerBroadcastEvents {
  authorizationFailed: (params: { error: string }) => void;
  authorizationRequired: (params: void) => void;
  authorizationSuccessful: (params: void) => void;
  tokenRefreshed: (params: void) => void;
}
