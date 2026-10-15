const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("noticeChartAPI", {
  onShow: (cb) => ipcRenderer.on("notice-chart-show", (_, data) => cb(data)),
  onHide: (cb) => ipcRenderer.on("notice-chart-hide", () => cb()),
  reportHeight: (height) => ipcRenderer.send("notice-chart-height", height),
  close: () => ipcRenderer.send("notice-chart-close"),
});
