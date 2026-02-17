/**
 * compat.js — Cross-Browser Extension API Compatibility Layer
 * ============================================================
 * Provides a unified API that works across:
 *   - Chrome MV3 (service worker, chrome.* namespace)
 *   - Firefox MV2 (persistent background page, browser.* namespace)
 *   - Firefox MV3 (background script, browser.* namespace)
 *
 * Usage:
 *   importScripts("lib/compat.js");       // service worker (Chrome MV3)
 *   <script src="lib/compat.js">          // background page (Firefox MV2)
 *   Then use compat.api, compat.action, etc.
 *
 * Detection matrix:
 *   ┌─────────────────┬───────────┬──────────┬─────────────┐
 *   │ Feature         │ Chrome MV3│ FF MV2   │ FF MV3      │
 *   ├─────────────────┼───────────┼──────────┼─────────────┤
 *   │ browser.*       │ ✗         │ ✓        │ ✓           │
 *   │ chrome.*        │ ✓         │ ✓ (cb)   │ ✓ (promise) │
 *   │ action API      │ chrome.   │ browser  │ chrome/     │
 *   │                 │ action    │ Action   │ browser.    │
 *   │ importScripts   │ ✓ (SW)   │ ✗ (page) │ ✗           │
 *   │ filterResponse  │ ✗        │ ✓        │ ✓           │
 *   │ offscreen API   │ ✓        │ ✗        │ ✗           │
 *   │ DNR             │ ✓        │ partial  │ ✓           │
 *   │ webReq blocking │ ✗        │ ✓        │ ✗           │
 *   └─────────────────┴───────────┴──────────┴─────────────┘
 */
(function (root) {
  "use strict";

  // ─── Namespace Detection ─────────────────────────────────────────
  // Firefox defines `browser` (Promise-based). Chrome only defines `chrome`.
  // Firefox also defines `chrome` but `browser` is the preferred namespace.
  const api =
    typeof browser !== "undefined" && browser.runtime ? browser : chrome;

  // ─── Feature Detection ───────────────────────────────────────────

  const manifest = api.runtime.getManifest();
  const manifestVersion = manifest.manifest_version || 2;

  const compat = {
    /** @type {typeof chrome} Unified extension API namespace */
    api: api,

    /** Manifest version (2 or 3) */
    manifestVersion: manifestVersion,

    /** True if MV3 */
    isMV3: manifestVersion === 3,

    /** True if MV2 */
    isMV2: manifestVersion === 2,

    /** True if running in a ServiceWorkerGlobalScope (Chrome MV3) */
    isServiceWorker:
      typeof ServiceWorkerGlobalScope !== "undefined" &&
      self instanceof ServiceWorkerGlobalScope,

    /** True if Firefox (has browser.runtime.getBrowserInfo) */
    isFirefox:
      typeof browser !== "undefined" &&
      !!browser.runtime &&
      typeof browser.runtime.getBrowserInfo === "function",

    /** True if Chrome */
    isChrome:
      typeof browser === "undefined" ||
      !browser.runtime ||
      typeof browser.runtime.getBrowserInfo !== "function",

    // ─── API Aliases ───────────────────────────────────────────────

    /** MV3: chrome.action, MV2: chrome.browserAction / browser.browserAction */
    action: api.action || api.browserAction || null,

    /** Storage API (same across all platforms) */
    storage: api.storage,

    /** Runtime API */
    runtime: api.runtime,

    /** Tabs API */
    tabs: api.tabs,

    /** Notifications API */
    notifications: api.notifications || null,

    // ─── Capability Flags ──────────────────────────────────────────

    /** firefox webRequest.filterResponseData() — Firefox only */
    hasFilterResponseData:
      typeof browser !== "undefined" &&
      !!browser.webRequest &&
      typeof browser.webRequest.filterResponseData === "function",

    /** webRequest with blocking (MV2, or Firefox MV3 with permission) */
    hasWebRequestBlocking: !!(
      api.webRequest &&
      api.webRequest.onBeforeRequest &&
      Array.isArray(manifest.permissions) &&
      manifest.permissions.includes("webRequestBlocking")
    ),
    /** declarativeNetRequest (Chrome MV3, Firefox 113+) */
    hasDNR: !!(
      api.declarativeNetRequest && api.declarativeNetRequest.updateDynamicRules
    ),

    /** Offscreen documents (Chrome MV3 only) */
    hasOffscreen: !!(api.offscreen && api.offscreen.createDocument),

    /** chrome.scripting API (MV3) */
    hasScripting: !!(api.scripting && api.scripting.executeScript),

    // ─── Cross-Version Helper Methods ──────────────────────────────

    /**
     * Set badge text + color on a tab. Works with both action (MV3)
     * and browserAction (MV2).
     */
    setBadge(tabId, text, color) {
      const act = compat.action;
      if (!act) return;
      try {
        act.setBadgeText({ text: text || "", tabId });
        if (color) act.setBadgeBackgroundColor({ color, tabId });
      } catch (e) {
        // Tab may have been closed
      }
    },

    /**
     * Execute a script in a tab. Abstracts MV2 vs MV3 differences.
     * @param {number} tabId
     * @param {object} opts - { func, files, args, world, allFrames }
     * @returns {Promise}
     */
    async executeScript(tabId, opts) {
      if (compat.hasScripting) {
        // MV3: chrome.scripting.executeScript
        const config = {
          target: { tabId, allFrames: opts.allFrames || false },
        };
        if (opts.func) {
          config.func = opts.func;
          if (opts.args) config.args = opts.args;
        }
        if (opts.files) config.files = opts.files;
        if (opts.world) config.world = opts.world;
        return api.scripting.executeScript(config);
      } else {
        // MV2: chrome.tabs.executeScript / browser.tabs.executeScript
        const config = {
          allFrames: opts.allFrames || false,
          runAt: opts.runAt || "document_idle",
        };
        if (opts.files && opts.files.length > 0) {
          // MV2 limitation: executeScript only accepts one file at a time
          if (opts.files.length > 1) {
            console.warn(
              "[compat] MV2 executeScript: only first file will be injected",
            );
          }
          config.file = opts.files[0];
        }
        if (opts.func) {
          config.code = `(${opts.func.toString()})()`;
        }
        return api.tabs.executeScript(tabId, config);
      }
    },

    /**
     * Send a message and handle both callback (old Chrome MV2) and
     * Promise (Firefox, Chrome MV3) patterns.
     * @param {*} message
     * @returns {Promise}
     */
    sendMessage(message) {
      return api.runtime.sendMessage(message);
    },

    /**
     * Send a message to a specific tab.
     * @param {number} tabId
     * @param {*} message
     * @returns {Promise}
     */
    sendTabMessage(tabId, message) {
      return api.tabs.sendMessage(tabId, message);
    },

    /**
     * Get the extension's internal URL for a resource.
     * @param {string} path
     * @returns {string}
     */
    getURL(path) {
      return api.runtime.getURL(path);
    },

    /**
     * Log with environment tag for debugging.
     */
    log(...args) {
      const env = compat.isFirefox
        ? `[FF-MV${compat.manifestVersion}]`
        : `[CR-MV${compat.manifestVersion}]`;
      console.log(env, ...args);
    },
  };

  // ─── Export to global scope ──────────────────────────────────────
  // Works in: service worker (self), background page (window), Node (global)
  if (typeof globalThis !== "undefined") globalThis.compat = compat;
  else if (typeof self !== "undefined") self.compat = compat;
  else if (typeof window !== "undefined") window.compat = compat;
  else root.compat = compat;
})(this);
