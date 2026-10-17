const { contextBridge, ipcRenderer, webUtils } = require("electron");

// Parse hit-renderer theme config from additionalArguments (synchronous, available on first load)
const hitThemeArg = process.argv.find(a => a.startsWith("--hit-theme-config="));
const hitThemeConfig = hitThemeArg ? JSON.parse(hitThemeArg.slice("--hit-theme-config=".length)) : null;

// Parse platform from additionalArguments so hit-renderer can branch on
// macOS-specific input semantics (Cmd vs Ctrl, Ctrl-click = right-click, etc.).
const platformArg = process.argv.find(a => a.startsWith("--hit-platform="));
const platform = platformArg ? platformArg.slice("--hit-platform=".length) : process.platform;

contextBridge.exposeInMainWorld("hitThemeConfig", hitThemeConfig);
contextBridge.exposeInMainWorld("hitPlatform", {
  isMac: platform === "darwin",
  platform,
});

contextBridge.exposeInMainWorld("hitAPI", {
  // Theme config push (for hot-switch; additionalArguments won't update on reload)
  onThemeConfig: (cb) => ipcRenderer.on("theme-config", (_, cfg) => cb(cfg)),
  // Sends → main
  dragLock: (locked) => ipcRenderer.send("drag-lock", locked),
  dragMove: () => ipcRenderer.send("drag-move"),
  dragEnd: () => ipcRenderer.send("drag-end"),
  // The client point lets main decide whether a right-click landed on the
  // notice head screen (copy) or anywhere else (the normal menu).
  showContextMenu: (point) => {
    const safe = point && Number.isFinite(point.clientX) && Number.isFinite(point.clientY)
      ? { clientX: point.clientX, clientY: point.clientY }
      : null;
    ipcRenderer.send("show-context-menu", safe);
  },
  // Notice head screen: hover / leave / wheel while the pose is up. Main
  // converts the client point to viewBox units and forwards it.
  noticeScreenPointer: (input) => {
    if (!input || typeof input !== "object") return;
    const type = input.type;
    if (type !== "move" && type !== "leave" && type !== "wheel") return;
    const safe = { type };
    if (type !== "leave") {
      if (!Number.isFinite(input.clientX) || !Number.isFinite(input.clientY)) return;
      safe.clientX = input.clientX;
      safe.clientY = input.clientY;
    }
    if (type === "wheel") {
      safe.deltaY = Number.isFinite(input.deltaY) ? input.deltaY : 0;
      safe.deltaMode = input.deltaMode === 1 || input.deltaMode === 2 ? input.deltaMode : 0;
    }
    ipcRenderer.send("notice-screen-hit-pointer", safe);
  },
  // Notice sign: a left-click while the sign is up. Resolves true when it
  // landed on the board (main opens the notice's card), false otherwise (the
  // caller treats it as an ordinary click on the pet).
  noticeScreenClick: (input) => {
    if (!input || !Number.isFinite(input.clientX) || !Number.isFinite(input.clientY)) {
      return Promise.resolve(false);
    }
    return ipcRenderer.invoke("notice-screen-hit-click", { clientX: input.clientX, clientY: input.clientY })
      .then((handled) => handled === true, () => false);
  },
  focusTerminal: () => ipcRenderer.send("focus-terminal"),
  // OS file drop (#459). File → absolute path must resolve here in the
  // preload: Electron ≥32 removed File.path from the renderer, and
  // webUtils.getPathForFile only accepts a File passed across the bridge.
  // Returns "" for non-filesystem Files (e.g. images dragged from a browser).
  getPathForFile: (file) => {
    try { return webUtils.getPathForFile(file) || ""; } catch (_) { return ""; }
  },
  dropPaths: (paths) => ipcRenderer.send("pet-drop-paths", paths),
  onDropAccepted: (cb) => ipcRenderer.on("pet-drop-accepted", () => cb()),
  exitMiniMode: () => ipcRenderer.send("exit-mini-mode"),
  showDashboard: () => ipcRenderer.send("show-dashboard"),
  revealSessionHud: () => ipcRenderer.send("pet-interaction:reveal-session-hud"),
  // Reaction triggers → main → renderWin
  startDragReaction: (direction) => ipcRenderer.send("start-drag-reaction", direction),
  endDragReaction: () => ipcRenderer.send("end-drag-reaction"),
  playClickReaction: (svg, duration) => ipcRenderer.send("play-click-reaction", svg, duration),
  // State sync ← main
  onStateSync: (cb) => ipcRenderer.on("hit-state-sync", (_, data) => cb(data)),
  onCancelReaction: (cb) => ipcRenderer.on("hit-cancel-reaction", () => cb()),
  // Main released a drag lock from a user-invoked recovery action; drop any
  // local capture so the next gesture starts clean.
  onForceDragRelease: (cb) => ipcRenderer.on("force-drag-release", () => cb()),
});
