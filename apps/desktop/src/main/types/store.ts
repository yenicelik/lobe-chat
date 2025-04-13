export interface ElectronMainStore {
  isRemoteServerActive?: boolean;
  locale: string;
  remoteServerUrl?: string;
  shortcuts: Record<string, string>;
}

export type StoreKey = keyof ElectronMainStore;
