import { ElectronIPCEventHandler, ElectronIPCServer } from '@lobechat/electron-server-ipc';
import { Session, app, ipcMain, protocol } from 'electron';
import { macOS, windows } from 'electron-is';
import { join } from 'node:path';

import { buildDir, nextStandaloneDir } from '@/const/dir';
import { isDev } from '@/const/env';
import { IControlModule } from '@/controllers';
import { IServiceModule } from '@/services';
import { createLogger } from '@/utils/logger';
import { createHandler } from '@/utils/next-electron-rsc';

import BrowserManager from './BrowserManager';
import { I18nManager } from './I18nManager';
import { IoCContainer } from './IoCContainer';
import MenuManager from './MenuManager';
import { NetworkInterceptor } from './NetworkInterceptor';
import { ShortcutManager } from './ShortcutManager';
import { StoreManager } from './StoreManager';
import { UpdaterManager } from './UpdaterManager';

// Create logger
const logger = createLogger('core:App');

export type IPCEventMap = Map<string, { controller: any; methodName: string }>;
export type ShortcutMethodMap = Map<string, () => Promise<void>>;

type Class<T> = new (...args: any[]) => T;

const importAll = (r: any) => Object.values(r).map((v: any) => v.default);

export class App {
  nextServerUrl = 'http://localhost:3015';

  browserManager: BrowserManager;
  menuManager: MenuManager;
  i18n: I18nManager;
  storeManager: StoreManager;
  updaterManager: UpdaterManager;
  shortcutManager: ShortcutManager;
  networkInterceptor: NetworkInterceptor;

  /**
   * whether app is in quiting
   */
  isQuiting: boolean = false;

  constructor() {
    logger.debug('Initializing App');
    // Initialize store manager
    this.storeManager = new StoreManager(this);

    // load controllers
    const controllers: IControlModule[] = importAll(
      (import.meta as any).glob('@/controllers/*Ctr.ts', { eager: true }),
    );

    logger.debug(`Loading ${controllers.length} controllers`);
    controllers.forEach((controller) => this.addController(controller));

    // load services
    const services: IServiceModule[] = importAll(
      (import.meta as any).glob('@/services/*Srv.ts', { eager: true }),
    );

    logger.debug(`Loading ${services.length} services`);
    services.forEach((service) => this.addService(service));

    this.initializeIPCEvents();

    this.i18n = new I18nManager(this);
    this.browserManager = new BrowserManager(this);
    this.menuManager = new MenuManager(this);
    this.updaterManager = new UpdaterManager(this);
    this.shortcutManager = new ShortcutManager(this);
    this.networkInterceptor = new NetworkInterceptor(this);

    // register the schema to interceptor url
    // it should register before app ready
    this.registerNextHandler();
    logger.info('App initialization completed');
  }

  bootstrap = async () => {
    logger.info('Bootstrapping application');
    // make single instance
    const isSingle = app.requestSingleInstanceLock();
    if (!isSingle) {
      logger.info('Another instance is already running, exiting');
      app.exit(0);
    }

    this.initDevBranding();

    //  ==============
    await this.ipcServer.start();
    logger.debug('IPC server started');

    // Initialize app
    await this.makeAppReady();

    // Initialize network interceptor
    this.networkInterceptor.initialize();

    // Initialize i18n. Note: app.getLocale() must be called after app.whenReady() to get the correct value
    await this.i18n.init();
    this.menuManager.initialize();

    // Initialize global shortcuts: globalShortcut must be called after app.whenReady()
    this.shortcutManager.initialize();

    this.browserManager.initializeBrowsers();

    // Initialize updater manager
    await this.updaterManager.initialize();

    // Set global application exit state
    this.isQuiting = false;

    // Listen for before-quit event, set exit flag
    app.on('before-quit', () => {
      logger.info('Application is about to quit');
      this.isQuiting = true;
      // Unregister all shortcuts before application exits
      this.shortcutManager.unregisterAll();
    });

    app.on('window-all-closed', () => {
      if (windows()) {
        logger.info('All windows closed, quitting application (Windows)');
        app.quit();
      }
    });

    app.on('activate', this.onActivate);
    logger.info('Application bootstrap completed');
  };

  getService<T>(serviceClass: Class<T>): T {
    return this.services.get(serviceClass);
  }

  getController<T>(controllerClass: Class<T>): T {
    return this.controllers.get(controllerClass);
  }

  private onActivate = () => {
    logger.debug('Application activated');
    this.browserManager.showMainWindow();
  };

  /**
   * Call beforeAppReady method on all controllers before the application is ready
   */
  private makeAppReady = async () => {
    logger.debug('Preparing application ready state');
    this.controllers.forEach((controller) => {
      if (typeof controller.beforeAppReady === 'function') {
        try {
          controller.beforeAppReady();
        } catch (error) {
          logger.error(`Error in controller.beforeAppReady:`, error);
          console.error(`[App] Error in controller.beforeAppReady:`, error);
        }
      }
    });

    logger.debug('Waiting for app to be ready');
    await app.whenReady();
    logger.debug('Application ready');

    this.controllers.forEach((controller) => {
      if (typeof controller.afterAppReady === 'function') {
        try {
          controller.afterAppReady();
        } catch (error) {
          logger.error(`Error in controller.afterAppReady:`, error);
          console.error(`[App] Error in controller.beforeAppReady:`, error);
        }
      }
    });
    logger.info('Application ready state completed');
  };

  // ============= helper ============= //

  /**
   * all controllers in app
   */
  private controllers = new Map<Class<any>, any>();
  /**
   * all services in app
   */
  private services = new Map<Class<any>, any>();

  private ipcServer: ElectronIPCServer;
  /**
   * events dispatched from webview layer
   */
  private ipcClientEventMap: IPCEventMap = new Map();
  private ipcServerEventMap: IPCEventMap = new Map();
  shortcutMethodMap: ShortcutMethodMap = new Map();

  /**
   * use in next router interceptor in prod browser render
   */
  nextInterceptor: (params: { enabled?: boolean; session: Session }) => () => void;

  private addController = (ControllerClass: IControlModule) => {
    const controller = new ControllerClass(this);
    this.controllers.set(ControllerClass, controller);

    IoCContainer.controllers.get(ControllerClass)?.forEach((event) => {
      if (event.mode === 'client') {
        // Store all objects from event decorator in ipcClientEventMap
        this.ipcClientEventMap.set(event.name, {
          controller,
          methodName: event.methodName,
        });
      }

      if (event.mode === 'server') {
        // Store all objects from event decorator in ipcServerEventMap
        this.ipcServerEventMap.set(event.name, {
          controller,
          methodName: event.methodName,
        });
      }
    });

    IoCContainer.shortcuts.get(ControllerClass)?.forEach((shortcut) => {
      this.shortcutMethodMap.set(shortcut.name, async () => {
        controller[shortcut.methodName]();
      });
    });
  };

  private addService = (ServiceClass: IServiceModule) => {
    const service = new ServiceClass(this);
    this.services.set(ServiceClass, service);
  };

  private initDevBranding = () => {
    if (!isDev) return;

    logger.debug('Setting up dev branding');
    app.setName('LobeHub Dev');
    if (macOS()) {
      app.dock!.setIcon(join(buildDir, 'icon-dev.png'));
    }
  };

  private registerNextHandler() {
    logger.debug('Registering Next.js handler');
    const handler = createHandler({
      debug: true,
      localhostUrl: this.nextServerUrl,
      protocol,
      standaloneDir: nextStandaloneDir,
    });
    logger.info(
      `Server Debugging Enabled, ${this.nextServerUrl} will be intercepted to ${nextStandaloneDir}`,
    );

    this.nextInterceptor = handler.createInterceptor;
  }

  private initializeIPCEvents() {
    logger.debug('Initializing IPC events');
    // Register batch controller client events for render side consumption
    this.ipcClientEventMap.forEach((eventInfo, key) => {
      const { controller, methodName } = eventInfo;

      ipcMain.handle(key, async (e, ...data) => {
        try {
          return await controller[methodName](...data);
        } catch (error) {
          logger.error(`Error handling IPC event ${key}:`, error);
          return { error: error.message };
        }
      });
    });

    // 批量注册 controller 中的 server event 事件 供 next server 端消费
    const ipcServerEvents = {} as ElectronIPCEventHandler;

    this.ipcServerEventMap.forEach((eventInfo, key) => {
      const { controller, methodName } = eventInfo;

      ipcServerEvents[key] = async (payload) => {
        try {
          return await controller[methodName](payload);
        } catch (error) {
          return { error: error.message };
        }
      };
    });

    this.ipcServer = new ElectronIPCServer(ipcServerEvents);
  }
}
