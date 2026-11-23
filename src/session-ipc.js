"use strict";

const path = require("node:path");
const { pathToFileURL } = require("node:url");

const DASHBOARD_PAGE_URL = pathToFileURL(path.join(__dirname, "dashboard.html")).toString();

function requiredDependency(value, name) {
  if (!value) throw new Error(`registerSessionIpc requires ${name}`);
  return value;
}

function registerSessionIpc(options = {}) {
  const ipcMain = requiredDependency(options.ipcMain, "ipcMain");
  const getSessionSnapshot = requiredDependency(options.getSessionSnapshot, "getSessionSnapshot");
  const getI18n = requiredDependency(options.getI18n, "getI18n");
  const focusSession = requiredDependency(options.focusSession, "focusSession");
  const hideSession = requiredDependency(options.hideSession, "hideSession");
  const setSessionAlias = requiredDependency(options.setSessionAlias, "setSessionAlias");
  const showDashboard = requiredDependency(options.showDashboard, "showDashboard");
  const setSessionHudPinned = requiredDependency(options.setSessionHudPinned, "setSessionHudPinned");
  const ackSessionCompletion = requiredDependency(options.ackSessionCompletion, "ackSessionCompletion");
  const openSessionFolder = requiredDependency(options.openSessionFolder, "openSessionFolder");
  const setSessionAutomationOverride = requiredDependency(
    options.setSessionAutomationOverride,
    "setSessionAutomationOverride"
  );
  const clearSessionAutomationGrant = requiredDependency(
    options.clearSessionAutomationGrant,
    "clearSessionAutomationGrant"
  );
  const getDashboardWebContents = requiredDependency(
    options.getDashboardWebContents,
    "getDashboardWebContents"
  );
  // Optional: only the feat/notice-presentation HUD rows use it. A build without
  // a link opener simply does not register the channel.
  const openExternalLink = typeof options.openExternalLink === "function"
    ? options.openExternalLink
    : null;
  const followUpFeishuChat = typeof options.followUpFeishuChat === "function"
    ? options.followUpFeishuChat
    : null;
  const ignoreFeishuMessage = typeof options.ignoreFeishuMessage === "function"
    ? options.ignoreFeishuMessage
    : null;
  const getFeishuBoard = typeof options.getFeishuBoard === "function"
    ? options.getFeishuBoard
    : null;
  const takeDashboardInitialTab = typeof options.takeDashboardInitialTab === "function"
    ? options.takeDashboardInitialTab
    : null;
  const openFeishuBoard = typeof options.openFeishuBoard === "function"
    ? options.openFeishuBoard
    : null;
  const getKimiQuotaStatus = requiredDependency(options.getKimiQuotaStatus, "getKimiQuotaStatus");
  const refreshKimiQuota = requiredDependency(options.refreshKimiQuota, "refreshKimiQuota");
  const getSessionHistory = requiredDependency(options.getSessionHistory, "getSessionHistory");
  const resumeSessionFromHistory = requiredDependency(
    options.resumeSessionFromHistory,
    "resumeSessionFromHistory"
  );
  const quickMode = options.quickMode || null;
  // Optional: the notice history (notice-history.js) and the copy formatter
  // shared with the notice bubble. Without them the Notices tab has no
  // channels to reach, the same way an unsupported quick mode has none.
  const noticeHistory = options.noticeHistory || null;
  const noticeCopyText = typeof options.noticeCopyText === "function" ? options.noticeCopyText : null;
  const writeClipboard = typeof options.writeClipboard === "function" ? options.writeClipboard : null;
  const disposers = [];

  function handle(channel, listener) {
    ipcMain.handle(channel, listener);
    disposers.push(() => ipcMain.removeHandler(channel));
  }

  function on(channel, listener) {
    ipcMain.on(channel, listener);
    disposers.push(() => ipcMain.removeListener(channel, listener));
  }

  // The one owned Dashboard WebContents, its current real main frame, and the
  // exact local page URL. Resolving through a window would break once the page
  // lives in a WebContentsView, and loosening any of the three would widen the
  // Kimi manual-quota capability — neither is acceptable.
  function isTrustedDashboardEvent(event) {
    const contents = getDashboardWebContents();
    if (!contents) return false;
    if (typeof contents.isDestroyed === "function" && contents.isDestroyed()) return false;
    const frame = event && event.senderFrame;
    return event.sender === contents
      && !!frame
      && frame === contents.mainFrame
      && frame.url === DASHBOARD_PAGE_URL;
  }

  function rejectUntrustedDashboardEvent(event) {
    return isTrustedDashboardEvent(event)
      ? null
      : { status: "error", reason: "untrusted-dashboard-sender" };
  }

  handle("dashboard:get-snapshot", () => getSessionSnapshot());
  // The Feishu board reads on demand (it is a browse view, not a cache).
  if (getFeishuBoard) handle("dashboard:get-feishu-board", () => getFeishuBoard());
  if (takeDashboardInitialTab) handle("dashboard:get-initial-tab", () => takeDashboardInitialTab());
  handle("dashboard:get-i18n", () => getI18n());
  // Dashboard gets a narrow, secret-free manual refresh capability. The API
  // key remains inside kimiQuotaRuntime, and only the real local Dashboard
  // main frame may ask for status or trigger the existing refresh path.
  handle("dashboard:get-kimi-quota-status", (event) => {
    const rejected = rejectUntrustedDashboardEvent(event);
    return rejected || getKimiQuotaStatus();
  });
  handle("dashboard:refresh-kimi-quota", (event) => {
    const rejected = rejectUntrustedDashboardEvent(event);
    return rejected || refreshKimiQuota();
  });
  on("dashboard:focus-session", (_event, sessionId) =>
    focusSession(sessionId, { requestSource: "dashboard" })
  );
  handle("dashboard:hide-session", (_event, sessionId) => hideSession(sessionId));
  handle("dashboard:open-session-folder", (_event, sessionId) => {
    if (typeof sessionId !== "string" || !sessionId) {
      return { status: "error", message: "dashboard:open-session-folder requires a sessionId string" };
    }
    return openSessionFolder(sessionId);
  });
  // Session history is the resume index for conversations that are no longer
  // running. Rows carry working-directory paths, and resuming spawns a real
  // agent process, so both channels are restricted to the trusted Dashboard
  // frame the same way the Kimi quota capability is.
  handle("dashboard:get-session-history", (event) => {
    const rejected = rejectUntrustedDashboardEvent(event);
    return rejected || getSessionHistory();
  });
  handle("dashboard:resume-session", (event, payload) => {
    const rejected = rejectUntrustedDashboardEvent(event);
    if (rejected) return rejected;
    const keys = payload && typeof payload === "object" && !Array.isArray(payload)
      ? Object.keys(payload).sort()
      : [];
    if (
      keys.length !== 2
      || keys[0] !== "agentId"
      || keys[1] !== "historyKey"
      || typeof payload.agentId !== "string"
      || !payload.agentId
      || typeof payload.historyKey !== "string"
      || !/^[a-f0-9]{32}$/.test(payload.historyKey)
    ) {
      return { status: "invalid" };
    }
    // No mode field on purpose: the Dashboard can only resume with normal
    // permissions. --dangerously-skip-permissions stays behind the pet menu
    // flow, which confirms it explicitly.
    return resumeSessionFromHistory({
      agentId: payload.agentId,
      historyKey: payload.historyKey,
    });
  });

  // Notice history holds the text agents pushed, so all three channels are
  // restricted to the trusted Dashboard frame. Copy and clear take nothing the
  // page could widen: copy sends an id and main reads the text from the store
  // (main owns the clipboard), clear takes no payload at all.
  if (noticeHistory) {
    handle("dashboard:get-notice-history", (event) => {
      const rejected = rejectUntrustedDashboardEvent(event);
      return rejected || noticeHistory.getSnapshot();
    });
    handle("dashboard:clear-notice-history", (event) => {
      const rejected = rejectUntrustedDashboardEvent(event);
      return rejected || noticeHistory.clear();
    });
    handle("dashboard:copy-notice", (event, id) => {
      const rejected = rejectUntrustedDashboardEvent(event);
      if (rejected) return rejected;
      if (typeof id !== "string" || !id || id.length > 128) return { status: "invalid" };
      const entry = noticeHistory.get(id);
      if (!entry) return { status: "not-found" };
      const text = noticeCopyText ? noticeCopyText(entry) : "";
      if (!text || !writeClipboard) return { status: "empty" };
      try {
        writeClipboard(text);
      } catch (err) {
        return { status: "error", message: err && err.message };
      }
      return { status: "ok" };
    });
  }

  handle("dashboard:set-session-alias", (_event, payload) => setSessionAlias(payload));
  handle("dashboard:set-session-automation", (event, payload) => {
    const keys = payload && typeof payload === "object" && !Array.isArray(payload)
      ? Object.keys(payload).sort()
      : [];
    if (
      keys.length !== 2
      || keys[0] !== "mode"
      || keys[1] !== "sessionId"
      || typeof payload.sessionId !== "string"
      || !payload.sessionId
      || (payload.mode !== "off" && payload.mode !== "auto-tools")
    ) {
      return { status: "invalid" };
    }
    return setSessionAutomationOverride(
      {
        sessionId: payload.sessionId,
        mode: payload.mode,
      },
      { sender: event && event.sender }
    );
  });
  handle("dashboard:clear-session-automation-grant", (_event, payload) => {
    const keys = payload && typeof payload === "object" && !Array.isArray(payload)
      ? Object.keys(payload)
      : [];
    if (
      keys.length !== 1
      || keys[0] !== "grantId"
      || typeof payload.grantId !== "string"
      || !payload.grantId
    ) {
      return { status: "invalid" };
    }
    return clearSessionAutomationGrant({ grantId: payload.grantId });
  });

  // Dashboard keyboard mode. Every call is restricted to the trusted page and
  // carries the exact round it belongs to; a stale round can neither activate
  // a jump nor cancel the current one.
  //
  // On a platform where the mode is not offered the channels are never
  // registered at all — there is no capability to reach, not merely a handler
  // that answers "unsupported".
  const quickSupported = !!(quickMode
    && typeof quickMode.isSupported === "function"
    && quickMode.isSupported());

  if (quickSupported) {
    const quickResult = (handlerName, event, payload) => {
      const rejected = rejectUntrustedDashboardEvent(event);
      if (rejected) return rejected;
      if (typeof quickMode[handlerName] !== "function") return { status: "unsupported" };
      return quickMode[handlerName](payload);
    };

    handle("dashboard:quick-pending", (event) => {
      const rejected = rejectUntrustedDashboardEvent(event);
      if (rejected) return rejected;
      return { status: "ok", revision: quickMode.getPendingRevision() };
    });
    handle("dashboard:quick-enter", (event, payload) => quickResult("enter", event, payload));
    handle("dashboard:quick-ready", (event, payload) => quickResult("ready", event, payload));
    handle("dashboard:quick-activate", (event, payload) =>
      quickResult("activate", event, payload));
    handle("dashboard:quick-dismiss", (event, payload) =>
      quickResult("dismissFromRenderer", event, payload));
  }

  handle("session-hud:get-i18n", () => getI18n());
  handle("session-hud:open-session-folder", (_event, sessionId) => {
    if (typeof sessionId !== "string" || !sessionId) {
      return { status: "error", message: "session-hud:open-session-folder requires a sessionId string" };
    }
    return openSessionFolder(sessionId);
  });
  on("session-hud:focus-session", (_event, sessionId) =>
    focusSession(sessionId, { requestSource: "hud" })
  );
  on("session-hud:open-dashboard", () => showDashboard({ source: "hud" }));
  on("session-hud:set-pinned", (_event, value) => setSessionHudPinned(!!value));
  // A Feishu digest row's link. The URL is validated in main before it reaches
  // the OS browser; the renderer only forwards the string it was given.
  if (openExternalLink) {
    on("session-hud:open-link", (_event, href) => {
      if (typeof href === "string" && href) openExternalLink(href);
    });
  }
  if (followUpFeishuChat) {
    on("session-hud:follow-up", (_event, payload) => {
      if (payload && typeof payload === "object") followUpFeishuChat(payload);
    });
  }
  if (openFeishuBoard) {
    on("session-hud:open-feishu-board", () => openFeishuBoard());
  }
  // The Dashboard's Feishu tab offers the same two actions as the pet panel's
  // rows, so it goes through the same two handlers rather than a copy.
  if (openExternalLink) {
    on("dashboard:open-link", (_event, href) => {
      if (typeof href === "string" && href) openExternalLink(href);
    });
  }
  if (followUpFeishuChat) {
    on("dashboard:follow-up", (_event, payload) => {
      if (payload && typeof payload === "object") followUpFeishuChat(payload);
    });
  }
  if (ignoreFeishuMessage) {
    on("session-hud:ignore", (_event, messageIds) => {
      // A row stands for a conversation, so this arrives as a list.
      if (Array.isArray(messageIds) && messageIds.length) ignoreFeishuMessage(messageIds);
    });
  }

  on("settings:open-dashboard", () => showDashboard({ source: "settings" }));
  on("show-dashboard", () => showDashboard());

  // Both HUD and Dashboard call into this — invoke/handle (not send) so the
  // click handlers can re-enable the Mark-read button if the ack failed.
  handle("session:ack-completion", (_event, sessionId) => {
    if (typeof sessionId !== "string" || !sessionId) {
      return { status: "error", message: "session:ack-completion requires a sessionId string" };
    }
    try {
      const acked = ackSessionCompletion(sessionId);
      if (!acked) return { status: "noop", reason: "not-pending-or-missing" };
      return { status: "ok" };
    } catch (err) {
      return { status: "error", message: err && err.message };
    }
  });

  return {
    dispose() {
      while (disposers.length) {
        const dispose = disposers.pop();
        dispose();
      }
    },
  };
}

module.exports = {
  registerSessionIpc,
};
