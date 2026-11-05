// The window's only bridge to the app (contextIsolation and sandbox are on). It exposes the calls
// of Settings > Updates and Uninstall, and nothing that reaches files, processes or the network.
import electron = require("electron");
const { contextBridge, ipcRenderer } = electron;

contextBridge.exposeInMainWorld("latch", {
  version: (): Promise<string> => ipcRenderer.invoke("latch:version"),
  checkForUpdates: (): Promise<unknown> => ipcRenderer.invoke("latch:check-for-updates"),
  updateStatus: (): Promise<unknown> => ipcRenderer.invoke("latch:update-status"),
  installUpdate: (): Promise<unknown> => ipcRenderer.invoke("latch:install-update"),
  uninstall: (): Promise<unknown> => ipcRenderer.invoke("latch:uninstall"),
});
