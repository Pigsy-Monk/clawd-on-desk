"use strict";

const noop = () => {};

function isLiveWindow(win) {
  return !!(win && (typeof win.isDestroyed !== "function" || !win.isDestroyed()));
}

function getPendingList(getPendingPermissions) {
  const pending = getPendingPermissions();
  return Array.isArray(pending) ? pending : [];
}

function createFloatingWindowRuntime(options = {}) {
  const getPendingPermissions = options.getPendingPermissions || (() => []);
  const keepOutOfTaskbar = options.keepOutOfTaskbar || noop;
  const repositionPermissionBubbles = options.repositionPermissionBubbles || noop;
  const repositionUpdateBubble = options.repositionUpdateBubble || noop;
  const repositionSessionHud = options.repositionSessionHud || noop;
  const repositionQuotaRing = options.repositionQuotaRing || noop;
  const syncSessionHudVisibility = options.syncSessionHudVisibility || noop;
  const syncUpdateBubbleVisibility = options.syncUpdateBubbleVisibility || noop;
  const suspendUpdateBubbleForPet = options.suspendUpdateBubbleForPet || options.hideUpdateBubble || noop;
  const suspendUpdateBubbleForFullscreen = options.suspendUpdateBubbleForFullscreen || noop;
  const resumeUpdateBubbleFromFullscreen = options.resumeUpdateBubbleFromFullscreen || noop;
  const repositionNoticeBubble = options.repositionNoticeBubble || noop;
  const syncNoticeBubbleVisibility = options.syncNoticeBubbleVisibility || noop;
  const suspendNoticeBubbleForPet = options.suspendNoticeBubbleForPet || noop;
  const suspendNoticeBubbleForFullscreen = options.suspendNoticeBubbleForFullscreen || noop;
  const resumeNoticeBubbleFromFullscreen = options.resumeNoticeBubbleFromFullscreen || noop;
  const repositionNoticeChart = options.repositionNoticeChart || noop;
  const syncNoticeChartVisibility = options.syncNoticeChartVisibility || noop;
  const suspendNoticeChartForPet = options.suspendNoticeChartForPet || noop;
  const suspendNoticeChartForFullscreen = options.suspendNoticeChartForFullscreen || noop;
  const resumeNoticeChartFromFullscreen = options.resumeNoticeChartFromFullscreen || noop;
  const showPermissionSurfacesForPet = options.showPermissionSurfacesForPet || null;
  const hidePermissionSurfacesForPet = options.hidePermissionSurfacesForPet || null;
  const setPermissionSurfacesFullscreenSuppressed = options.setPermissionSurfacesFullscreenSuppressed || noop;

  function repositionFloatingBubbles() {
    if (getPendingList(getPendingPermissions).length) repositionPermissionBubbles();
    repositionUpdateBubble();
    // The notice stack avoids the update bubble, so it repositions after it.
    repositionNoticeBubble();
    // The chart dodges the notice stack, so it repositions after that too.
    repositionNoticeChart();
    // Orbit reads permission, update-bubble and notice-stack bounds. Reposition
    // it last so it never avoids their previous positions.
    repositionQuotaRing();
  }

  function repositionAnchoredSurfaces() {
    repositionSessionHud();
    repositionFloatingBubbles();
  }

  function syncSessionHudVisibilityAndBubbles() {
    syncSessionHudVisibility();
    repositionFloatingBubbles();
  }

  function showFloatingSurfacesForPet() {
    if (typeof showPermissionSurfacesForPet === "function") {
      showPermissionSurfacesForPet();
    } else {
      for (const perm of getPendingList(getPendingPermissions)) {
        const bubble = perm && perm.bubble;
        if (isLiveWindow(bubble) && typeof bubble.showInactive === "function") {
          bubble.showInactive();
          keepOutOfTaskbar(bubble);
        }
      }
    }
    // pet-window-runtime invokes this before it commits petHidden=false. Pass
    // the target state explicitly so update-bubble does not read the stale
    // getter and remain hidden after the pet returns.
    syncUpdateBubbleVisibility(false);
    syncNoticeBubbleVisibility(false);
    syncNoticeChartVisibility(false);
  }

  function hideFloatingSurfacesForPet() {
    if (typeof hidePermissionSurfacesForPet === "function") {
      hidePermissionSurfacesForPet();
    } else {
      for (const perm of getPendingList(getPendingPermissions)) {
        const bubble = perm && perm.bubble;
        if (isLiveWindow(bubble) && typeof bubble.hide === "function") {
          bubble.hide();
        }
      }
    }
    suspendUpdateBubbleForPet();
    suspendNoticeBubbleForPet();
    suspendNoticeChartForPet();
  }

  function setFullscreenSuppressedForPet(suppressed) {
    const target = suppressed === true;
    setPermissionSurfacesFullscreenSuppressed(target);
    if (target) suspendUpdateBubbleForFullscreen();
    else resumeUpdateBubbleFromFullscreen();
    if (target) suspendNoticeBubbleForFullscreen();
    else resumeNoticeBubbleFromFullscreen();
    if (target) suspendNoticeChartForFullscreen();
    else resumeNoticeChartFromFullscreen();
  }

  return {
    repositionFloatingBubbles,
    repositionAnchoredSurfaces,
    syncSessionHudVisibilityAndBubbles,
    showFloatingSurfacesForPet,
    hideFloatingSurfacesForPet,
    setFullscreenSuppressedForPet,
  };
}

module.exports = createFloatingWindowRuntime;
