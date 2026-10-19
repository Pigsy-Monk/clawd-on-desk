const { contextBridge, ipcRenderer } = require("electron");

// Parse theme config from additionalArguments (synchronous, available on first load)
const themeArg = process.argv.find(a => a.startsWith("--theme-config="));
const themeConfig = themeArg ? JSON.parse(themeArg.slice("--theme-config=".length)) : null;

// The aim sample rides along with eye-move for themes with rotate/foreshorten
// tracking layers: the cursor relative to the art rect's top-left corner plus
// that rect's size, in device px. Validated here (not only in the renderer) so a
// malformed sample never crosses the bridge; `null` means "no sample", which is
// how the renderer's eye-move(0, 0) zeroing returns the aim to rest.
function normalizeAimSample(aim) {
  if (!aim || typeof aim !== "object") return null;
  const { x, y, w, h } = aim;
  if (![x, y, w, h].every((value) => typeof value === "number" && Number.isFinite(value))) return null;
  if (!(w > 0) || !(h > 0)) return null;
  return { x, y, w, h };
}

contextBridge.exposeInMainWorld("themeConfig", themeConfig);

contextBridge.exposeInMainWorld("electronAPI", {
  // Theme config push (for hot-switch; additionalArguments won't update on reload)
  onThemeConfig: (cb) => ipcRenderer.on("theme-config", (_, cfg) => cb(cfg)),
  // PR #751 Codex review #12 (rework batch B-8, non-blocking): normalize a
  // non-finite value (NaN, +/-Infinity, or anything main.js might someday
  // send that isn't a plain number) to 0 right at the IPC bridge boundary,
  // instead of trusting main.js to always send a legal number. The renderer
  // side already defends against this independently (renderer.js's own
  // offset handlers), but that's a second, redundant line of defense, not a
  // reason to let an illegal value cross the bridge in the first place.
  onViewportOffset: (cb) => ipcRenderer.on("viewport-offset", (_, offsetY) => cb(Number.isFinite(offsetY) ? offsetY : 0)),
  onViewportOffsetX: (cb) => ipcRenderer.on("viewport-offset-x", (_, offsetX) => cb(Number.isFinite(offsetX) ? offsetX : 0)),
  onPetTintChange: (cb) => ipcRenderer.on("pet-tint-change", (_, payload) => cb(payload)),
  onPetAccessoryChange: (cb) => ipcRenderer.on("pet-accessory-change", (_, payload) => cb(payload)),
  onPetAccessorySlotsChange: (cb) => ipcRenderer.on("pet-accessory-slots-change", (_, snapshot) => cb(snapshot)),
  // State sync from main
  onStateChange: (callback) => ipcRenderer.on("state-change", (_, requestOrState, legacySvg) => callback(requestOrState, legacySvg)),
  onKimiPermissionPulse: (callback) => ipcRenderer.on("kimi-permission-pulse", () => callback()),
  // The third argument is the aim sample for themes with rotate/foreshorten
  // tracking layers (see normalizeAimSample above).
  onEyeMove: (callback) => ipcRenderer.on("eye-move", (_, dx, dy, aim) => callback(dx, dy, normalizeAimSample(aim))),
  onCloudlingPointer: (callback) => ipcRenderer.on("cloudling-pointer", (_, payload) => callback(payload)),
  onRoamHeading: (callback) => ipcRenderer.on("roam-heading", (_, headingLeft) => callback(headingLeft)),
  onPetScreenSide: (callback) => ipcRenderer.on("pet-screen-side", (_, onRight) => callback(onRight)),
  onWakeFromDoze: (callback) => ipcRenderer.on("wake-from-doze", () => callback()),
  onDndChange: (callback) => ipcRenderer.on("dnd-change", (_, enabled) => callback(enabled)),
  onMiniModeChange: (cb) => ipcRenderer.on("mini-mode-change", (_, enabled, edge, options) => cb(enabled, edge, options)),
  onMiniClip: (cb) => ipcRenderer.on("mini-clip", (_, info) => cb(info)),
  onLowPowerIdleModeChange: (cb) => ipcRenderer.on("low-power-idle-mode-change", (_, enabled) => cb(enabled)),
  onSystemWake: (cb) => ipcRenderer.on("system-wake", (_, payload) => cb(payload)),
  // Reaction control (from main, relayed from hit window)
  onStartDragReaction: (cb) => ipcRenderer.on("start-drag-reaction", (_, requestOrDirection, legacyDirection) => cb(requestOrDirection, legacyDirection)),
  onEndDragReaction: (cb) => ipcRenderer.on("end-drag-reaction", () => cb()),
  onPlayClickReaction: (cb) => ipcRenderer.on("play-click-reaction", (_, requestOrSvg, duration, options) => cb(requestOrSvg, duration, options)),
  onCancelClickReaction: (cb) => ipcRenderer.on("cancel-click-reaction", () => cb()),
  onPlayTestReaction: (cb) => ipcRenderer.on("play-test-reaction", (_, result) => {
    if (result === "pass" || result === "fail") cb(result);
  }),
  // A notice reaction is either a bare level (older main) or
  // { level, id, title, visualRequest? }. Only those fields cross the bridge,
  // each type-checked; the level stays whitelisted either way.
  onPlayNoticeReaction: (cb) => ipcRenderer.on("play-notice-reaction", (_, payload) => {
    const isLevel = (value) => value === "info" || value === "success" || value === "warn" || value === "error";
    if (isLevel(payload)) {
      cb({ level: payload, id: null, title: "" });
      return;
    }
    if (!payload || typeof payload !== "object" || !isLevel(payload.level)) return;
    const safe = {
      level: payload.level,
      id: typeof payload.id === "string" && payload.id.length <= 64 ? payload.id : null,
      title: typeof payload.title === "string" ? payload.title.slice(0, 200) : "",
    };
    if (Number.isFinite(payload.dwellMs) && payload.dwellMs > 0) safe.dwellMs = Math.min(120000, payload.dwellMs);
    if (payload.visualRequest && typeof payload.visualRequest === "object") {
      safe.visualRequest = payload.visualRequest;
    }
    cb(safe);
  }),
  // Notice head screen: pointer input forwarded by main (already in viewBox
  // units), the copy confirmation, and the screen's status back to main.
  onNoticeScreenPointer: (cb) => ipcRenderer.on("notice-screen-pointer", (_, input) => {
    if (!input || typeof input !== "object") return;
    if (input.type === "leave") {
      cb({ type: "leave" });
      return;
    }
    if ((input.type !== "move" && input.type !== "wheel")
        || !Number.isFinite(input.x) || !Number.isFinite(input.y)) return;
    const safe = { type: input.type, x: input.x, y: input.y };
    if (input.type === "wheel") {
      safe.deltaY = Number.isFinite(input.deltaY) ? input.deltaY : 0;
      safe.deltaMode = input.deltaMode === 1 || input.deltaMode === 2 ? input.deltaMode : 0;
    }
    cb(safe);
  }),
  onNoticeScreenCopied: (cb) => ipcRenderer.on("notice-screen-copied", (_, info) => {
    cb({ id: info && typeof info.id === "string" ? info.id : null });
  }),
  onNoticeScreenLower: (cb) => ipcRenderer.on("notice-screen-lower", (_, info) => {
    cb({ id: info && typeof info.id === "string" ? info.id : null });
  }),
  reportNoticeScreenStatus: (status) => {
    if (!status || typeof status !== "object") return;
    const rect = status.rect && typeof status.rect === "object"
      && [status.rect.x, status.rect.y, status.rect.w, status.rect.h].every(Number.isFinite)
      ? { x: status.rect.x, y: status.rect.y, w: status.rect.w, h: status.rect.h }
      : null;
    // Why an ended pose ended: main keeps the notice's card held back after
    // "dwell" / "replaced" and shows it after anything else.
    const reason = status.reason === "dwell" || status.reason === "replaced" ? status.reason : "cancel";
    ipcRenderer.send("notice-screen-status", {
      active: status.active === true,
      id: typeof status.id === "string" ? status.id : null,
      rect,
      ...(status.active === true ? {} : { reason }),
    });
  },
  // Sound playback (from main)
  onPreloadSounds: (cb) => ipcRenderer.on("preload-sounds", (_, payload) => cb(payload)),
  onPlaySound: (cb) => ipcRenderer.on("play-sound", (_, payload) => cb(payload)),
  onInvalidateSoundCache: (cb) => ipcRenderer.on("invalidate-sound-cache", (_, url) => cb(url)),
  reportSoundPlaybackError: (payload) => ipcRenderer.send("sound-playback-error", payload),
  // Render window → main (cursor polling control during reactions)
  pauseCursorPolling: () => ipcRenderer.send("pause-cursor-polling"),
  resumeFromReaction: () => ipcRenderer.send("resume-from-reaction"),
  notifyPetVisualReady: () => ipcRenderer.send("pet-visual-ready"),
  notifyPetVisualSettled: (payload) => {
    if (!payload || typeof payload !== "object") return;
    const safe = {
      themeId: typeof payload.themeId === "string" ? payload.themeId : null,
      displayState: typeof payload.displayState === "string" ? payload.displayState : null,
      requestedFile: typeof payload.requestedFile === "string" ? payload.requestedFile : null,
      actualFile: typeof payload.actualFile === "string" ? payload.actualFile : null,
      channel: typeof payload.channel === "string" ? payload.channel : null,
      verified: payload.verified === true,
      visualGeneration: Number.isSafeInteger(payload.visualGeneration) ? payload.visualGeneration : null,
      outcome: typeof payload.outcome === "string" ? payload.outcome : null,
    };
    ipcRenderer.send("pet-visual-settled", safe);
  },
  setLowPowerIdlePaused: (paused) => ipcRenderer.send("low-power-idle-paused", !!paused),
  reportSystemWakeStatus: (payload) => ipcRenderer.send("system-wake-status", payload),
  reportAccessoryMirror: (mirrored) => ipcRenderer.send("accessory-mirror", !!mirrored),
});
