
    const app = { getPath: (n) => ({ userData: '/tmp/nova-dispatch-data', home: process.env.HOME, documents: process.env.HOME + '/Documents', downloads: process.env.HOME + '/Downloads', desktop: process.env.HOME + '/Desktop' })[n] || '/tmp' };
    module.exports = { app, BrowserWindow: { getAllWindows: () => [] }, ipcMain: { handle: () => {}, on: () => {} }, ipcRenderer: null, dialog: {}, Menu: {}, nativeTheme: {}, systemPreferences: { getMediaAccessStatus: () => 'not-determined' } };
  