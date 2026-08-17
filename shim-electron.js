
    const app = {
    getPath: (n) => ({ userData: '/tmp/nova-dispatch-data', home: process.env.HOME, documents: process.env.HOME + '/Documents', downloads: process.env.HOME + '/Downloads', desktop: process.env.HOME + '/Desktop' })[n] || '/tmp',
    whenReady: () => Promise.resolve(),
    on: () => {},
    quit: () => {},
    isReady: () => true,
    getName: () => 'Nova',
    getVersion: () => '0.9.0',
    getPathSafe: null,
  };
    class BrowserWindow {
      constructor(opts) { this.opts = opts; }
      loadFile() {}
      loadURL() {}
      show() {}
      hide() {}
      focus() {}
      isDestroyed() { return false; }
      isFocused() { return false; }
      on() {}
      once() {}
      emit() {}
      webContents = { send: () => {}, setZoomFactor: () => {}, isFocused: () => false, executeJavaScript: () => Promise.resolve() };
      static getAllWindows() { return []; }
    }
    module.exports = { app, BrowserWindow, ipcMain: { handle: () => {}, on: () => {} }, ipcRenderer: null, dialog: {}, Menu: { buildFromTemplate: () => null }, nativeTheme: {}, systemPreferences: { getMediaAccessStatus: () => 'not-determined' }, globalShortcut: { register: () => true, isRegistered: () => false, unregisterAll: () => {} } };
  