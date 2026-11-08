const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("timebox", {
  setWidget: (on) => ipcRenderer.send("set-widget", !!on),
});
