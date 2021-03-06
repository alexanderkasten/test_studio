/* eslint-disable max-lines */
import fs from 'fs';
import path from 'path';
import {homedir} from 'os';
import windowStateKeeper from 'electron-window-state';

import JSZip from 'jszip';

import {
  App,
  BrowserWindow,
  Dialog,
  IpcMain,
  IpcMainEvent,
  Menu,
  MenuItem,
  MenuItemConstructorOptions,
  WebContents,
} from 'electron';
import openAboutWindow, {AboutWindowInfo} from 'about-window';
import getPort from 'get-port';
import open from 'open';

import {CancellationToken, autoUpdater} from '@process-engine/electron-updater';
import * as pe from '@process-engine/process_engine_runtime';
import {version as ProcessEngineVersion} from '@process-engine/process_engine_runtime/package.json';

import electronOidc from './electron-oidc';
import oidcConfig from './oidc-config';
import ReleaseChannel from '../src/services/release-channel-service/release-channel.service';
import {version as CurrentStudioVersion} from '../package.json';
import {getPortListByVersion} from '../src/services/default-ports-module/default-ports.module';

// eslint-disable-next-line @typescript-eslint/no-require-imports
import electron = require('electron');

const ipcMain: IpcMain = electron.ipcMain;
const dialog: Dialog = electron.dialog;
const app: App = electron.app;

let browserWindow: BrowserWindow;
const releaseChannel: ReleaseChannel = new ReleaseChannel(CurrentStudioVersion);
// If BPMN Studio was opened by double-clicking a .bpmn file, then the
// following code tells the frontend the name and content of that file;
// this 'get_opened_file' request is emmitted in src/main.ts.
let fileAssociationFilePath: string;
let isInitialized: boolean = false;

/**
 * This variable gets set when BPMN Studio is ready to work with Files that are
 * openend via double click.
 */
let fileOpenMainEvent: IpcMainEvent;

function execute(): void {
  /**
   * Makes Main application a Single Instance Application.
   */
  app.requestSingleInstanceLock();

  /**
   * Check if Main application got the Single Instance Lock.
   * true: This instance is the first instance.
   * false: This instance is the second instance.
   */
  const hasSingleInstanceLock = app.hasSingleInstanceLock();

  if (hasSingleInstanceLock) {
    initializeApplication();

    startInternalProcessEngine();

    app.on('second-instance', (event, argv, workingDirectory) => {
      const noArgumentsSet = argv[1] === undefined;

      if (noArgumentsSet) {
        return;
      }

      const argumentIsFilePath = argv[1].endsWith('.bpmn');
      const argumentIsSignInRedirect = argv[1].startsWith('bpmn-studio://signin-oidc');
      const argumentIsSignOutRedirect = argv[1].startsWith('bpmn-studio://signout-oidc');

      if (argumentIsFilePath) {
        const filePath = argv[1];
        bringExistingInstanceToForeground();

        answerOpenFileEvent(filePath);
      }

      const argumentContainsRedirect = argumentIsSignInRedirect || argumentIsSignOutRedirect;
      if (argumentContainsRedirect) {
        const redirectUrl = argv[1];

        browserWindow.loadURL(`file://${__dirname}/../../../index.html`);
        browserWindow.loadURL('/');

        ipcMain.once('deep-linking-ready', (): void => {
          browserWindow.webContents.send('deep-linking-request', redirectUrl);
        });
      }
    });
  } else {
    app.quit();
  }
}

function initializeApplication(): void {
  app.on('ready', (): void => {
    createMainWindow();
  });

  app.on('activate', (): void => {
    if (browserWindow === undefined) {
      createMainWindow();
    }
  });

  if (!releaseChannel.isDev()) {
    initializeAutoUpdater();
  }

  initializeFileOpenFeature();
  initializeOidc();
}

function initializeAutoUpdater(): void {
  ipcMain.on('app_ready', async (appReadyEvent) => {
    autoUpdater.autoDownload = false;

    const currentVersion = app.getVersion();
    const currentReleaseChannel = new ReleaseChannel(currentVersion);

    const currentVersionIsPrerelease = currentReleaseChannel.isAlpha() || currentReleaseChannel.isBeta();
    autoUpdater.allowPrerelease = currentVersionIsPrerelease;
    autoUpdater.channel = currentReleaseChannel.getName();

    const updateCheckResult = await autoUpdater.checkForUpdates();

    const noUpdateAvailable = updateCheckResult.updateInfo.version === currentVersion;
    if (noUpdateAvailable) {
      return;
    }

    const newReleaseChannel = new ReleaseChannel(updateCheckResult.updateInfo.version);

    if (currentVersionIsPrerelease) {
      if (currentReleaseChannel.isAlpha() && !newReleaseChannel.isAlpha()) {
        return;
      }

      if (currentReleaseChannel.isBeta() && !newReleaseChannel.isBeta()) {
        return;
      }
    }

    console.log(`CurrentVersion: ${currentVersion}, CurrentVersionIsPrerelease: ${currentVersionIsPrerelease}`);

    autoUpdater.addListener('error', () => {
      appReadyEvent.sender.send('update_error');
    });

    autoUpdater.addListener('download-progress', (progressObj) => {
      const progressInPercent = progressObj.percent / 100;

      browserWindow.setProgressBar(progressInPercent);

      appReadyEvent.sender.send('update_download_progress', progressObj);
    });

    let downloadCancellationToken;

    autoUpdater.addListener('update-available', (updateInfo) => {
      appReadyEvent.sender.send('update_available', updateInfo.version);

      ipcMain.on('download_update', () => {
        downloadCancellationToken = new CancellationToken();
        autoUpdater.downloadUpdate(downloadCancellationToken);

        ipcMain.on('cancel_update', () => {
          downloadCancellationToken.cancel();
        });
      });

      ipcMain.on('show_release_notes', () => {
        const releaseNotesWindow = new BrowserWindow({
          width: 600,
          height: 600,
          title: `Release Notes ${updateInfo.version}`,
          minWidth: 600,
          minHeight: 600,
        });

        releaseNotesWindow.loadURL(`https://github.com/process-engine/bpmn-studio/releases/tag/v${updateInfo.version}`);
      });
    });

    autoUpdater.addListener('update-downloaded', () => {
      appReadyEvent.sender.send('update_downloaded');

      ipcMain.on('quit_and_install', () => {
        autoUpdater.quitAndInstall();
      });
    });

    autoUpdater.checkForUpdates();
  });
}

/**
 * This initializes the oidc flow for electron.
 * It mainly registers on the "oidc-login" event called by the authentication
 * service and calls the "getTokenObject"-function on the service.
 */
function initializeOidc(): void {
  const windowParams = {
    alwaysOnTop: true,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true,
      nodeIntegrationInWorker: true,
    },
  };

  const electronOidcInstance = electronOidc(oidcConfig, windowParams);

  ipcMain.on('oidc-login', (event, authorityUrl) => {
    electronOidcInstance.getTokenObject(authorityUrl).then(
      (token) => {
        event.sender.send('oidc-login-reply', token);
      },
      (err) => {
        console.log('Error while getting token', err);
      },
    );
  });

  ipcMain.on('oidc-logout', (event, tokenObject, authorityUrl) => {
    electronOidcInstance.logout(tokenObject, authorityUrl).then(
      (logoutWasSuccessful) => {
        event.sender.send('oidc-logout-reply', logoutWasSuccessful);
      },
      (err) => {
        console.log('Error while logging out', err);
      },
    );
  });
}

function initializeFileOpenFeature(): void {
  app.on('window-all-closed', () => {
    app.quit();
    fileAssociationFilePath = undefined;
  });

  app.on('will-finish-launching', () => {
    // for windows
    if (process.platform === 'win32' && process.argv.length >= 2) {
      fileAssociationFilePath = process.argv[1];
    }

    // for non-windows
    app.on('open-file', (event, filePath) => {
      fileAssociationFilePath = isInitialized ? undefined : filePath;

      if (isInitialized) {
        answerOpenFileEvent(filePath);
      }
    });
  });

  /**
   * Wait for the "waiting"-event signalling the app has started and the
   * component is ready to handle events.
   *
   * Set the fileOpenMainEvent variable to make it accesable by the sending
   * function "answerOpenFileEvent".
   *
   * Register an "open-file"-listener to get the path to file which has been
   * clicked on.
   *
   * "open-file" gets fired when someone double clicks a .bpmn file.
   */
  ipcMain.on('waiting-for-double-file-click', (mainEvent: IpcMainEvent) => {
    fileOpenMainEvent = mainEvent;
    isInitialized = true;
  });

  ipcMain.on('get_opened_file', (event) => {
    const filePathExists: boolean = fileAssociationFilePath === undefined;
    if (filePathExists) {
      event.returnValue = {};
      return;
    }

    event.returnValue = {
      path: fileAssociationFilePath,
      content: fs.readFileSync(fileAssociationFilePath, 'utf8'),
    };

    fileAssociationFilePath = undefined;
    app.focus();
  });
}

function answerOpenFileEvent(filePath: string): void {
  fileOpenMainEvent.sender.send('double-click-on-file', filePath);
}

function getProductName(): string {
  switch (releaseChannel.getName()) {
    case 'stable':
      return 'BPMN Studio';
    case 'beta':
      return 'BPMN Studio (Beta)';
    case 'alpha':
      return 'BPMN Studio (Alpha)';
    case 'dev':
      return 'BPMN Studio (Dev)';
    default:
      return 'BPMN Studio (pre)';
  }
}

function createMainWindow(): void {
  console.log('create window called');

  setElectronMenubar();

  const mainWindowState = windowStateKeeper({
    defaultWidth: 1300,
    defaultHeight: 800,
  });

  browserWindow = new BrowserWindow({
    width: mainWindowState.width,
    height: mainWindowState.height,
    x: mainWindowState.x,
    y: mainWindowState.y,
    title: getProductName(),
    minWidth: 1300,
    minHeight: 800,
    icon: path.join(__dirname, '../build/icon.png'), // only for windows
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      nodeIntegration: true,
    },
  });

  mainWindowState.manage(browserWindow);

  browserWindow.loadURL(`file://${__dirname}/../../../index.html`);
  // We need to navigate to "/" because something in the push state seems to be
  // broken if we carry a file system link as the last item of the browser
  // history.
  browserWindow.loadURL('/');

  ipcMain.on('close_bpmn-studio', (event) => {
    browserWindow.close();
  });

  browserWindow.on('closed', (event) => {
    browserWindow = null;
  });

  browserWindow.on('enter-full-screen', () => {
    browserWindow.webContents.send('toggle-fullscreen', true);
  });
  browserWindow.on('leave-full-screen', () => {
    browserWindow.webContents.send('toggle-fullscreen', false);
  });

  browserWindow.webContents.on('new-window', (event: any, url: string) => {
    if (url !== browserWindow.webContents.getURL()) {
      event.preventDefault();
      open(url);
    }
  });

  setOpenDiagramListener();
  setOpenSolutionsListener();
  setSaveDiagramAsListener();

  const platformIsWindows = process.platform === 'win32';
  if (platformIsWindows) {
    browserWindow.webContents.session.on('will-download', (event, downloadItem) => {
      const defaultFilename = downloadItem.getFilename();

      const fileTypeIndex = defaultFilename.lastIndexOf('.') + 1;
      const fileExtension = defaultFilename.substring(fileTypeIndex);

      const fileExtensionIsBPMN = fileExtension === 'bpmn';
      const fileType = fileExtensionIsBPMN ? 'BPMN (.bpmn)' : `Image (.${fileExtension})`;

      const filename = dialog.showSaveDialogSync({
        defaultPath: defaultFilename,
        filters: [
          {
            name: fileType,
            extensions: [fileExtension],
          },
          {
            name: 'All Files',
            extensions: ['*'],
          },
        ],
      });

      const downloadCanceled = filename === undefined;
      if (downloadCanceled) {
        downloadItem.cancel();

        return;
      }

      downloadItem.setSavePath(filename);
    });
  }
}

function setSaveDiagramAsListener(): void {
  ipcMain.on('open_save-diagram-as_dialog', (event) => {
    const filePath = dialog.showSaveDialogSync({
      filters: [
        {
          name: 'BPMN',
          extensions: ['bpmn', 'xml'],
        },
        {
          name: 'All Files',
          extensions: ['*'],
        },
      ],
    });

    event.sender.send('save_diagram_as', filePath);
  });
}

function setOpenDiagramListener(): void {
  ipcMain.on('open_diagram', (event) => {
    const openedFile = dialog.showOpenDialogSync({
      filters: [
        {
          name: 'BPMN',
          extensions: ['bpmn', 'xml'],
        },
        {
          name: 'XML',
          extensions: ['bpmn', 'xml'],
        },
        {
          name: 'All Files',
          extensions: ['*'],
        },
      ],
    });

    event.sender.send('import_opened_diagram', openedFile);
  });
}

function setOpenSolutionsListener(): void {
  ipcMain.on('open_solution', (event) => {
    const openedFile = dialog.showOpenDialogSync({
      properties: ['openDirectory', 'createDirectory'],
    });

    event.sender.send('import_opened_solution', openedFile);
  });
}

function setElectronMenubar(): void {
  showMenuEntriesWithoutDiagramEntries();

  ipcMain.on('menu_hide-diagram-entries', () => {
    showMenuEntriesWithoutDiagramEntries();
  });

  ipcMain.on('menu_show-all-menu-entries', () => {
    showAllMenuEntries();
  });
}

function showAllMenuEntries(): void {
  const template = [getApplicationMenu(), getFileMenu(), getEditMenu(), getWindowMenu(), getHelpMenu()];

  electron.Menu.setApplicationMenu(electron.Menu.buildFromTemplate(template));
}

function showMenuEntriesWithoutDiagramEntries(): void {
  const filteredFileMenu: MenuItem = getFilteredFileMenu();

  const template = [getApplicationMenu(), filteredFileMenu, getEditMenu(), getWindowMenu(), getHelpMenu()];

  electron.Menu.setApplicationMenu(electron.Menu.buildFromTemplate(template));
}

function getFilteredFileMenu(): MenuItem {
  let previousEntryIsSeparator = false;

  const unfilteredFileMenu = getFileMenu();
  const filteredFileSubmenuItems = unfilteredFileMenu.submenu.items.filter((submenuEntry: MenuItem) => {
    const isSeparator = submenuEntry.type !== undefined && submenuEntry.type === 'separator';
    if (isSeparator) {
      // This is used to prevent double separators
      if (previousEntryIsSeparator) {
        return false;
      }

      previousEntryIsSeparator = true;
      return true;
    }

    const isSaveButton = submenuEntry.label !== undefined && submenuEntry.label.startsWith('Save');
    if (isSaveButton) {
      return false;
    }

    previousEntryIsSeparator = false;
    return true;
  });
  const newFileSubmenu: Menu = electron.Menu.buildFromTemplate(filteredFileSubmenuItems);

  const menuOptions: MenuItemConstructorOptions = {
    label: 'File',
    submenu: newFileSubmenu,
  };

  return new MenuItem(menuOptions);
}

function getApplicationMenu(): MenuItem {
  const submenuOptions: Array<MenuItemConstructorOptions> = [
    {
      label: `About ${getProductName()}`,
      click: (): void => {
        openAboutWindow(getAboutWindowInfo());
      },
    },
    {
      type: 'separator',
    },
    {
      label: 'Preferences',
      click: (): void => {
        browserWindow.webContents.send('menubar__open_preferences');
      },
    },
    {
      type: 'separator',
    },
    {
      label: 'Quit',
      role: 'quit',
    },
  ];
  const submenu: Menu = electron.Menu.buildFromTemplate(submenuOptions);

  const menuOptions: MenuItemConstructorOptions = {
    label: getProductName(),
    submenu: submenu,
  };

  return new MenuItem(menuOptions);
}

function getFileMenu(): MenuItem {
  const submenuOptions: Array<MenuItemConstructorOptions> = [
    {
      label: 'New Diagram',
      accelerator: 'CmdOrCtrl+N',
      click: (): void => {
        browserWindow.webContents.send('menubar__start_create_diagram');
      },
    },
    {
      type: 'separator',
    },
    {
      label: 'Open Diagram',
      accelerator: 'CmdOrCtrl+O',
      click: (): void => {
        browserWindow.webContents.send('menubar__start_opening_diagram');
      },
    },
    {
      label: 'Open Solution',
      accelerator: 'CmdOrCtrl+Shift+O',
      click: (): void => {
        browserWindow.webContents.send('menubar__start_opening_solution');
      },
    },
    {
      type: 'separator',
    },
    {
      label: 'Save Diagram',
      accelerator: 'CmdOrCtrl+S',
      click: (): void => {
        browserWindow.webContents.send('menubar__start_save_diagram');
      },
    },
    {
      label: 'Save Diagram As...',
      accelerator: 'CmdOrCtrl+Shift+S',
      click: (): void => {
        browserWindow.webContents.send('menubar__start_save_diagram_as');
      },
    },
    {
      label: 'Save All Diagrams',
      accelerator: 'CmdOrCtrl+Alt+S',
      click: (): void => {
        browserWindow.webContents.send('menubar__start_save_all_diagrams');
      },
    },
    {
      type: 'separator',
    },
    {
      label: 'Close Diagram',
      accelerator: 'CmdOrCtrl+W',
      click: (): void => {
        browserWindow.webContents.send('menubar__start_close_diagram');
      },
    },
    {
      label: 'Close All Diagrams',
      accelerator: 'CmdOrCtrl+Alt+W',
      click: (): void => {
        browserWindow.webContents.send('menubar__start_close_all_diagrams');
      },
    },
  ];
  const submenu: Menu = electron.Menu.buildFromTemplate(submenuOptions);

  const menuOptions: MenuItemConstructorOptions = {
    label: 'File',
    submenu: submenu,
  };

  return new MenuItem(menuOptions);
}

function getEditMenu(): MenuItem {
  const submenuOptions: Array<MenuItemConstructorOptions> = [
    {
      label: 'Undo',
      accelerator: 'CmdOrCtrl+Z',
      role: 'undo',
    },
    {
      label: 'Redo',
      accelerator: 'CmdOrCtrl+Shift+Z',
      role: 'redo',
    },
    {
      type: 'separator',
    },
    {
      label: 'Cut',
      accelerator: 'CmdOrCtrl+X',
      role: 'cut',
    },
    {
      label: 'Copy',
      accelerator: 'CmdOrCtrl+C',
      role: 'copy',
    },
    {
      label: 'Paste',
      accelerator: 'CmdOrCtrl+V',
      role: 'paste',
    },
    {
      label: 'Select All',
      accelerator: 'CmdOrCtrl+A',
      role: 'selectAll',
    },
  ];

  const submenu: Menu = electron.Menu.buildFromTemplate(submenuOptions);

  const menuOptions: MenuItemConstructorOptions = {
    label: 'Edit',
    submenu: submenu,
  };

  return new MenuItem(menuOptions);
}

function getWindowMenu(): MenuItem {
  const submenuOptions: Array<MenuItemConstructorOptions> = [
    {
      role: 'minimize',
    },
    {
      role: 'close',
    },
    {
      type: 'separator',
    },
    {
      role: 'reload',
    },
  ];

  const submenu: Menu = electron.Menu.buildFromTemplate(submenuOptions);

  const menuOptions: MenuItemConstructorOptions = {
    label: 'Window',
    submenu: submenu,
  };

  return new MenuItem(menuOptions);
}

function getHelpMenu(): MenuItem {
  const submenuOptions: Array<MenuItemConstructorOptions> = [
    {
      label: 'Getting Started',
      click: (): void => {
        const documentationUrl = 'https://www.process-engine.io/docs/getting-started/';
        electron.shell.openExternal(documentationUrl);
      },
    },
    {
      label: 'Release Notes',
      click: (): void => {
        const currentVersion = app.getVersion();
        const currentReleaseNotesUrl = `https://github.com/process-engine/bpmn-studio/releases/tag/v${currentVersion}`;
        electron.shell.openExternal(currentReleaseNotesUrl);
      },
    },
    {
      type: 'separator',
    },
    {
      label: 'Developer Support',
      submenu: [
        {
          role: 'toggleDevTools',
        },
        {
          type: 'separator',
        },
        {
          label: 'Export Databases to ZIP File ...',
          click: async (): Promise<void> => {
            try {
              await exportDatabases();
            } catch (error) {
              browserWindow.webContents.send('database-export-error', error.message);
            }
          },
        },
        {
          label: 'Open Folder for Databases',
          click: async (): Promise<void> => {
            electron.shell.openItem(getConfigFolder());
          },
        },
      ],
    },
  ];

  const submenu: Menu = electron.Menu.buildFromTemplate(submenuOptions);

  const menuOptions: MenuItemConstructorOptions = {
    label: 'Help',
    submenu: submenu,
  };

  return new MenuItem(menuOptions);
}

function getAboutWindowInfo(): AboutWindowInfo {
  const copyrightYear: number = new Date().getFullYear();

  return {
    icon_path: releaseChannel.isDev()
      ? path.join(__dirname, '../../../build/icon.png')
      : path.join(__dirname, '../../../../../build/icon.png'),
    product_name: getProductName(),
    bug_report_url: 'https://github.com/process-engine/bpmn-studio/issues/new',
    homepage: 'www.process-engine.io',
    copyright: `Copyright © ${copyrightYear} process-engine`,
    win_options: {
      minimizable: false,
      maximizable: false,
      resizable: false,
    },
    package_json_dir: __dirname,
  };
}

async function startInternalProcessEngine(): Promise<any> {
  const devUserDataFolderPath = path.join(__dirname, '..', 'userData');
  const prodUserDataFolderPath = app.getPath('userData');

  const userDataFolderPath = releaseChannel.isDev() ? devUserDataFolderPath : prodUserDataFolderPath;

  if (!releaseChannel.isDev()) {
    process.env.CONFIG_PATH = path.join(__dirname, '..', '..', '..', 'config');
  }

  const configForGetPort = {
    port: getPortListByVersion(releaseChannel.getVersion()),
    host: '0.0.0.0',
  };
  console.log('Trying to start internal ProcessEngine on ports:', configForGetPort);

  const port = await getPort(configForGetPort);

  console.log(`Internal ProcessEngine starting on port ${port}.`);

  process.env.http__http_extension__server__port = `${port}`;

  const processEngineDatabaseFolderName = getProcessEngineDatabaseFolderName();

  process.env.process_engine__process_model_repository__storage = path.join(
    userDataFolderPath,
    processEngineDatabaseFolderName,
    'process_model.sqlite',
  );
  process.env.process_engine__flow_node_instance_repository__storage = path.join(
    userDataFolderPath,
    processEngineDatabaseFolderName,
    'flow_node_instance.sqlite',
  );
  process.env.process_engine__timer_repository__storage = path.join(
    userDataFolderPath,
    processEngineDatabaseFolderName,
    'timer.sqlite',
  );

  const processEngineStatusListeners = [];
  let internalProcessEngineStatus;
  let internalProcessEngineStartupError;

  /* When someone wants to know to the internal processengine status, he
   * must first send a `add_internal_processengine_status_listener` message
   * to the event mechanism. We recieve this message here and add the sender
   * to our listeners array.
   *
   * As soon, as the processengine status is updated, we send the listeners a
   * notification about this change; this message contains the state and the
   * error text (if there was an error).
   *
   * If the processengine status is known by the time the listener registers,
   * we instantly respond to the listener with a notification message.
   *
   * This is quite a unusual pattern, the problem this approves solves is the
   * following: It's impossible to do interactions between threads in
   * electron like this:
   *
   *  'renderer process'              'main process'
   *          |                             |
   *          o   <<<- Send Message  -<<<   x
   *
   * -------------------------------------------------
   *
   * Instead our interaction now locks like this:
   *
   *  'renderer process'              'main process'
   *          |                             |
   *          x   >>>--  Subscribe  -->>>   o
   *          o   <<<- Send Message  -<<<   x
   *          |       (event occurs)        |
   *          o   <<<- Send Message  -<<<   x
   */
  ipcMain.on('add_internal_processengine_status_listener', (event: IpcMainEvent) => {
    if (!processEngineStatusListeners.includes(event.sender)) {
      processEngineStatusListeners.push(event.sender);
    }

    if (internalProcessEngineStatus !== undefined) {
      sendInternalProcessEngineStatus(event.sender, internalProcessEngineStatus, internalProcessEngineStartupError);
    }
  });

  // This tells the frontend the location at which the electron-skeleton
  // will be running; this 'get_host' request ist emitted in src/main.ts.
  ipcMain.on('get_host', (event: IpcMainEvent) => {
    event.returnValue = `localhost:${port}`;
  });

  ipcMain.on('get_version', (event: IpcMainEvent) => {
    event.returnValue = ProcessEngineVersion;
  });

  // TODO: Check if the ProcessEngine instance is now run on the UI thread.
  // See issue https://github.com/process-engine/bpmn-studio/issues/312
  try {
    const sqlitePath = getDatabaseFolder();
    const logFilepath = getLogFolder();

    const startupArgs = {
      sqlitePath: sqlitePath,
      logFilePath: logFilepath,
    };

    pe.startRuntime(startupArgs);

    console.log('Internal ProcessEngine started successfully.');
    internalProcessEngineStatus = 'success';

    publishProcessEngineStatus(
      processEngineStatusListeners,
      internalProcessEngineStatus,
      internalProcessEngineStartupError,
    );
  } catch (error) {
    console.error('Failed to start internal ProcessEngine: ', error);
    internalProcessEngineStatus = 'error';
    internalProcessEngineStartupError = error;

    publishProcessEngineStatus(
      processEngineStatusListeners,
      internalProcessEngineStatus,
      internalProcessEngineStartupError,
    );
  }
}

function getLogFolder(): string {
  return path.join(getConfigFolder(), getProcessEngineLogFolderName());
}

function getProcessEngineLogFolderName(): string {
  return 'process_engine_logs';
}

function getDatabaseFolder(): string {
  return path.join(getConfigFolder(), getProcessEngineDatabaseFolderName());
}

function getProcessEngineDatabaseFolderName(): string {
  return 'process_engine_databases';
}

function sendInternalProcessEngineStatus(
  sender: WebContents,
  internalProcessEngineStatus,
  internalProcessEngineStartupError,
): any {
  let serializedStartupError;
  const processEngineStartSuccessful =
    internalProcessEngineStartupError !== undefined && internalProcessEngineStartupError !== null;

  if (processEngineStartSuccessful) {
    serializedStartupError = JSON.stringify(
      internalProcessEngineStartupError,
      Object.getOwnPropertyNames(internalProcessEngineStartupError),
    );
  } else {
    serializedStartupError = undefined;
  }

  sender.send('internal_processengine_status', internalProcessEngineStatus, serializedStartupError);
}

function publishProcessEngineStatus(
  processEngineStatusListeners,
  internalProcessEngineStatus,
  internalProcessEngineStartupError,
): void {
  processEngineStatusListeners.forEach((processEngineStatusLisener) => {
    sendInternalProcessEngineStatus(
      processEngineStatusLisener,
      internalProcessEngineStatus,
      internalProcessEngineStartupError,
    );
  });
}

function getConfigFolder(): string {
  const configPath = `bpmn-studio${getConfigPathSuffix()}`;

  return path.join(getUserConfigFolder(), configPath);
}

function getConfigPathSuffix(): string {
  if (process.env.SPECTRON_TESTS) {
    return '-tests';
  }
  if (releaseChannel.isDev()) {
    return '-dev';
  }
  if (releaseChannel.isAlpha()) {
    return '-alpha';
  }
  if (releaseChannel.isBeta()) {
    return '-beta';
  }
  if (releaseChannel.isStable()) {
    return '';
  }

  throw new Error('Could not get config path suffix for internal process engine');
}

function getUserConfigFolder(): string {
  const userHomeDir = homedir();

  switch (process.platform) {
    case 'darwin':
      return path.join(userHomeDir, 'Library', 'Application Support');
    case 'win32':
      return path.join(userHomeDir, 'AppData', 'Roaming');
    default:
      return path.join(userHomeDir, '.config');
  }
}

function bringExistingInstanceToForeground(): void {
  if (browserWindow) {
    if (browserWindow.isMinimized()) {
      browserWindow.restore();
    }

    browserWindow.focus();
  }
}

async function exportDatabases(): Promise<void> {
  const zip = new JSZip();

  const img = zip.folder(getProcessEngineDatabaseFolderName());

  const foldername: string = getDatabaseFolder();

  const files: Array<string> = await getFilenamesOfFilesInFolder(foldername);

  files.forEach((filename: string) => {
    const filePath: string = `${foldername}/${filename}`;

    img.file(filename, fs.readFileSync(filePath), {base64: true});
  });

  // eslint-disable-next-line newline-per-chained-call
  const now = new Date().toISOString().replace(/:/g, '-');

  const downloadPath = electron.app.getPath('downloads');
  const defaultPath = path.join(downloadPath, `database-backup-${now}.zip`);

  const savePath: string = dialog.showSaveDialogSync({
    defaultPath: defaultPath,
    filters: [
      {
        name: 'zip',
        extensions: ['zip'],
      },
      {
        name: 'All Files',
        extensions: ['*'],
      },
    ],
  });

  if (!savePath) {
    return;
  }

  zip.generateAsync({type: 'nodebuffer'}).then((content) => {
    fs.writeFileSync(savePath, content);
  });
}

function getFilenamesOfFilesInFolder(foldername): Promise<Array<string>> {
  return new Promise((resolve: Function, reject: Function): void => {
    fs.readdir(foldername, (error: Error, fileNames: Array<string>): void => {
      if (error) {
        reject(new Error(`Unable to scan directory: ${error}`));

        return;
      }

      resolve(fileNames);
    });
  });
}

execute();
