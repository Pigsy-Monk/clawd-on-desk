const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("noticeBubbleAPI", {
  onShow: (cb) => ipcRenderer.on("notice-bubble-show", (_, data) => cb(data)),
  onHide: (cb) => ipcRenderer.on("notice-bubble-hide", () => cb()),
  reportHeight: (height) => ipcRenderer.send("notice-bubble-height", height),
  dismiss: (id) => ipcRenderer.send("notice-bubble-dismiss", id),
  stretchAction: (action) => ipcRenderer.send("notice-bubble-stretch-action", typeof action === "string" ? action : ""),
  expand: (id) => ipcRenderer.send("notice-bubble-expand", id),
  copy: (id) => ipcRenderer.send("notice-bubble-copy", id),
});
