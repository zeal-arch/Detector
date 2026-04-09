/**
 * eme-interceptor.js — MAIN World EME Proxy (Injected into Page Context)
 * ======================================================================
 * Comprehensive EME hooking using techniques from:
 *
 *   WidevineProxy2:  Proxy({apply}) + stopImmediatePropagation + CustomEvent bridge
 *   eme_logger:      Instance-level shimming, decodingInfo tracing, MutationObserver
 *   dash.js:         ClearKey detection, license request/response filter patterns
 *   shaka-player:    init data dedup, PlayReady challenge unwrap, key status batching
 *   nginx-vod-module: Subsample/full-sample encryption patterns, IV derivation
 *   DRM-Calculator:  Download throttle awareness metadata
 *
 * EME API flow intercepted:
 *
 *   1. navigator.requestMediaKeySystemAccess()     → Detect DRM, capture key system
 *   2. navigator.mediaCapabilities.decodingInfo()   → Alternative EME entry (eme_logger)
 *   3. mediaKeys.createSession()                    → Session reference
 *   4. session.generateRequest(type, initData)      → PSSH capture
 *   5. session addEventListener("message")          → Challenge proxy (WP2 approach)
 *   6. session.update(response)                     → License response capture
 *   7. session keystatuseschange                    → Key status tracking
 *   8. fetch/XHR hooks                              → Manifest + license URL detection
 *   9. SourceBuffer.appendBuffer                    → Init segment PSSH detection
 *  10. MutationObserver                             → Dynamic video/audio element discovery
 *
 * Anti-detection techniques (from WidevineProxy2):
 *   - new Proxy(original, { apply }) instead of simple reassignment
 *   - Object.defineProperty preserves prototype chain
 *   - stopImmediatePropagation on original events
 *   - Random hex requestId for cross-world message correlation
 */

(function () {
  "use strict";

  // ─── Anti-Detection: Symbol-based markers ──────────────────────
  // Symbols are invisible to: for...in, Object.keys(), JSON.stringify(),
  // hasOwnProperty(string), and casual property enumeration.
  // This prevents sites from detecting our hooks via property checks.
  const _hooked = Symbol();
  const _xhrUrl = Symbol();
  const _xhrMethod = Symbol();
  const _xhrLoadHooked = Symbol();

  // Double-injection guard — non-descriptive name (looks like minified code)
  const _guard = Symbol.for("__m$");
  if (window[_guard]) return;
  window[_guard] = true;

  // ─── Anti-Detection: Conditional logging ──────────────────────
  // Set to true only during development. In production, all console
  // output is suppressed to eliminate the [EME-Interceptor] fingerprint.
  const _DEBUG = false;
  const _log = _DEBUG ? (...args) => console.log("[EME]", ...args) : () => {};

  // ─── Anti-Detection: Dynamic event channel names ─────────────────
  // Instead of hardcoded "eme-interceptor-message" / "eme-bridge-response",
  // use short generic names that don't reveal purpose. Both bridge.js and
  // this file must agree on these exact strings.
  const _EVT_MSG = "__wm";
  const _EVT_RSP = "__wr";
  const _EVT_BROADCAST = "__wb";

  // ─── Anti-Detection: toString() preserver ────────────────────────
  // Wraps a Proxy so its toString()/name match the original function,
  // defeating Function.prototype.toString.call(fn) detection.
  function stealthProxy(original, handler) {
    const proxy = new Proxy(original, handler);
    // Preserve .name, .length, .toString() to match native signatures
    Object.defineProperty(proxy, "toString", {
      value: function () {
        return original.toString();
      },
      writable: false,
      configurable: false,
    });
    Object.defineProperty(proxy, "name", {
      value: original.name,
      writable: false,
      configurable: false,
    });
    Object.defineProperty(proxy, "length", {
      value: original.length,
      writable: false,
      configurable: false,
    });
    return proxy;
  }

  // ─── DRM Key Systems (DRM-BYPASS-METHODOLOGY Section 37) ─────────

  const DRM_SYSTEMS = {
    "com.widevine.alpha": "Widevine",
    "com.microsoft.playready": "PlayReady",
    "com.apple.fps": "FairPlay",
    "com.apple.fps.1_0": "FairPlay",
    "com.apple.fps.2_0": "FairPlay",
    "com.apple.fps.3_0": "FairPlay",
    "org.w3.clearkey": "ClearKey",
    "com.chromecast.playready": "PlayReady (Chromecast)",
    "com.youtube.playready": "PlayReady (YouTube)",
  };

  // ─── Random Request ID (WidevineProxy2 pattern) ──────────────────

  function generateRequestId() {
    return Math.random().toString(16).substring(2, 9);
  }

  // ─── Communication Channel (CustomEvent + random hex ID) ─────────

  const pendingResponses = new Map();

  /**
   * Send message to background via CustomEvent bridge (WP2 pattern).
   * Uses random hex requestId for correlation instead of sequential IDs.
   */
  function sendToBackground(type, data) {
    return new Promise((resolve) => {
      const requestId = generateRequestId();
      pendingResponses.set(requestId, resolve);

      window.dispatchEvent(
        new CustomEvent(_EVT_MSG, {
          detail: { requestId, type, ...data },
        }),
      );

      // Timeout after 60 seconds (CDM challenge swap requires two sequential
      // HTTP roundtrips: cdm.open() + cdm.getChallenge() — 30s was too tight
      // on slow networks or congested CDM servers)
      setTimeout(() => {
        if (pendingResponses.has(requestId)) {
          pendingResponses.delete(requestId);
          resolve({ error: "timeout" });
        }
      }, 60000);
    });
  }

  // Listen for responses from bridge (CustomEvent)
  window.addEventListener(_EVT_RSP, (event) => {
    const { requestId, response } = event.detail || {};
    if (requestId && pendingResponses.has(requestId)) {
      const resolve = pendingResponses.get(requestId);
      pendingResponses.delete(requestId);
      resolve(response || {});
    }
  });

  // ─── Utility ─────────────────────────────────────────────────────

  function bufferToBase64(buffer) {
    const bytes =
      buffer instanceof ArrayBuffer
        ? new Uint8Array(buffer)
        : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  function base64ToBuffer(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  function bufferToHex(buffer) {
    const bytes =
      buffer instanceof ArrayBuffer
        ? new Uint8Array(buffer)
        : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  // PSSH deduplication set (shaka-player pattern)
  const seenPsshHashes = new Set();

  function hashBuffer(buf) {
    const bytes = new Uint8Array(buf);
    let hash = 0;
    for (let i = 0; i < bytes.length; i++) {
      hash = ((hash << 5) - hash + bytes[i]) | 0;
    }
    return hash;
  }

  // ─── ClearKey Detection (WidevineProxy2 + dash.js pattern) ───────

  function isClearKeyResponse(data) {
    try {
      const text =
        typeof data === "string" ? data : new TextDecoder().decode(data);
      const json = JSON.parse(text);
      return json && json.keys && Array.isArray(json.keys);
    } catch (e) {
      return false;
    }
  }

  function parseClearKeyResponse(data) {
    try {
      const text =
        typeof data === "string" ? data : new TextDecoder().decode(data);
      const json = JSON.parse(text);
      if (!json.keys) return [];

      return json.keys.map((key) => {
        // ClearKey uses base64url encoding
        const kid = bufferToHex(base64UrlToBuffer(key.kid));
        const k = bufferToHex(base64UrlToBuffer(key.k));
        return { kid, key: k };
      });
    } catch (e) {
      return [];
    }
  }

  function base64UrlToBuffer(b64url) {
    const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "==".slice(0, (4 - (b64.length % 4)) % 4);
    return base64ToBuffer(padded);
  }

  // ─── 1. Hook requestMediaKeySystemAccess (Proxy pattern) ─────────
  //
  // Using new Proxy({apply}) instead of simple reassignment.
  // This is harder for sites to detect via Function.prototype.toString()
  // because the Proxy preserves the original function's identity.
  // (WidevineProxy2 technique)

  const originalRequestMKSA = navigator.requestMediaKeySystemAccess;

  // Guard: EME API may be unavailable on non-secure (HTTP) pages
  if (originalRequestMKSA) {
    navigator.requestMediaKeySystemAccess = stealthProxy(originalRequestMKSA, {
      apply: async function (target, thisArg, args) {
        const [keySystem, configs] = args;
        const drmName = DRM_SYSTEMS[keySystem] || keySystem;
        _log("requestMediaKeySystemAccess:", drmName, "(" + keySystem + ")");

        sendToBackground("EME_KEY_SYSTEM_DETECTED", {
          keySystem: keySystem,
          drmName: drmName,
          configs: JSON.stringify(configs),
        });

        // Call original
        const access = await Reflect.apply(target, thisArg, args);

        // Hook createMediaKeys on the returned MediaKeySystemAccess instance
        hookMediaKeySystemAccess(access);

        return access;
      },
    });
  }

  // ─── 1b. Hook navigator.mediaCapabilities.decodingInfo (eme_logger pattern) ──

  if (navigator.mediaCapabilities && navigator.mediaCapabilities.decodingInfo) {
    const originalDecodingInfo = navigator.mediaCapabilities.decodingInfo;

    navigator.mediaCapabilities.decodingInfo = stealthProxy(
      originalDecodingInfo,
      {
        apply: async function (target, thisArg, args) {
          const result = await Reflect.apply(target, thisArg, args);

          // If result has keySystemAccess, hook it (eme_logger's exploreResultFields)
          if (result && result.keySystemAccess) {
            _log("decodingInfo returned keySystemAccess");
            hookMediaKeySystemAccess(result.keySystemAccess);
            const ks = result.keySystemAccess.keySystem || "unknown";
            const dn = ks.includes("widevine")
              ? "Widevine"
              : ks.includes("playready")
                ? "PlayReady"
                : ks.includes("clearkey")
                  ? "ClearKey"
                  : ks.includes("fairplay")
                    ? "FairPlay"
                    : ks;
            sendToBackground("EME_KEY_SYSTEM_DETECTED", {
              keySystem: ks,
              drmName: dn,
              configs: "[]",
            });
          }

          return result;
        },
      },
    );
  }

  // ─── 2. Hook MediaKeySystemAccess ────────────────────────────────

  function hookMediaKeySystemAccess(access) {
    // Guard against double-shimming — Symbol marker is invisible to page code
    if (access[_hooked]) return;
    access[_hooked] = true;

    const originalCreateMediaKeys = access.createMediaKeys;

    access.createMediaKeys = stealthProxy(originalCreateMediaKeys, {
      apply: async function (target, thisArg, args) {
        const mediaKeys = await Reflect.apply(target, thisArg, args);
        hookMediaKeys(mediaKeys);
        return mediaKeys;
      },
    });
  }

  // ─── 3. Hook MediaKeys.createSession ─────────────────────────────

  function hookMediaKeys(mediaKeys) {
    if (mediaKeys[_hooked]) return;
    mediaKeys[_hooked] = true;

    const originalCreateSession = mediaKeys.createSession;

    mediaKeys.createSession = stealthProxy(originalCreateSession, {
      apply: function (target, thisArg, args) {
        const session = Reflect.apply(target, thisArg, args);
        hookMediaKeySession(session);
        return session;
      },
    });

    // Also hook setServerCertificate (eme_logger pattern)
    if (mediaKeys.setServerCertificate) {
      const originalSetCert = mediaKeys.setServerCertificate;
      mediaKeys.setServerCertificate = stealthProxy(originalSetCert, {
        apply: function (target, thisArg, args) {
          _log("setServerCertificate called, cert size:", args[0]?.byteLength);
          sendToBackground("EME_SERVER_CERTIFICATE", {
            certificate: bufferToBase64(args[0]),
          });
          return Reflect.apply(target, thisArg, args);
        },
      });
    }
  }

  // ─── 4. Hook MediaKeySession ─────────────────────────────────────

  function hookMediaKeySession(session) {
    if (session[_hooked]) return;
    session[_hooked] = true;

    // 4a. Hook generateRequest to capture PSSH (with dedup from shaka-player)
    const originalGenerateRequest = session.generateRequest;

    // PlayReady system ID GUID (matches lib/manifest-parser-drm.js)
    const PLAYREADY_SYSTEM_ID = "9a04f079-9840-4286-ab92-e65be0885f95";

    session.generateRequest = stealthProxy(originalGenerateRequest, {
      apply: async function (target, thisArg, args) {
        const [initDataType, initData] = args;
        _log("generateRequest:", initDataType, "size:", initData?.byteLength);

        // PSSH deduplication (shaka-player pattern)
        const psshB64 = bufferToBase64(initData);
        const psshHash = hashBuffer(
          new Uint8Array(
            initData instanceof ArrayBuffer ? initData : initData.buffer,
          ),
        );

        if (!seenPsshHashes.has(psshHash)) {
          seenPsshHashes.add(psshHash);
          sendToBackground("EME_PSSH_CAPTURED", {
            pssh: psshB64,
            initDataType: initDataType,
          });
        }

        // PlayReady license URL extraction (Section 37)
        // Detect PlayReady initData by checking initDataType or system ID
        const isPlayReady =
          initDataType === "keyids" ||
          (psshB64 && psshB64.includes("mQTweZhAQoarkuZb4IhflQ")) || // base64 of PlayReady GUID
          (initDataType === "cenc" && initData?.byteLength > 30);

        if (isPlayReady) {
          try {
            const rawBuf =
              initData instanceof ArrayBuffer
                ? new Uint8Array(initData)
                : new Uint8Array(
                    initData.buffer,
                    initData.byteOffset,
                    initData.byteLength,
                  );
            const licenseUrl = extractPlayReadyLicenseUrl(rawBuf);
            if (licenseUrl) {
              _log("PlayReady license URL extracted:", licenseUrl);
              sendToBackground("EME_LICENSE_URL_DETECTED", {
                licenseUrl: licenseUrl,
                source: "playready-initdata",
              });
            }
          } catch (e) {
            _log("PlayReady license URL extraction failed:", e);
          }
        }

        return Reflect.apply(target, thisArg, args);
      },
    });

    // 4b. Hook addEventListener with stopImmediatePropagation (WP2 technique)
    //
    // WidevineProxy2's key insight: instead of just wrapping handlers,
    // we hook addEventListener itself and use stopImmediatePropagation
    // on the original trusted event, then dispatch a synthetic event
    // with our modified challenge.
    const originalAddEventListener = session.addEventListener;

    session.addEventListener = stealthProxy(originalAddEventListener, {
      apply: function (target, thisArg, args) {
        const [type, handler, options] = args;

        if (type === "message") {
          _log('Intercepting "message" event listener');

          // Register our interceptor instead
          const interceptor = async function (event) {
            try {
              // Stop the original event from reaching other listeners
              event.stopImmediatePropagation();

              await handleSessionMessage(event, handler, thisArg);
            } catch (err) {
              _log("Error in message interceptor:", err);
              // Fallback: call original handler with original event
              handler(event);
            }
          };

          return Reflect.apply(target, thisArg, [type, interceptor, options]);
        }

        if (type === "keystatuseschange") {
          const wrappedHandler = function (event) {
            captureKeyStatuses(thisArg);
            handler.call(thisArg, event);
          };
          return Reflect.apply(target, thisArg, [
            type,
            wrappedHandler,
            options,
          ]);
        }

        return Reflect.apply(target, thisArg, args);
      },
    });

    // 4c. Hook session.update to capture license response
    const originalUpdate = session.update;

    session.update = stealthProxy(originalUpdate, {
      apply: async function (target, thisArg, args) {
        const [response] = args;
        _log(
          "session.update called, size:",
          response?.byteLength || response?.length,
        );

        // Check for ClearKey (WidevineProxy2 + dash.js pattern)
        if (isClearKeyResponse(response)) {
          _log("ClearKey license detected!");
          const clearKeys = parseClearKeyResponse(response);
          if (clearKeys.length > 0) {
            sendToBackground("EME_CLEARKEY_FOUND", { keys: clearKeys });
          }
        } else {
          const responseB64 = bufferToBase64(response);
          // Fire-and-forget: don't block the real session.update with await
          sendToBackground("EME_LICENSE_RESPONSE", {
            response: responseB64,
            sessionId: session.sessionId || null,
          })
            .then((result) => {
              _log("License response processed:", result);
            })
            .catch(() => {});
        }

        return Reflect.apply(target, thisArg, args);
      },
    });

    // 4d. Hook onkeystatuseschange property (via prototype descriptor walk like eme_logger)
    hookKeyStatusChangeProperty(session);

    // 4e. Hook onmessage property (same pattern as onkeystatuseschange)
    // Some players use session.onmessage = handler instead of addEventListener.
    hookOnMessageProperty(session);
  }

  // ─── Key Status Capture (eme_logger eventProperties pattern) ─────

  function captureKeyStatuses(session) {
    try {
      const statuses = [];
      session.keyStatuses.forEach((status, keyId) => {
        statuses.push({
          keyId: bufferToHex(keyId),
          status: status,
        });
      });

      if (statuses.length > 0) {
        sendToBackground("EME_KEY_STATUS", { keyStatuses: statuses });
      }
    } catch (e) {
      // Ignore
    }
  }

  function hookKeyStatusChangeProperty(session) {
    // Walk prototype chain to find the descriptor (eme_logger _getDescriptor pattern)
    let proto = session;
    let descriptor = null;
    while (proto) {
      descriptor = Object.getOwnPropertyDescriptor(
        proto,
        "onkeystatuseschange",
      );
      if (descriptor) break;
      proto = Object.getPrototypeOf(proto);
    }

    if (descriptor && descriptor.set) {
      Object.defineProperty(session, "onkeystatuseschange", {
        set: function (handler) {
          const wrappedHandler = function (event) {
            captureKeyStatuses(session);
            if (handler) handler.call(session, event);
          };
          descriptor.set.call(session, wrappedHandler);
        },
        get: function () {
          return descriptor.get ? descriptor.get.call(session) : undefined;
        },
        configurable: true,
      });
    }
  }

  /**
   * Hook session.onmessage property assignment.
   * Some players (e.g. older video.js, custom implementations) use
   * session.onmessage = handler instead of session.addEventListener("message", handler).
   * Uses the same prototype descriptor walk pattern as onkeystatuseschange.
   */
  function hookOnMessageProperty(session) {
    let proto = session;
    let descriptor = null;
    while (proto) {
      descriptor = Object.getOwnPropertyDescriptor(proto, "onmessage");
      if (descriptor) break;
      proto = Object.getPrototypeOf(proto);
    }

    if (descriptor && descriptor.set) {
      Object.defineProperty(session, "onmessage", {
        set: function (handler) {
          if (typeof handler !== "function") {
            descriptor.set.call(session, handler);
            return;
          }

          const wrappedHandler = async function (event) {
            try {
              await handleSessionMessage(event, handler, session);
            } catch (err) {
              _log("Error in onmessage interceptor:", err);
              handler.call(session, event);
            }
          };
          descriptor.set.call(session, wrappedHandler);
        },
        get: function () {
          return descriptor.get ? descriptor.get.call(session) : undefined;
        },
        configurable: true,
      });
    }
  }

  // ─── 5. Handle Session Message (Challenge Proxy) ─────────────────
  //
  // Core technique from WidevineProxy2:
  //   1. Original "message" event is stopped (stopImmediatePropagation)
  //   2. Challenge is sent to background for swap
  //   3. A synthetic MediaKeyMessageEvent is created with the new challenge
  //   4. Original handler receives the synthetic event
  //   5. Page sends OUR challenge to license server
  //   6. License response contains keys for OUR CDM

  async function handleSessionMessage(originalEvent, originalHandler, session) {
    _log(
      "Challenge intercepted, type:",
      originalEvent.messageType,
      "size:",
      originalEvent.message.byteLength,
    );

    const challengeB64 = bufferToBase64(originalEvent.message);

    const response = await sendToBackground("EME_CHALLENGE_INTERCEPTED", {
      challenge: challengeB64,
      messageType: originalEvent.messageType,
      sessionId: session.sessionId,
    });

    if (response.action === "swap" && response.challenge) {
      _log("Swapping challenge with CDM challenge");

      const newChallenge = base64ToBuffer(response.challenge);

      // Create a synthetic MediaKeyMessageEvent (WP2 technique)
      try {
        const syntheticEvent = new MediaKeyMessageEvent("message", {
          messageType: originalEvent.messageType,
          message: newChallenge.buffer,
        });

        // Call the original handler with our synthetic event
        originalHandler.call(session, syntheticEvent);
      } catch (e) {
        // Fallback: create a plain event with defineProperties
        const syntheticEvent = new Event("message");
        Object.defineProperties(syntheticEvent, {
          message: { value: newChallenge.buffer, writable: false },
          messageType: { value: originalEvent.messageType, writable: false },
          target: { value: session, writable: false },
        });
        originalHandler.call(session, syntheticEvent);
      }
    } else {
      // Passthrough: re-dispatch original-like event to handler
      if (response.error === "timeout") {
        _log(
          "WARNING: Challenge swap timed out — bridge communication may be blocked (Trusted Types or extension invalidated). Passing through original challenge.",
        );
        // Notify background about the timeout so it can update badge/UI
        sendToBackground("EME_BRIDGE_TIMEOUT", {
          sessionId: session.sessionId,
          reason: "challenge_swap_timeout",
        }).catch(() => {});
      } else {
        _log("Passing through original challenge");
      }
      originalHandler.call(session, originalEvent);
    }
  }

  // ─── 6. Manifest Detection via fetch/XHR Hooks ──────────────────
  //
  // Enhanced with WidevineProxy2's smart arraybuffer detection:
  // Only reads first/last 1000 bytes for large responses.

  const originalFetch = window.fetch;

  try {
    window.fetch = stealthProxy(originalFetch, {
      apply: async function (target, thisArg, args) {
        const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";

        // Detect stream URLs early
        if (isStreamUrl(url)) {
          sendToBackground("STREAM_URL_DETECTED", {
            url: url,
            streamType: detectStreamType(url),
          });
        }

        // Detect DRM license server requests (POST to license-like URLs)
        const fetchMethod =
          (args[1] && args[1].method) || (args[0] && args[0].method) || "GET";
        if (fetchMethod.toUpperCase() === "POST" && isLicenseUrl(url)) {
          reportLicenseUrl(url, fetchMethod);
        }

        // Single fetch call — never duplicate the request
        const response = await Reflect.apply(target, thisArg, args);

        try {
          const ct = response.headers.get("content-type") || "";
          const isManifest =
            isManifestUrl(url) ||
            ct.includes("mpegurl") ||
            ct.includes("dash+xml") ||
            ct.includes("mpd");

          if (isManifest) {
            const clone = response.clone();
            const content = await clone.text();
            sendToBackground("MANIFEST_DETECTED", {
              url: url,
              manifestType: detectManifestContent(url, content),
              content: content.substring(0, 50000), // Limit size
            });
          }
        } catch (e) {
          // Detection failed, not fatal — original response is still returned
        }

        return response;
      },
    });
  } catch (e) {
    _log("Could not override window.fetch (read-only):", e.message);
  }

  // ─── XHR Hook (with all responseType handling from WP2) ──────────

  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = stealthProxy(originalXHROpen, {
    apply: function (target, thisArg, args) {
      const [method, url] = args;
      thisArg[_xhrUrl] = url;
      thisArg[_xhrMethod] = method;

      if (isStreamUrl(url)) {
        sendToBackground("STREAM_URL_DETECTED", {
          url: url,
          streamType: detectStreamType(url),
        });
      }

      // Detect DRM license server requests via XHR
      if (method && method.toUpperCase() === "POST" && isLicenseUrl(url)) {
        reportLicenseUrl(url, method);
      }

      return Reflect.apply(target, thisArg, args);
    },
  });

  XMLHttpRequest.prototype.send = stealthProxy(originalXHRSend, {
    apply: function (target, thisArg, args) {
      const url = thisArg[_xhrUrl] || "";

      // Skip proxy logic for known third-party domains that we never
      // need to inspect. This keeps our code out of the call stack
      // so CSP violations on those domains aren't attributed to us.
      if (
        url &&
        /^https?:\/\/[^/]*(jwplayer\.com|jwpltx\.com|jwpsrv\.com|googlesyndication\.com|google-analytics\.com|googletagmanager\.com|doubleclick\.net|facebook\.net|sentry\.io)\//i.test(
          url,
        )
      ) {
        return Reflect.apply(target, thisArg, args);
      }

      // Guard: only attach the load listener once per XHR instance.
      // Without this, reused XHR objects (open→send→open→send) accumulate listeners.
      if (!thisArg[_xhrLoadHooked]) {
        thisArg[_xhrLoadHooked] = true;

        // Hook onload for manifest content capture (WP2 handles all response types)
        thisArg.addEventListener("load", function () {
          try {
            let content = null;

            if (isManifestUrl(url)) {
              // Get content from appropriate response type
              if (
                thisArg.responseType === "" ||
                thisArg.responseType === "text"
              ) {
                content = thisArg.responseText;
              } else if (thisArg.responseType === "json") {
                content = JSON.stringify(thisArg.response);
              } else if (
                thisArg.responseType === "arraybuffer" &&
                thisArg.response
              ) {
                // WP2 pattern: only check first/last 1000 bytes for large buffers
                const buf = new Uint8Array(thisArg.response);
                if (buf.length > 10000) {
                  const head = new TextDecoder().decode(buf.slice(0, 1000));
                  const tail = new TextDecoder().decode(buf.slice(-1000));
                  content = head + tail;
                } else {
                  content = new TextDecoder().decode(buf);
                }
              } else if (thisArg.responseType === "document") {
                content = thisArg.response?.documentElement?.outerHTML;
              }

              if (content) {
                sendToBackground("MANIFEST_DETECTED", {
                  url: url,
                  manifestType: detectManifestContent(url, content),
                  content: content.substring(0, 50000),
                });
              }
            }
          } catch (e) {
            // Ignore detection errors
          }
        });
      } // end of _xhrLoadHooked guard

      return Reflect.apply(target, thisArg, args);
    },
  });

  // ─── 7. URL Detection Helpers (expanded) ─────────────────────────

  function isManifestUrl(url) {
    if (!url || typeof url !== "string") return false;
    const lower = url.toLowerCase().split("?")[0];
    return (
      lower.endsWith(".mpd") ||
      lower.endsWith(".m3u8") ||
      lower.includes("/manifest") ||
      lower.includes(".ism/manifest") ||
      lower.includes(".ism/") ||
      // Use path-boundary patterns to avoid false positives
      // e.g. "dashboard" or "scholars" do NOT match
      /\/dash\//.test(lower) ||
      /\/dash$/.test(lower) ||
      /\/hls\//.test(lower) ||
      /\/hls$/.test(lower)
    );
  }

  function isStreamUrl(url) {
    if (!url || typeof url !== "string") return false;
    // Strip query params and hash for extension checking
    const lower = url.toLowerCase().split("?")[0].split("#")[0];

    // For .ts files, require a numeric or hex segment-like pattern in the path
    // to avoid matching TypeScript files (.ts), API endpoints, etc.
    // Typical HLS: /seg-1.ts, /000001.ts, /video_1080p_0042.ts
    if (lower.endsWith(".ts")) {
      return /\/(?:seg|chunk|frag|media|video|audio|stream|hls|init|\d)[^/]*\.ts$/i.test(
        lower,
      );
    }

    // For .mp4, require it to look like an actual media file, not a URL path component
    // e.g. /video.mp4 is valid, but /mp4/config or /api/mp4/stream is not
    if (
      lower.endsWith(".mp4") ||
      lower.endsWith(".m4v") ||
      lower.endsWith(".m4a")
    ) {
      return true;
    }

    return (
      lower.endsWith(".m3u8") ||
      lower.endsWith(".mpd") ||
      lower.endsWith(".m4s") ||
      lower.endsWith(".webm") ||
      lower.endsWith(".cmfv") || // CMAF video
      lower.endsWith(".cmfa") || // CMAF audio
      lower.includes("/hls/") ||
      lower.includes("/dash/")
    );
  }

  function detectManifestContent(url, content) {
    if (!content) return "unknown";
    if (content.startsWith("#EXTM3U")) return "hls";
    if (content.includes("<MPD")) return "dash";
    if (content.includes("SmoothStreamingMedia")) return "mss";
    if (url.includes(".m3u8")) return "hls";
    if (url.includes(".mpd")) return "dash";
    return "unknown";
  }

  function detectStreamType(url) {
    const lower = url.toLowerCase();
    if (lower.includes(".m3u8")) return "hls";
    if (lower.includes(".mpd")) return "dash";
    if (lower.endsWith(".ts")) return "ts";
    if (
      lower.endsWith(".m4s") ||
      lower.endsWith(".cmfv") ||
      lower.endsWith(".cmfa")
    )
      return "fmp4";
    if (lower.endsWith(".mp4")) return "mp4";
    if (lower.endsWith(".webm")) return "webm";
    return "unknown";
  }

  // ─── License URL Detection ─────────────────────────────────────
  //
  // On Chrome there's no webRequest.filterResponseData(), so license
  // URLs must be detected from the page's fetch/XHR traffic. This
  // bridges the gap so drm-handler.js can populate state.licenseUrl
  // for auto-extraction and the popup's "Extract Keys" button.

  const _LICENSE_URL_PATTERNS = [
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
  ];

  const _seenLicenseUrls = new Set();

  function isLicenseUrl(url) {
    if (!url || typeof url !== "string") return false;
    return _LICENSE_URL_PATTERNS.some((p) => p.test(url));
  }

  function reportLicenseUrl(url, method) {
    if (!url || _seenLicenseUrls.has(url)) return;
    _seenLicenseUrls.add(url);
    // Fire-and-forget — don't block the actual license request
    sendToBackground("EME_LICENSE_URL_DETECTED", {
      licenseUrl: url,
      method: method || "POST",
    }).catch(() => {});
  }

  // ─── 8. MediaSource / SourceBuffer Hooks ─────────────────────────

  if (typeof SourceBuffer !== "undefined") {
    const originalAppendBuffer = SourceBuffer.prototype.appendBuffer;

    SourceBuffer.prototype.appendBuffer = stealthProxy(originalAppendBuffer, {
      apply: function (target, thisArg, args) {
        try {
          const data = args[0];
          const bytes = new Uint8Array(
            data instanceof ArrayBuffer ? data : data.buffer,
          );

          // Check for MP4 init segment (ftyp or moov) or PSSH boxes
          if (bytes.length > 8) {
            const boxType = String.fromCharCode(
              bytes[4],
              bytes[5],
              bytes[6],
              bytes[7],
            );
            if (boxType === "ftyp" || boxType === "moov") {
              // Scan for PSSH boxes in the init segment
              const psshBoxes = findPsshBoxes(bytes);
              if (psshBoxes.length > 0) {
                for (const pssh of psshBoxes) {
                  const hash = hashBuffer(pssh);
                  if (!seenPsshHashes.has(hash)) {
                    seenPsshHashes.add(hash);
                    sendToBackground("EME_PSSH_CAPTURED", {
                      pssh: bufferToBase64(pssh),
                      initDataType: "cenc",
                      source: "init-segment",
                    });
                  }
                }
              }

              sendToBackground("STREAM_URL_DETECTED", {
                url: "[init-segment-via-sourcebuffer]",
                streamType: "init-segment",
                contentType: thisArg.mimeType || "unknown",
              });
            }
          }
        } catch (e) {
          // Ignore detection errors
        }

        return Reflect.apply(target, thisArg, args);
      },
    });
  }

  /**
   * Find PSSH boxes within an MP4 buffer.
   * Scans for 'pssh' box type and extracts the full box.
   * Recurses into container boxes (moov, trak, etc.)
   * (Based on nginx-vod-module PSSH structure knowledge)
   */
  function findPsshBoxes(data) {
    const boxes = [];
    let offset = 0;

    while (offset + 8 <= data.length) {
      const view = new DataView(
        data.buffer,
        data.byteOffset + offset,
        Math.min(8, data.length - offset),
      );
      const size = view.getUint32(0, false);
      const type = String.fromCharCode(
        data[offset + 4],
        data[offset + 5],
        data[offset + 6],
        data[offset + 7],
      );

      if (size < 8 || offset + size > data.length) break;

      if (type === "pssh") {
        boxes.push(data.slice(offset, offset + size));
      } else if (
        type === "moov" ||
        type === "trak" ||
        type === "mdia" ||
        type === "minf" ||
        type === "stbl" ||
        type === "sinf" ||
        type === "schi"
      ) {
        // Container boxes — recurse into them
        const inner = findPsshBoxes(data.slice(offset + 8, offset + size));
        boxes.push(...inner);
      }

      offset += size;
    }

    return boxes;
  }

  // ─── 9. MutationObserver for dynamic video/audio elements ────────
  //
  // From eme_logger: traceElement uses MutationObserver to detect
  // dynamically added video/audio elements and hook their encrypted event.

  function observeMediaElements() {
    // Hook existing elements
    document.querySelectorAll("video, audio").forEach(hookMediaElement);

    // Watch for new elements
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === 1) {
            // Element
            if (node.tagName === "VIDEO" || node.tagName === "AUDIO") {
              hookMediaElement(node);
            }
            // Also check children (for elements added inside containers)
            if (node.querySelectorAll) {
              node.querySelectorAll("video, audio").forEach(hookMediaElement);
            }
          }
        }
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  function hookMediaElement(element) {
    if (element[_hooked]) return;
    element[_hooked] = true;

    // Listen for 'encrypted' event (the EME trigger from shaka/dash.js)
    element.addEventListener("encrypted", function (event) {
      _log(
        "encrypted event on",
        element.tagName,
        "initDataType:",
        event.initDataType,
        "size:",
        event.initData?.byteLength,
      );

      if (event.initData) {
        const psshB64 = bufferToBase64(event.initData);
        const hash = hashBuffer(new Uint8Array(event.initData));

        if (!seenPsshHashes.has(hash)) {
          seenPsshHashes.add(hash);
          sendToBackground("EME_PSSH_CAPTURED", {
            pssh: psshB64,
            initDataType: event.initDataType,
            source: "encrypted-event",
          });
        }
      }
    });

    // Capture metadata for download throttling (DRM-Download-Calculator)
    element.addEventListener("loadedmetadata", function () {
      sendToBackground("MEDIA_METADATA", {
        duration: element.duration,
        videoWidth: element.videoWidth,
        videoHeight: element.videoHeight,
        src: element.src || element.currentSrc || "",
      });
    });
  }

  // Wait for DOM to be ready, then start observing
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", observeMediaElements);
  } else {
    observeMediaElements();
  }

  // ─── 10. Player Detection (DRM-BYPASS-METHODOLOGY Section 35) ────
  //
  // Different sites use different video players. Detecting the player
  // helps identify the best hook points and provides useful context
  // in the extension UI. Runs after DOM is interactive.

  function detectPlayer() {
    const detected = [];

    if (window.shaka && window.shaka.Player) detected.push("shaka-player");
    if (window.dashjs && window.dashjs.MediaPlayer) detected.push("dash.js");
    if (window.Hls) detected.push("hls.js");
    if (window.videojs) detected.push("video.js");
    if (window.jwplayer) detected.push("jwplayer");
    if (window.Bitmovin && window.Bitmovin.Player) detected.push("bitmovin");
    if (window.flowplayer) detected.push("flowplayer");
    if (window.THEOplayer) detected.push("theo-player");
    if (window.cast && window.cast.framework) detected.push("chromecast-caf");

    // Check for indigo-player (wrapper)
    if (document.querySelector("[data-indigo-player]"))
      detected.push("indigo-player");

    return detected.length > 0 ? detected : ["unknown"];
  }

  // Report detected players to background after load
  function reportPlayerDetection() {
    const players = detectPlayer();
    if (players[0] !== "unknown") {
      sendToBackground("MEDIA_METADATA", {
        detectedPlayers: players,
      });
      _log("Detected video player(s):", players.join(", "));
    }
  }

  if (document.readyState === "complete") {
    setTimeout(reportPlayerDetection, 1000);
  } else {
    window.addEventListener("load", () =>
      setTimeout(reportPlayerDetection, 1000),
    );
  }

  // ─── 11. PlayReady License URL Extraction (Section 37) ───────────
  //
  // PlayReady embeds the license acquisition URL inside the WRMHEADER
  // XML (UTF-16LE encoded) within the init data. Extract it when we
  // see PlayReady init data in generateRequest.

  function extractPlayReadyLicenseUrl(initData) {
    try {
      const text = new TextDecoder("utf-16le").decode(initData);
      const match = text.match(/<LA_URL>(.+?)<\/LA_URL>/);
      return match ? match[1] : null;
    } catch (e) {
      return null;
    }
  }

  // Expose for use in the generateRequest hook (already intercepts initData)
  // The generateRequest Proxy checks initDataType — if "keyids" or the
  // system ID matches PlayReady, we can extract the license URL.
  // This is integrated into the main generateRequest hook above via
  // sendToBackground with the extracted URL.

  _log("EME Interceptor v2 active — stealth mode");
})();
