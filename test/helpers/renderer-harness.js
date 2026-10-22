"use strict";

// Shared renderer test harness: loads the REAL src/renderer.js (plus the small
// browser-side modules it expects to find on the page) into a vm context with a
// fake DOM, fake timers and a Proxy electronAPI. Extracted from
// test/renderer-low-power.test.js so the aim-tracking tests can drive the same
// renderer instead of growing a second copy of this.

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const RENDERER = path.join(__dirname, "..", "..", "src", "renderer.js");
const ACCESSORY_LAYOUT = path.join(__dirname, "..", "..", "src", "pet-accessory-layout.js");
const ACCESSORY_MIRROR = path.join(__dirname, "..", "..", "src", "pet-accessory-mirror.js");
const ACCESSORY_DESCRIPTOR = path.join(__dirname, "..", "..", "src", "pet-accessory-descriptor.js");
const NOTICE_SCREEN_LAYOUT = path.join(__dirname, "..", "..", "src", "notice-screen-layout.js");
const AIM_TRACKING = path.join(__dirname, "..", "..", "src", "aim-tracking.js");
const PRELOAD = path.join(__dirname, "..", "..", "src", "preload.js");
const MAIN = path.join(__dirname, "..", "..", "src", "main.js");

function readNormalized(filePath) {
  return fs.readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
}
class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.style = {
      setProperty(name, value) { this[name] = String(value); },
      removeProperty(name) { delete this[name]; },
      getPropertyValue(name) { return this[name] || ""; },
    };
    this.attributes = new Map();
    this.attributeSetCalls = [];
    this.children = [];
    this.parentNode = null;
    this.isConnected = false;
    this.className = "";
    this.id = "";
    this.data = "";
    this.src = "";
    this.contentDocument = null;
    this.contentWindow = {};
    this.listeners = new Map();
    this.offsetLeft = 0;
    this.offsetTop = 0;
    this.offsetWidth = 220;
    this._offsetHeight = 220;
    this.clientWidth = 220;
    this.clientHeight = 220;
    this.classList = {
      toggle: (name, force) => {
        const names = new Set(String(this.className).split(/\s+/).filter(Boolean));
        const enabled = force === undefined ? !names.has(name) : !!force;
        if (enabled) names.add(name);
        else names.delete(name);
        this.className = [...names].join(" ");
        return enabled;
      },
      contains: (name) => String(this.className).split(/\s+/).includes(name),
      add: (...namesToAdd) => {
        const names = new Set(String(this.className).split(/\s+/).filter(Boolean));
        namesToAdd.forEach((name) => names.add(name));
        this.className = [...names].join(" ");
      },
      remove: (...namesToRemove) => {
        const names = new Set(String(this.className).split(/\s+/).filter(Boolean));
        namesToRemove.forEach((name) => names.delete(name));
        this.className = [...names].join(" ");
      },
    };
  }

  get offsetHeight() {
    return this._offsetHeight;
  }

  set offsetHeight(value) {
    this._offsetHeight = value;
  }

  setAttribute(name, value) {
    this.attributeSetCalls.push([name, String(value)]);
    this.attributes.set(name, String(value));
    if (name === "data") this.data = String(value);
    if (name === "src") this.src = String(value);
  }

  getAttribute(name) {
    if (name === "data") return this.data || this.attributes.get(name) || "";
    if (name === "src") return this.src || this.attributes.get(name) || "";
    return this.attributes.get(name) || "";
  }

  appendChild(child) {
    child.parentNode = this;
    child.offsetParent = this;
    child.isConnected = true;
    this.children.push(child);
    return child;
  }

  // Used by renderer.js's _wrapSvgElement when it wraps a tracking target.
  insertBefore(node, reference) {
    const index = reference ? this.children.indexOf(reference) : -1;
    if (index === -1) return this.appendChild(node);
    node.parentNode = this;
    node.offsetParent = this;
    node.isConnected = true;
    this.children.splice(index, 0, node);
    return node;
  }

  remove() {
    this.isConnected = false;
    if (this.parentNode) {
      this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
      this.parentNode = null;
    }
  }

  addEventListener(event, callback) {
    this.listeners.set(event, callback);
  }

  querySelectorAll(selector = "object, img.clawd-img") {
    const descendants = [];
    const visit = (node) => {
      for (const child of node.children) {
        descendants.push(child);
        visit(child);
      }
    };
    visit(this);
    return descendants.filter((child) => {
      if (selector.includes("object.clawd-object")
          && child.tagName === "OBJECT"
          && child.classList.contains("clawd-object")) return true;
      if (selector.includes("object") && !selector.includes("object.clawd-object")
          && child.tagName === "OBJECT") return true;
      if (selector.includes("img.clawd-img")
          && child.tagName === "IMG"
          && child.classList.contains("clawd-img")) return true;
      return false;
    });
  }
}

function createRendererHarness(options = {}) {
  const timers = [];
  const audioInstances = [];
  const electronCalls = [];
  const warnings = [];
  const electronHandlers = {};
  const container = new FakeElement("div");
  container.id = "pet-container";
  container.isConnected = true;
  const facingStage = new FakeElement("div");
  facingStage.id = "pet-facing-stage";
  const motionStage = new FakeElement("div");
  motionStage.id = "pet-motion-stage";
  const assetDirectionStage = new FakeElement("div");
  assetDirectionStage.id = "pet-asset-direction-stage";
  const mediaLayer = new FakeElement("div");
  mediaLayer.id = "pet-media-layer";
  const accessoryLayer = new FakeElement("div");
  accessoryLayer.id = "pet-accessory-layer";
  const accessory = new FakeElement("img");
  accessory.id = "clawd-accessory";
  accessory.className = "clawd-accessory";
  const mouthAccessoryLayer = new FakeElement("div");
  mouthAccessoryLayer.id = "pet-mouth-accessory-layer";
  const mouthAccessory = new FakeElement("object");
  mouthAccessory.id = "clawd-mouth-accessory";
  mouthAccessory.className = "clawd-accessory";
  const effectStage = new FakeElement("div");
  effectStage.id = "pet-effect-stage";
  const particleLayer = new FakeElement("div");
  particleLayer.id = "pet-particle-layer";
  const clawd = new FakeElement("object");
  clawd.id = "clawd";
  clawd.className = "clawd-object";
  clawd.offsetLeft = -99;
  clawd.offsetTop = -55;
  clawd.clientWidth = 418;
  clawd.clientHeight = 286;
  clawd.offsetWidth = 418;
  clawd.offsetHeight = 286;
  // index.html ships the object tag without data; tests that don't care get a
  // pre-displayed file so the initial-frame swap stays out of their way.
  clawd.data = Object.prototype.hasOwnProperty.call(options, "initialObjectData")
    ? options.initialObjectData
    : "../assets/svg/current.svg";
  clawd.style.opacity = "0";
  container.appendChild(facingStage);
  facingStage.appendChild(motionStage);
  motionStage.appendChild(assetDirectionStage);
  assetDirectionStage.appendChild(mediaLayer);
  assetDirectionStage.appendChild(accessoryLayer);
  assetDirectionStage.appendChild(mouthAccessoryLayer);
  mediaLayer.appendChild(clawd);
  accessoryLayer.appendChild(accessory);
  mouthAccessoryLayer.appendChild(mouthAccessory);
  container.appendChild(effectStage);
  effectStage.appendChild(particleLayer);

  const elementsById = new Map([
    ["pet-container", container],
    ["pet-facing-stage", facingStage],
    ["pet-motion-stage", motionStage],
    ["pet-asset-direction-stage", assetDirectionStage],
    ["pet-media-layer", mediaLayer],
    ["pet-accessory-layer", accessoryLayer],
    ["pet-mouth-accessory-layer", mouthAccessoryLayer],
    ["pet-effect-stage", effectStage],
    ["pet-particle-layer", particleLayer],
    ["clawd", clawd],
    ["clawd-accessory", accessory],
    ["clawd-mouth-accessory", mouthAccessory],
  ]);
  const documentListeners = new Map();

  const document = {
    hidden: false,
    getElementById(id) {
      return elementsById.get(id) || null;
    },
    createElement(tagName) {
      return new FakeElement(tagName);
    },
    addEventListener(event, callback) {
      documentListeners.set(event, callback);
    },
  };
  const electronAPI = new Proxy({}, {
    get(_target, prop) {
      const name = String(prop);
      if (name.startsWith("on")) {
        return (callback) => { electronHandlers[name] = callback; };
      }
      return (...args) => { electronCalls.push({ name, args }); };
    },
  });
  const windowListeners = new Map();
  const context = {
    document,
    window: {
      themeConfig: {
        assetsPath: "../assets/svg",
        eyeTracking: { states: ["idle"] },
        petTintSupported: true,
        // Matches the pre-displayed file above, so tests that don't care about
        // the #509 idle choice keep resting on the "follow" sprite.
        idleFollowSvg: "current.svg",
        ...(options.themeConfig || {}),
      },
      electronAPI,
      getComputedStyle: (el) => ({ opacity: el.style.opacity || "1" }),
      addEventListener(event, callback) {
        windowListeners.set(event, callback);
      },
    },
    console: { warn: (...args) => warnings.push(args.map(String).join(" ")) },
    setTimeout(callback, ms) {
      const timer = { callback, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      if (timer) timer.cleared = true;
    },
    requestAnimationFrame(callback) {
      return context.setTimeout(callback, 16);
    },
    cancelAnimationFrame(timer) {
      context.clearTimeout(timer);
    },
    Audio: function FakeAudio(url) {
      this.url = url;
      this.volume = 1;
      this.currentTime = 0;
      this.loadCalls = 0;
      this.playCalls = 0;
      this.pauseCalls = 0;
      this.load = () => { this.loadCalls++; };
      this.play = () => { this.playCalls++; return Promise.resolve(); };
      this.pause = () => { this.pauseCalls++; };
      audioInstances.push(this);
    },
  };
  context.globalThis = context;

const source = `${readNormalized(ACCESSORY_LAYOUT)}
${readNormalized(ACCESSORY_MIRROR)}
${readNormalized(ACCESSORY_DESCRIPTOR)}
${readNormalized(NOTICE_SCREEN_LAYOUT)}
${readNormalized(AIM_TRACKING)}
${readNormalized(RENDERER)}
globalThis.__rendererTest = {
  initWithConfig,
  swapToFile,
  startDragReaction,
  endDragReaction,
  cancelReaction,
  normalizeDragDirection,
  applyDirectionalDragToObject,
  applyCodexPetVisualToObject,
  pauseCurrentSvgForLowPower,
  setLowPowerSvgPaused,
  recoverFromSystemWake,
  attachEyeTracking,
  isEyeTrackingReady,
  setLowPowerIdleMode,
  setCurrentState(value) { currentState = value; },
  setLayeredTrackingForTest(document) {
    _trackingLayers = { test: { wrappers: [], maxOffset: 1, ease: 1, x: 0, y: 0 } };
    _layeredTrackingObj = clawdEl;
    _layeredTrackingDocument = document;
  },
  getPetMediaElements,
  normalizePetTintPayload,
  applyPetTintToAllMedia,
  normalizeAccessoryPayload,
  refreshAccessoryLayout,
  get pendingNext() { return pendingNext; },
  get pendingSvgFile() { return pendingSvgFile; },
  get activeSwapToken() { return activeSwapToken; },
  get clawdEl() { return clawdEl; },
  get currentDisplayedState() { return currentDisplayedState; },
  get currentDisplayedSvg() { return currentDisplayedSvg; },
  get currentDisplayedAssetUrl() { return currentDisplayedAssetUrl; },
  get currentDragSvg() { return currentDragSvg; },
  get currentDragDirection() { return currentDragDirection; },
  get isDragReacting() { return isDragReacting; },
  get isReacting() { return isReacting; },
  get accessoryAssetLoadTimer() { return _accessorySlots.head.assetLoadTimer; },
  get accessoryAssetSettled() { return _accessorySlots.head.assetSettled; },
  get accessorySlots() { return _accessorySlots; },
  get lastAccessoryGeneration() { return _lastAccessoryGeneration; },
  get lowPowerSvgPaused() { return lowPowerSvgPaused; },
  get eyeTarget() { return eyeTarget; },
  get trackingLayers() { return _trackingLayers; },
  get aimSample() { return _aimSample; },
  get aimViewBox() { return _aimViewBox; },
  isAimMirrored: _isAimMirrored,
  get noticeScreenPose() { return noticeScreenPose; },
};`;
  vm.runInNewContext(source, context);

  return {
    context,
    container,
    facingStage,
    mediaLayer,
    accessoryLayer,
    assetDirectionStage,
    accessory,
    mouthAccessory,
    particleLayer,
    clawd,
    timers,
    audioInstances,
    electronCalls,
    warnings,
    electronHandlers,
    api: context.__rendererTest,
    activeTimers: () => timers.filter((timer) => !timer.cleared),
    documentListeners,
    windowListeners,
  };
}

module.exports = {
  FakeElement,
  createRendererHarness,
  readNormalized,
  RENDERER,
  ACCESSORY_LAYOUT,
  ACCESSORY_MIRROR,
  ACCESSORY_DESCRIPTOR,
  NOTICE_SCREEN_LAYOUT,
  AIM_TRACKING,
  PRELOAD,
  MAIN,
};
