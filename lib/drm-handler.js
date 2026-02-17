/**
 * drm-handler.js — DRM Orchestration Module (Cross-Browser)
 * ==========================================================
 * Complete DRM bypass pipeline that works on:
 *   - Chrome MV3 (service worker, importScripts)
 *   - Firefox MV2 (background page, <script> tag)
 *   - Firefox MV3 (background script)
 *
 * Pipeline:
 *   ┌─────────────────────────────────────────────────────────────────┐
 *   │ Page (MAIN world)                                               │
 *   │  eme-interceptor.js hooks EME APIs:                             │
 *   │   requestMediaKeySystemAccess → keySystem detected              │
 *   │   generateRequest             → PSSH captured                   │
 *   │   session "message"           → challenge intercepted           │
 *   │   session.update              → license response captured       │
 *   │   keystatuseschange           → key IDs + statuses              │
 *   └──────────────┬──────────────────────────────────────────────────┘
 *                  │ CustomEvent bridge (__wm → __wr)
 *   ┌──────────────▼──────────────────────────────────────────────────┐
 *   │ Content Script (ISOLATED world)                                  │
 *   │  bridge.js relays via api.runtime.sendMessage                   │
 *   └──────────────┬──────────────────────────────────────────────────┘
 *                  │ chrome.runtime.onMessage / browser.runtime.onMessage
 *   ┌──────────────▼──────────────────────────────────────────────────┐
 *   │ Background (this module)                                         │
 *   │  DRMHandler processes EME events:                                │
 *   │   1. Store keySystem, PSSH, license URL per tab                 │
 *   │   2. Challenge swap via Remote CDM (WP2 technique)              │
 *   │   3. Parse license → extract keys                               │
 *   │   4. Auto-extract when PSSH + license URL captured              │
 *   │   5. Cache keys for download+decrypt                            │
 *   │                                                                  │
 *   │  Firefox extras (when available):                                │
 *   │   - webRequest.filterResponseData for license interception      │
 *   │   - webRequestBlocking for header modification                  │
 *   └─────────────────────────────────────────────────────────────────┘
 *
 * Dependencies (loaded before this script):
 *   - lib/compat.js        (compat.api, compat.isFirefox, etc.)
 *   - lib/remote-cdm.js    (RemoteCDM.Client, RemoteCDM.CDRMClient)
 *   - lib/widevine-proto.js (WidevinePssh, WidevineProto)
 */
(function () {
  "use strict";

  // ─── API Access ──────────────────────────────────────────────────
  // Use compat layer if available (loaded via importScripts/script tag),
  // otherwise detect directly.
  const api =
    typeof compat !== "undefined"
      ? compat.api
      : typeof browser !== "undefined" && browser.runtime
        ? browser
        : chrome;

  const actionAPI =
    typeof compat !== "undefined"
      ? compat.action
      : api.action || api.browserAction;

  const isFirefox =
    typeof compat !== "undefined"
      ? compat.isFirefox
      : typeof browser !== "undefined" &&
        typeof browser.runtime?.getBrowserInfo === "function";

  // ─── State ───────────────────────────────────────────────────────

  /**
   * Per-tab DRM state.
   * @type {Map<number, DRMTabState>}
   */
  const drmTabState = new Map();

  /**
   * @typedef {Object} DRMTabState
   * @property {string|null} keySystem - e.g. "com.widevine.alpha"
   * @property {string|null} drmName - e.g. "Widevine"
   * @property {string|null} pssh - Base64-encoded PSSH box
   * @property {string|null} psshHex - Hex-encoded PSSH
   * @property {Array<{kid:string, key:string}>} keys - Extracted keys
   * @property {string|null} licenseUrl - Detected license server URL
   * @property {string|null} sessionId - Active CDM session ID
   * @property {string|null} serverCertificate - Base64 DRM server cert
   * @property {Array<{kid:string, key:string}>} clearKeys - ClearKey pairs
   * @property {Object|null} mediaMetadata - Duration, resolution, bitrate
   * @property {Array<{url:string, type:string}>} manifests - Detected manifests
   * @property {string} status - idle | detecting | keys-found
   * @property {boolean} _autoExtractInProgress
   */

  /**
   * Global key cache: KID (hex, lowercase, no dashes) → key (hex)
   * @type {Map<string, string>}
   */
  const keyCache = new Map();

  /**
   * Persistent CDM client instances: "tabId:sessionId" → RemoteCDM.Client
   * Keyed by composite key to support multiple MediaKeySessions per tab
   * (e.g. separate audio + video tracks or quality switches).
   * @type {Map<string, Object>}
   */
  const cdmClients = new Map();

  /** Build composite key for cdmClients */
  function cdmKey(tabId, sessionId) {
    return `${tabId}:${sessionId || "default"}`;
  }

  /**
   * Per-tab lock for serializing challenge swap operations.
   * When audio + video MediaKeySessions fire "message" events
   * concurrently, both call handleChallengeIntercepted before
   * either CDM is stored.  Serialising prevents race conditions
   * where handleLicenseResponse picks up the wrong CDM.
   * @type {Map<number, Promise>}
   */
  const challengeLocks = new Map();

  /**
   * Per-tab AbortController for DRM extraction operations.
   * Aborted when tab is closed or navigated away, preventing orphaned
   * CDM HTTP calls from continuing after the tab context is gone.
   * @type {Map<number, AbortController>}
   */
  const tabAbortControllers = new Map();

  /** Get or create an AbortController for a tab */
  function getTabAbortController(tabId) {
    if (!tabAbortControllers.has(tabId)) {
      tabAbortControllers.set(tabId, new AbortController());
    }
    return tabAbortControllers.get(tabId);
  }

  /** Abort and remove the controller for a tab */
  function abortTabOperations(tabId) {
    const ctrl = tabAbortControllers.get(tabId);
    if (ctrl) {
      ctrl.abort();
      tabAbortControllers.delete(tabId);
    }
  }

  /** Check if a tab's DRM operations have been aborted */
  function isTabAborted(tabId) {
    const ctrl = tabAbortControllers.get(tabId);
    return ctrl ? ctrl.signal.aborted : false;
  }

  /** Get all CDM clients for a given tab (for cleanup) */
  function getCdmClientsForTab(tabId) {
    const prefix = `${tabId}:`;
    const results = [];
    for (const [key, cdm] of cdmClients) {
      if (key.startsWith(prefix)) results.push({ key, cdm });
    }
    return results;
  }

  // ─── Default Settings ────────────────────────────────────────────

  const DEFAULT_DRM_SETTINGS = {
    remoteCdmUrl: "",
    remoteCdmDevice: "default",
    cdrmUrl: "",
    autoExtractKeys: true,
  };

  // ─── Tab DRM State ──────────────────────────────────────────────

  function getDrmState(tabId) {
    if (!drmTabState.has(tabId)) {
      drmTabState.set(tabId, {
        keySystem: null,
        drmName: null,
        pssh: null,
        psshHex: null,
        keys: [],
        licenseUrl: null,
        sessionId: null,
        serverCertificate: null,
        clearKeys: [],
        mediaMetadata: null,
        manifests: [],
        status: "idle",
        _autoExtractInProgress: false,
      });
    }
    return drmTabState.get(tabId);
  }

  // ─── Initialization ──────────────────────────────────────────────

  let _initialized = false;

  async function initDRM() {
    // Idempotency guard — safe to call multiple times
    if (_initialized) {
      console.log("[DRM-Handler] Already initialized, skipping");
      return;
    }
    _initialized = true;
    console.log("[DRM-Handler] Initializing...");

    // ── Register our message listener FIRST (synchronous) ──────────
    // Must be registered before any async work so that DRM messages
    // arriving during storage init are not silently dropped.
    api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      const result = handleDrmMessage(msg, sender);
      if (result === undefined) return false; // Not a DRM message
      if (result instanceof Promise) {
        result
          .then((val) => {
            try {
              sendResponse(val);
            } catch (e) {
              /* port closed */
            }
          })
          .catch((err) => {
            try {
              sendResponse({ error: err.message });
            } catch (e) {
              /* port closed */
            }
          });
        return true; // Keep message channel open for async response (MV2)
      }
      // Synchronous result
      try {
        sendResponse(result);
      } catch (e) {
        /* port closed */
      }
      return false;
    });

    // Seed default settings on first install
    try {
      const stored = await api.storage.local.get(
        Object.keys(DEFAULT_DRM_SETTINGS),
      );
      const toSet = {};
      for (const [key, val] of Object.entries(DEFAULT_DRM_SETTINGS)) {
        if (stored[key] === undefined || stored[key] === null) {
          toSet[key] = val;
        }
      }
      if (Object.keys(toSet).length > 0) {
        await api.storage.local.set(toSet);
        console.log(
          "[DRM-Handler] Applied defaults:",
          Object.keys(toSet).join(", "),
        );
      }
    } catch (e) {
      console.error("[DRM-Handler] Settings init error:", e);
    }

    // Load cached keys from storage
    try {
      const stored = await api.storage.local.get("extractedKeys");
      if (stored.extractedKeys) {
        for (const [kid, key] of Object.entries(stored.extractedKeys)) {
          keyCache.set(kid.toLowerCase(), key.toLowerCase());
        }
        console.log(`[DRM-Handler] Loaded ${keyCache.size} cached keys`);
      }
    } catch (e) {
      console.error("[DRM-Handler] Error loading key cache:", e);
    }

    // ── Tab lifecycle cleanup ──────────────────────────────────────
    api.tabs.onRemoved.addListener((tabId) => {
      // Abort any in-flight DRM extraction operations first
      abortTabOperations(tabId);
      drmTabState.delete(tabId);
      for (const { key, cdm } of getCdmClientsForTab(tabId)) {
        cdm.close().catch(() => {});
        cdmClients.delete(key);
      }
    });

    api.tabs.onUpdated.addListener((tabId, changeInfo) => {
      if (changeInfo.status === "loading") {
        // Abort any in-flight DRM extraction operations
        abortTabOperations(tabId);
        drmTabState.delete(tabId);
        for (const { key, cdm } of getCdmClientsForTab(tabId)) {
          cdm.close().catch(() => {});
          cdmClients.delete(key);
        }
      }
    });

    // ── Firefox-only: license interception via webRequest ──────────
    // Firefox's filterResponseData() lets us read/modify HTTP response
    // bodies at the network level. This catches licenses served to
    // the page's own CDM even if session.update() isn't hooked.
    if (
      typeof compat !== "undefined"
        ? compat.hasFilterResponseData
        : typeof browser !== "undefined" &&
          browser.webRequest &&
          typeof browser.webRequest.filterResponseData === "function"
    ) {
      startFirefoxLicenseInterception();
    }

    console.log("[DRM-Handler] Initialization complete");
  }

  // ─── Message Router ──────────────────────────────────────────────

  /**
   * Handle DRM-related messages. Returns undefined for non-DRM messages
   * so the Detector's existing handler can process them.
   *
   * @param {Object} msg
   * @param {Object} sender
   * @returns {Promise|undefined}
   */
  function handleDrmMessage(msg, sender) {
    if (!msg || !msg.type) return undefined;

    const tabId = sender?.tab?.id ?? msg.tabId;

    switch (msg.type) {
      // ── From eme-interceptor.js (via bridge.js) ──────────────────
      case "EME_KEY_SYSTEM_DETECTED":
        return handleKeySystemDetected(tabId, msg);

      case "EME_PSSH_CAPTURED":
        return handlePsshCaptured(tabId, msg);

      case "EME_CHALLENGE_INTERCEPTED":
        return handleChallengeIntercepted(tabId, msg);

      case "EME_LICENSE_RESPONSE":
        return handleLicenseResponse(tabId, msg);

      case "EME_KEY_STATUS":
        return handleKeyStatus(tabId, msg);

      case "EME_CLEARKEY_FOUND":
        return handleClearKeyFound(tabId, msg);

      case "EME_SERVER_CERTIFICATE":
        return handleServerCertificate(tabId, msg);

      case "MEDIA_METADATA":
        return handleMediaMetadata(tabId, msg);

      case "MANIFEST_DETECTED":
        return handleManifestDetected(tabId, msg);

      case "STREAM_URL_DETECTED":
        return handleStreamUrlDetected(tabId, msg);

      case "EME_LICENSE_URL_DETECTED":
        return handleLicenseUrlDetected(tabId, msg);

      case "EME_BRIDGE_TIMEOUT":
        // The eme-interceptor's sendToBackground timed out — likely Trusted Types
        // blocking CustomEvent dispatch or extension context invalidation.
        // Log and update badge to warn user that DRM extraction may have failed.
        console.warn(
          `[DRM] EME bridge timeout on tab ${tabId}, session: ${msg.sessionId}, reason: ${msg.reason}`,
        );
        if (tabId && tabId >= 0) {
          try {
            chrome.action.setBadgeText({ text: "⚠", tabId });
            chrome.action.setBadgeBackgroundColor({ color: "#FF9800", tabId });
          } catch {}
        }
        return Promise.resolve({ acknowledged: true });

      // ── From popup UI ────────────────────────────────────────────
      case "GET_DRM_STATE":
        return Promise.resolve(getSerializableDrmState(tabId));

      case "GET_ALL_KEYS":
        return Promise.resolve(getAllKeys());

      case "COPY_KEYS":
        return handleCopyKeys(msg);

      case "EXTRACT_KEYS_MANUAL":
        return handleManualKeyExtraction(msg);

      case "CLEAR_KEYS":
        keyCache.clear();
        return api.storage.local.remove("extractedKeys").then(() => ({
          ok: true,
        }));

      case "GET_DRM_SETTINGS":
        return api.storage.local.get(Object.keys(DEFAULT_DRM_SETTINGS));

      case "SAVE_DRM_SETTINGS":
        return api.storage.local.set(msg.settings).then(() => ({ ok: true }));

      default:
        return undefined; // Not a DRM message
    }
  }

  // ─── EME Event Handlers ──────────────────────────────────────────

  function handleKeySystemDetected(tabId, msg) {
    if (!tabId && tabId !== 0) return Promise.resolve({ ok: true });
    const state = getDrmState(tabId);
    state.keySystem = msg.keySystem;
    state.drmName = msg.drmName || msg.keySystem;
    state.status = "detecting";

    // Update badge
    updateDrmBadge(tabId, state);

    // Notify popup
    broadcastToPopup({
      type: "DRM_DETECTED",
      tabId,
      keySystem: msg.keySystem,
      drmName: state.drmName,
    });

    console.log(
      `[DRM-Handler] Key system detected: ${state.drmName} (tab ${tabId})`,
    );
    return Promise.resolve({ ok: true });
  }

  function handlePsshCaptured(tabId, msg) {
    if (!tabId && tabId !== 0) return Promise.resolve({ ok: true });
    const state = getDrmState(tabId);
    state.pssh = msg.pssh; // base64
    state.psshHex = msg.psshHex || null;

    console.log(
      `[DRM-Handler] PSSH captured (tab ${tabId}): ${(msg.pssh || "").substring(0, 40)}...`,
    );

    broadcastToPopup({ type: "PSSH_CAPTURED", tabId, pssh: msg.pssh });

    // Auto-extraction trigger
    tryAutoExtractKeys(tabId);

    return Promise.resolve({ ok: true });
  }

  async function handleChallengeIntercepted(tabId, msg) {
    if (!tabId && tabId !== 0) return { action: "passthrough" };

    // Serialize per-tab: wait for any prior challenge swap to finish
    // before starting a new one (handles concurrent audio+video sessions)
    const prevLock = challengeLocks.get(tabId) || Promise.resolve();
    let releaseLock;
    const lockPromise = new Promise((resolve) => {
      releaseLock = resolve;
    });
    challengeLocks.set(tabId, lockPromise);

    try {
      await prevLock;
      return await _handleChallengeInterceptedInner(tabId, msg);
    } finally {
      releaseLock();
      // Clean up lock entry when no more pending
      if (challengeLocks.get(tabId) === lockPromise) {
        challengeLocks.delete(tabId);
      }
    }
  }

  async function _handleChallengeInterceptedInner(tabId, msg) {
    const state = getDrmState(tabId);

    // Challenge swap via Remote CDM (WidevineProxy2 technique):
    // 1. Use captured PSSH to generate our own challenge
    // 2. Return it for eme-interceptor to swap into the license request
    // 3. When the license response arrives, it's for OUR CDM device
    // 4. We can then parse it to extract content keys

    // Declare outside try so it's accessible in catch for cleanup
    let cdm;

    try {
      // Tab may have been closed before we got the lock
      if (isTabAborted(tabId)) {
        return { action: "passthrough" };
      }

      const config = await api.storage.local.get([
        "remoteCdmUrl",
        "remoteCdmDevice",
      ]);

      if (!config.remoteCdmUrl || !state.pssh) {
        // No CDM configured or no PSSH yet — let original through
        return { action: "passthrough" };
      }

      // Check if RemoteCDM is available
      if (typeof RemoteCDM === "undefined" || !RemoteCDM.Client) {
        console.warn("[DRM-Handler] RemoteCDM not loaded");
        return { action: "passthrough" };
      }

      cdm = new RemoteCDM.Client({
        host: config.remoteCdmUrl,
        device_name: config.remoteCdmDevice || "default",
      });

      // Check if tab was closed while we awaited cdm.open()
      if (isTabAborted(tabId)) {
        cdm.close().catch(() => {});
        return { action: "passthrough" };
      }

      //
      // Open CDM session
      await cdm.open();
      state.sessionId = cdm.sessionId;

      // Generate our challenge using the captured PSSH
      const challenge = await cdm.getChallenge(state.pssh);

      // Persist CDM client AFTER getChallenge succeeds (prevents leak on throw)
      // Use composite key to support multiple sessions per tab (audio + video tracks)
      cdmClients.set(cdmKey(tabId, cdm.sessionId), cdm);

      console.log("[DRM-Handler] Generated CDM challenge, swapping...");
      return {
        action: "swap",
        challenge: challenge, // base64
        sessionId: cdm.sessionId,
      };
    } catch (error) {
      console.error("[DRM-Handler] Challenge swap failed:", error);
      // Close the CDM if it was created but not yet stored in the map
      // (e.g. getChallenge() threw after open() succeeded)

      // If tab was closed/navigated, clean up any remaining CDM clients and bail
      if (isTabAborted(tabId) || !drmTabState.has(tabId)) {
        const emeSessionId = msg.sessionId || null;
        const key = cdmKey(tabId, emeSessionId);
        const cdm = cdmClients.get(key);
        if (cdm) {
          cdm.close().catch(() => {});
          cdmClients.delete(key);
        }
        return { ok: true };
      }

      if (cdm) {
        cdm.close().catch(() => {});
        cdmClients.delete(cdmKey(tabId, cdm.sessionId));
      }
      state.sessionId = null;
      return { action: "passthrough", error: error.message };
    }
  }

  async function handleLicenseResponse(tabId, msg) {
    if (!tabId && tabId !== 0) return { ok: true };
    const state = getDrmState(tabId);

    // Capture the license URL if provided
    if (msg.licenseUrl) {
      state.licenseUrl = msg.licenseUrl;
    }

    // Build composite key using the EME sessionId from the interceptor
    const emeSessionId = msg.sessionId || null;
    const key = cdmKey(tabId, emeSessionId);

    try {
      // Retrieve the persistent CDM client created during challenge swap
      // First try exact key, then fall back to any client for this tab
      let cdm = cdmClients.get(key);
      if (!cdm) {
        // Fallback: try to find any CDM client for this tab (backwards compat)
        const tabClients = getCdmClientsForTab(tabId);
        if (tabClients.length === 1) {
          cdm = tabClients[0].cdm;
        }
      }
      if (!cdm || !cdm.sessionId) {
        // We didn't swap the challenge — try auto-extraction instead
        tryAutoExtractKeys(tabId);
        return { ok: true };
      }

      // Parse the license response using the SAME CDM client
      // Handle JSON-wrapped licenses: some players pass raw JSON to session.update()
      // where the actual license bytes are inside a field like "license", "payload", etc.
      let licenseB64 = msg.response;
      try {
        const decoded = atob(licenseB64);
        // Check if the decoded data looks like JSON (starts with '{')
        if (decoded.length > 0 && decoded.charCodeAt(0) === 0x7b) {
          const json = JSON.parse(decoded);
          // Common JSON wrapper fields for Widevine licenses
          const candidateFields = [
            "license",
            "payload",
            "data",
            "response",
            "lic",
            "widevine_license",
            "license_data",
          ];
          for (const field of candidateFields) {
            if (json[field] && typeof json[field] === "string") {
              console.log(
                `[DRM-Handler] Unwrapped JSON license from field: ${field}`,
              );
              licenseB64 = json[field];
              break;
            }
          }
        }
      } catch {
        // Not JSON — use the original base64 as-is (protobuf)
      }

      await cdm.parseLicense(licenseB64);

      // Extract keys
      const keys = await cdm.getKeys();
      await cdm.close();
      cdmClients.delete(key);
      state.sessionId = null;

      if (keys && keys.length > 0) {
        storeKeys(keys, tabId);
        console.log(
          `[DRM-Handler] Keys extracted via challenge swap: ${keys.length} keys`,
        );
      }

      return { ok: true, keysFound: keys ? keys.length : 0 };
    } catch (error) {
      console.error("[DRM-Handler] License parsing failed:", error);
      // Clean up CDM client on error
      const cdm = cdmClients.get(key);
      if (cdm) {
        cdm.close().catch(() => {});
        cdmClients.delete(key);
      }
      state.sessionId = null;
      return { ok: false, error: error.message };
    }
  }

  function handleKeyStatus(tabId, msg) {
    if (!tabId && tabId !== 0) return Promise.resolve({ ok: true });
    const state = getDrmState(tabId);

    console.log("[DRM-Handler] Key status update:", msg.keyStatuses);
    broadcastToPopup({
      type: "KEY_STATUS",
      tabId,
      statuses: msg.keyStatuses,
    });
    return Promise.resolve({ ok: true });
  }

  // ─── ClearKey / Server Certificate / Media Metadata ──────────────

  function handleClearKeyFound(tabId, msg) {
    if (!tabId && tabId !== 0) return Promise.resolve({ ok: true });
    const state = getDrmState(tabId);

    console.log("[DRM-Handler] ClearKey detected (tab " + tabId + ")");

    if (msg.keys && msg.keys.length > 0) {
      state.clearKeys = msg.keys;
      state.keySystem = state.keySystem || "org.w3.clearkey";
      state.drmName = "ClearKey";

      // ClearKey pairs are plaintext — store directly
      const standardKeys = msg.keys.map((k) => ({
        kid: k.kid || k.keyId || "",
        key: k.key || k.keyValue || "",
      }));
      storeKeys(standardKeys, tabId);
    }

    broadcastToPopup({ type: "CLEARKEY_FOUND", tabId, keys: msg.keys });
    return Promise.resolve({ ok: true });
  }

  function handleServerCertificate(tabId, msg) {
    if (!tabId && tabId !== 0) return Promise.resolve({ ok: true });
    const state = getDrmState(tabId);
    state.serverCertificate = msg.certificate; // base64

    console.log(
      `[DRM-Handler] Server certificate captured (tab ${tabId}), length: ${msg.certificate ? msg.certificate.length : 0}`,
    );
    broadcastToPopup({
      type: "SERVER_CERTIFICATE",
      tabId,
      certificateLength: msg.certificate ? msg.certificate.length : 0,
    });
    return Promise.resolve({ ok: true });
  }

  function handleMediaMetadata(tabId, msg) {
    if (!tabId && tabId !== 0) return Promise.resolve({ ok: true });
    const state = getDrmState(tabId);

    // Player detection data
    if (msg.detectedPlayers) {
      state.mediaMetadata = state.mediaMetadata || {};
      state.mediaMetadata.detectedPlayers = msg.detectedPlayers;
      broadcastToPopup({
        type: "MEDIA_METADATA",
        tabId,
        metadata: state.mediaMetadata,
      });
      return Promise.resolve({ ok: true });
    }

    state.mediaMetadata = {
      ...(state.mediaMetadata || {}),
      duration: msg.duration || 0,
      width: msg.width || msg.videoWidth || 0,
      height: msg.height || msg.videoHeight || 0,
      bitrate: msg.bitrate || 0,
      videoCodec: msg.videoCodec || "",
      audioCodec: msg.audioCodec || "",
      timestamp: Date.now(),
    };

    broadcastToPopup({
      type: "MEDIA_METADATA",
      tabId,
      metadata: state.mediaMetadata,
    });
    return Promise.resolve({ ok: true });
  }

  // ─── Manifest & Stream Handlers ──────────────────────────────────

  function handleManifestDetected(tabId, msg) {
    if (!tabId && tabId !== 0) return Promise.resolve({ ok: true });
    const state = getDrmState(tabId);

    // Deduplicate
    const exists = state.manifests.some((m) => m.url === msg.url);
    if (!exists) {
      state.manifests.push({
        url: msg.url,
        type: msg.manifestType || "unknown",
        content: msg.content || null,
        timestamp: Date.now(),
      });
      broadcastToPopup({
        type: "MANIFEST_FOUND",
        tabId,
        url: msg.url,
        manifestType: msg.manifestType,
      });
    }
    return Promise.resolve({ ok: true });
  }

  function handleLicenseUrlDetected(tabId, msg) {
    if (!tabId && tabId !== 0) return Promise.resolve({ ok: true });
    const state = getDrmState(tabId);

    if (msg.licenseUrl && !state.licenseUrl) {
      state.licenseUrl = msg.licenseUrl;
      console.log(
        `[DRM-Handler] License URL captured (tab ${tabId}): ${msg.licenseUrl.substring(0, 80)}...`,
      );

      broadcastToPopup({
        type: "DRM_DETECTED",
        tabId,
        licenseUrl: msg.licenseUrl,
      });

      // Trigger auto-extraction now that we have the license URL
      tryAutoExtractKeys(tabId);
    }

    return Promise.resolve({ ok: true });
  }

  function handleStreamUrlDetected(tabId, msg) {
    if (!tabId && tabId !== 0) return Promise.resolve({ ok: true });
    const state = getDrmState(tabId);

    // Reuse manifests array for streams (same concept)
    const exists = state.manifests.some((s) => s.url === msg.url);
    if (!exists) {
      state.manifests.push({
        url: msg.url,
        type: msg.streamType || "stream",
        quality: msg.quality || "",
        contentType: msg.contentType || "",
        timestamp: Date.now(),
      });
      broadcastToPopup({
        type: "STREAM_FOUND",
        tabId,
        url: msg.url,
        streamType: msg.streamType,
      });
    }
    return Promise.resolve({ ok: true });
  }

  // ─── Auto Key Extraction ─────────────────────────────────────────
  //
  // Triggered whenever PSSH or license URL is captured. If both exist
  // and keys haven't been extracted yet, attempt automatic extraction.

  async function tryAutoExtractKeys(tabId) {
    const state = getDrmState(tabId);

    // Need both PSSH and license URL
    if (!state.pssh || !state.licenseUrl) return;
    // Already have keys
    if (state.keys && state.keys.length > 0) return;
    // Already in progress
    if (state._autoExtractInProgress) return;
    // Tab already closed/navigated — don't start
    if (isTabAborted(tabId)) return;
    // Set flag BEFORE any await to prevent race condition
    state._autoExtractInProgress = true;

    // Check if auto-extraction is enabled
    try {
      const settings = await api.storage.local.get("autoExtractKeys");
      if (settings.autoExtractKeys === false) {
        state._autoExtractInProgress = false;
        return;
      }
    } catch (e) {
      // Default to enabled
    }

    // Re-check after await: tab may have closed while we waited
    if (isTabAborted(tabId) || !drmTabState.has(tabId)) {
      console.log(`[DRM-Handler] Tab ${tabId} gone — aborting auto-extraction`);
      return;
    }

    console.log(`[DRM-Handler] Auto-extracting keys (tab ${tabId})...`);

    try {
      const result = await handleManualKeyExtraction({
        pssh: state.pssh,
        licenseUrl: state.licenseUrl,
        tabId: tabId,
      });

      if (result.ok && result.keys && result.keys.length > 0) {
        console.log(
          `[DRM-Handler] Auto-extraction: ${result.keys.length} keys (tab ${tabId})`,
        );

        // Send notification
        if (api.notifications) {
          try {
            api.notifications
              .create("drm-keys-" + tabId, {
                type: "basic",
                title: "Keys Extracted!",
                message: `${result.keys.length} DRM key(s) extracted automatically.`,
                iconUrl: api.runtime.getURL("icons/icon-128.png"),
              })
              .catch(() => {});
          } catch (e) {
            // Notification permission may not be granted
          }
        }
      } else {
        console.log(
          "[DRM-Handler] Auto-extraction failed:",
          result.error || "no keys",
        );
      }
    } catch (e) {
      console.error("[DRM-Handler] Auto-extraction error:", e);
    } finally {
      state._autoExtractInProgress = false;
    }
  }

  // ─── Manual Key Extraction ───────────────────────────────────────
  //
  // Called from popup UI or auto-extraction. Uses Remote CDM to:
  //   1. Open a CDM session
  //   2. Generate a challenge from PSSH
  //   3. Send challenge to the site's license server
  //   4. Parse the license response
  //   5. Extract content keys

  async function handleManualKeyExtraction(msg) {
    try {
      if (!msg.pssh) {
        return {
          ok: false,
          error: "No PSSH available. Wait for it to be captured.",
        };
      }
      if (!msg.licenseUrl) {
        return {
          ok: false,
          error:
            "No license URL detected. Play content first so the license request can be captured.",
        };
      }

      const config = await api.storage.local.get([
        "remoteCdmUrl",
        "remoteCdmDevice",
        "cdrmUrl",
      ]);

      // Check if RemoteCDM is available
      if (typeof RemoteCDM === "undefined") {
        return {
          ok: false,
          error:
            "RemoteCDM library not loaded. Check that lib/remote-cdm.js is imported.",
        };
      }

      if (config.cdrmUrl) {
        // CDRM-Project API (one-shot extraction)
        if (!RemoteCDM.CDRMClient) {
          return { ok: false, error: "CDRMClient not available in RemoteCDM" };
        }
        const cdrm = new RemoteCDM.CDRMClient(config.cdrmUrl);
        const keys = await cdrm.extractKeys(
          msg.pssh,
          msg.licenseUrl,
          msg.headers || {},
        );
        storeKeys(keys, msg.tabId);
        return { ok: true, keys };
      }

      if (config.remoteCdmUrl) {
        // pywidevine Remote CDM (full pipeline)
        if (!RemoteCDM.Client) {
          return { ok: false, error: "RemoteCDM.Client not available" };
        }
        const cdm = new RemoteCDM.Client({
          host: config.remoteCdmUrl,
          device_name: config.remoteCdmDevice || "default",
        });
        const keys = await cdm.extractKeys(
          msg.pssh,
          msg.licenseUrl,
          msg.headers || {},
        );
        storeKeys(keys, msg.tabId);
        return { ok: true, keys };
      }

      return {
        ok: false,
        error: "No CDM configured. Set Remote CDM URL in DRM settings.",
      };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  // ─── Key Management ──────────────────────────────────────────────

  function storeKeys(keys, tabId) {
    if (!keys || keys.length === 0) return;

    for (const key of keys) {
      const kid = (key.kid || key.key_id || "").replace(/-/g, "").toLowerCase();
      const keyHex = (key.key || key.content_key || "").toLowerCase();
      if (kid && keyHex) {
        keyCache.set(kid, keyHex);
      }
    }

    // Update tab DRM state — only if the tab still exists (not closed/navigated)
    if (tabId || tabId === 0) {
      if (!drmTabState.has(tabId)) {
        // Tab state was already deleted (tab closed or navigated).
        // Still persist to global keyCache above, but don't create zombie state.
        console.log(
          `[DRM-Handler] Tab ${tabId} gone — storing ${keys.length} keys to cache only`,
        );
      } else {
        const state = getDrmState(tabId);
        state.keys = keys;
        state.status = "keys-found";
        updateDrmBadge(tabId, state);
      }
    }

    // Persist to storage
    const keysObj = {};
    for (const [kid, key] of keyCache) {
      keysObj[kid] = key;
    }
    api.storage.local.set({ extractedKeys: keysObj }).catch(() => {});

    console.log(
      `[DRM-Handler] Stored ${keys.length} keys, total cached: ${keyCache.size}`,
    );
    broadcastToPopup({
      type: "KEYS_UPDATED",
      tabId,
      keys,
      totalCached: keyCache.size,
    });
  }

  function getAllKeys() {
    const keys = [];
    for (const [kid, key] of keyCache) {
      keys.push({ kid, key });
    }
    return keys;
  }

  function handleCopyKeys(msg) {
    const format = msg.format || "kid:key";
    // Use tab-specific keys if tabId provided, else all cached keys
    let keys;
    if (msg.tabId || msg.tabId === 0) {
      const state = drmTabState.get(msg.tabId);
      if (state && state.keys && state.keys.length > 0) {
        keys = state.keys.map((k) => ({
          kid: (k.kid || k.key_id || "").replace(/-/g, "").toLowerCase(),
          key: (k.key || k.content_key || "").toLowerCase(),
        }));
      } else {
        keys = getAllKeys(); // Fallback to global cache
      }
    } else {
      keys = getAllKeys();
    }

    let text;
    if (format === "kid:key") {
      text = keys.map((k) => `${k.kid}:${k.key}`).join("\n");
    } else if (format === "mp4decrypt") {
      text = keys.map((k) => `--key ${k.kid}:${k.key}`).join(" ");
    } else if (format === "json") {
      text = JSON.stringify(keys, null, 2);
    } else {
      text = keys.map((k) => `${k.kid}:${k.key}`).join("\n");
    }

    return Promise.resolve({ text, count: keys.length });
  }

  // ─── Badge Management ────────────────────────────────────────────

  function updateDrmBadge(tabId, state) {
    if (!actionAPI || tabId == null) return;

    try {
      if (state.keys && state.keys.length > 0) {
        actionAPI.setBadgeText({ text: "🔑", tabId });
        actionAPI.setBadgeBackgroundColor({ color: "#4CAF50", tabId });
      } else if (state.keySystem) {
        actionAPI.setBadgeText({ text: "DRM", tabId });
        actionAPI.setBadgeBackgroundColor({ color: "#FF9800", tabId });
      }
    } catch (e) {
      // Tab may have been closed
    }
  }

  // ─── Popup Communication ─────────────────────────────────────────

  function broadcastToPopup(message) {
    try {
      api.runtime.sendMessage(message).catch(() => {
        // Popup not open — ignore
      });
    } catch (e) {
      // Extension context invalidated
    }
  }

  // ─── Serializable State (for popup) ──────────────────────────────

  function getSerializableDrmState(tabId) {
    if (!tabId && tabId !== 0) return null;
    const state = getDrmState(tabId);
    // Return a plain object (Maps/Sets aren't serializable)
    return {
      keySystem: state.keySystem,
      drmName: state.drmName,
      pssh: state.pssh,
      psshHex: state.psshHex,
      keys: state.keys,
      licenseUrl: state.licenseUrl,
      serverCertificate: state.serverCertificate ? true : false, // Don't send raw cert
      clearKeys: state.clearKeys,
      mediaMetadata: state.mediaMetadata,
      manifests: state.manifests,
      status: state.status,
    };
  }

  // ─── Firefox-Only: Network-Level License Interception ────────────
  //
  // Uses browser.webRequest.filterResponseData() to capture license
  // server responses at the network level. This catches licenses even
  // if session.update() isn't successfully hooked (e.g., obfuscated
  // player code that bypasses our Proxy).
  //
  // Only runs on Firefox — Chrome MV3 has no equivalent API.

  const LICENSE_URL_PATTERNS = [
    /\/license/i,
    /\/widevine/i,
    /\/playready/i,
    /\/fairplay/i,
    /\/clearkey/i,
    /\/drm\//i,
    /\/proxy\?provider=/i,
    /modular.*drm/i,
    /cwip-shaka-proxy/i,
    /license\.vdocipher\.com/i,
    /keydelivery\.mediaservices\.windows\.net/i,
    /license\.pallycon\.com/i,
    /license\.drmtoday\.com/i,
    /wv\.service\.expressplay\.com/i,
    /license\.uplynk\.com/i,
    /axinom\.com.*drm/i,
    /buydrm\.com/i,
    /ezdrm\.com/i,
    /irdeto\.com.*license/i,
  ];

  function isLicenseUrl(url) {
    if (!url) return false;
    return LICENSE_URL_PATTERNS.some((p) => p.test(url));
  }

  function startFirefoxLicenseInterception() {
    if (
      typeof browser === "undefined" ||
      !browser.webRequest ||
      !browser.webRequest.filterResponseData
    ) {
      return;
    }

    console.log("[DRM-Handler] Firefox license interception active");

    browser.webRequest.onBeforeRequest.addListener(
      (details) => {
        if (!isLicenseUrl(details.url)) return {};

        const tabId = details.tabId;
        if (tabId < 0) return {};

        console.log(
          `[DRM-Handler] License request detected: ${details.url} (tab ${tabId})`,
        );

        // Store the license URL
        const state = getDrmState(tabId);
        state.licenseUrl = details.url;

        // Capture the response body using filterResponseData
        try {
          const filter = browser.webRequest.filterResponseData(
            details.requestId,
          );
          const chunks = [];

          filter.ondata = (event) => {
            chunks.push(new Uint8Array(event.data));
            filter.write(event.data); // Pass through unmodified
          };

          filter.onstop = () => {
            filter.close();

            // Combine chunks
            const totalLen = chunks.reduce((s, c) => s + c.length, 0);
            const combined = new Uint8Array(totalLen);
            let offset = 0;
            for (const chunk of chunks) {
              combined.set(chunk, offset);
              offset += chunk.length;
            }

            // Store raw license response for potential key extraction
            const base64 = uint8ToBase64(combined);
            console.log(
              `[DRM-Handler] License response captured: ${combined.length} bytes (tab ${tabId})`,
            );

            // Try to extract keys from the license response
            tryExtractFromLicense(tabId, base64);
          };

          filter.onerror = () => {
            // Filter error — response passes through unmodified
          };
        } catch (e) {
          // filterResponseData may fail for some request types
        }

        return {}; // Don't block the request
      },
      { urls: ["<all_urls>"], types: ["xmlhttprequest"] },
      ["blocking"],
    );
  }

  /**
   * Attempt to extract keys from a captured license response.
   * This is the Firefox-only bonus path — works even without
   * challenge swap, by using the pywidevine API's parse_license.
   */
  async function tryExtractFromLicense(tabId, licenseBase64) {
    const state = getDrmState(tabId);
    if (state.keys && state.keys.length > 0) return; // Already have keys

    try {
      const config = await api.storage.local.get([
        "remoteCdmUrl",
        "remoteCdmDevice",
      ]);
      if (!config.remoteCdmUrl || !state.pssh) return;

      if (typeof RemoteCDM === "undefined" || !RemoteCDM.Client) return;

      // Create a new CDM session, generate challenge, then feed the
      // captured license response to extract keys
      const cdm = new RemoteCDM.Client({
        host: config.remoteCdmUrl,
        device_name: config.remoteCdmDevice || "default",
      });

      try {
        await cdm.open();
        await cdm.getChallenge(state.pssh);
        await cdm.parseLicense(licenseBase64);
        const keys = await cdm.getKeys();

        if (keys && keys.length > 0) {
          storeKeys(keys, tabId);
          console.log(
            `[DRM-Handler] Firefox interception: extracted ${keys.length} keys`,
          );
        }
      } finally {
        // Always close CDM session to prevent server-side leaks
        cdm.close().catch(() => {});
      }
    } catch (e) {
      // License may not be for our CDM device — expected failure
    }
  }

  // ─── Utility ─────────────────────────────────────────────────────

  function uint8ToBase64(uint8) {
    let binary = "";
    for (let i = 0; i < uint8.length; i++) {
      binary += String.fromCharCode(uint8[i]);
    }
    return btoa(binary);
  }

  // ─── Export to Global Scope ──────────────────────────────────────

  const DRMHandler = {
    init: initDRM,
    handleMessage: handleDrmMessage,
    getDrmState: getSerializableDrmState,
    getAllKeys,
    getKeyCache: () => keyCache,
    isLicenseUrl,
  };

  // Works in service worker (self), background page (window), etc.
  if (typeof globalThis !== "undefined") globalThis.DRMHandler = DRMHandler;
  else if (typeof self !== "undefined") self.DRMHandler = DRMHandler;
  else if (typeof window !== "undefined") window.DRMHandler = DRMHandler;
})();
