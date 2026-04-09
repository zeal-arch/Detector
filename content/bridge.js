/**
 * bridge.js — ISOLATED World ↔ MAIN World Message Bridge
 * =======================================================
 * Universal: Chrome MV3 + Firefox MV2 + Firefox MV3
 *
 * Two responsibilities:
 *   1. Inject eme-interceptor.js into the page's MAIN world
 *   2. Relay messages between MAIN world ↔ background script
 *
 * Injection strategy: <script src="extension-url">
 *   - Works on ALL browsers (Chrome 88+, Firefox 48+)
 *   - Extension URLs listed in web_accessible_resources bypass CSP
 *   - Executes synchronously at document_start, before page scripts
 *   - No dependency on "world":"MAIN" (Chrome 111+ / Firefox 128+)
 *   - Same technique TMpermonkey uses for universal injection
 *
 * Anti-detection measures:
 *   - Symbol.for() guard (invisible to for..in, Object.keys, JSON)
 *   - Short generic event channel names (__wm, __wr, __wb)
 *   - Script element removed immediately after injection
 *   - No console output in production
 */
(function () {
  "use strict";

  // ─── Universal API namespace ─────────────────────────────────────
  // Firefox defines `browser` (Promise-based), Chrome only has `chrome`.
  // Both expose .runtime, so we pick whichever exists.
  const api =
    typeof browser !== "undefined" && browser.runtime ? browser : chrome;

  // ─── Anti-detection: double-injection guard ──────────────────────
  const _guard = Symbol.for("__m$b");
  if (window[_guard]) return;
  window[_guard] = true;

  // ─── MAIN World Injection ────────────────────────────────────────
  // Inject eme-interceptor.js using <script src="..."> tag.
  // This works universally because:
  //   1. bridge.js runs in ISOLATED world at document_start
  //   2. eme-interceptor.js is in web_accessible_resources
  //   3. `src` (not textContent) avoids CSP script-src restrictions
  //   4. Executes synchronously before any page JavaScript
  //
  // Trusted Types: If the site enforces CSP `require-trusted-types-for 'script'`,
  // setting script.src is a TrustedScriptURL sink and will throw TypeError.
  // We handle this with multiple fallback strategies:
  //   a) Try <script src> directly (works on most sites)
  //   b) If Trusted Types blocks it, create a policy to allow the URL
  //   c) If policy creation is restricted, request background to inject via
  //      chrome.scripting.executeScript with world:"MAIN"

  const interceptorUrl = api.runtime.getURL("content/eme-interceptor.js");
  let injected = false;

  // Strategy A: Direct <script src> injection (fast, synchronous)
  try {
    const scriptEl = document.createElement("script");
    scriptEl.src = interceptorUrl;
    const anchor = document.head || document.documentElement;
    anchor.appendChild(scriptEl);
    scriptEl.remove();
    injected = true;
  } catch (e) {
    // Likely Trusted Types enforcement — try fallback strategies
    console.debug("[bridge] Direct script injection blocked:", e.message);
  }

  // Strategy B: Trusted Types policy-based injection
  if (!injected && typeof trustedTypes !== "undefined") {
    try {
      const policy = trustedTypes.createPolicy("m3u8-bridge", {
        createScriptURL: (url) => url,
      });
      const scriptEl = document.createElement("script");
      scriptEl.src = policy.createScriptURL(interceptorUrl);
      const anchor = document.head || document.documentElement;
      anchor.appendChild(scriptEl);
      scriptEl.remove();
      injected = true;
    } catch (e2) {
      // Policy name not allowed by trusted-types CSP directive
      console.debug("[bridge] Trusted Types policy fallback blocked:", e2.message);
    }
  }

  // Strategy C: Request background script to inject via chrome.scripting.executeScript
  if (!injected) {
    try {
      api.runtime.sendMessage({
        type: "INJECT_EME_INTERCEPTOR",
      });
      // Injection will happen asynchronously — not synchronous like <script src>,
      // but ensures interceptor runs even on strict Trusted Types sites.
    } catch (e3) {
      console.debug("[bridge] Background injection request failed:", e3.message);
    }
  }

  // ─── Event channel names — must match eme-interceptor.js ─────────
  const _EVT_MSG = "__wm"; // MAIN → bridge (requests)
  const _EVT_RSP = "__wr"; // bridge → MAIN (responses)
  const _EVT_BROADCAST = "__wb"; // background → MAIN (broadcasts)

  // ─── Firefox X-ray wrapper safe dispatch ─────────────────────────
  // Firefox ISOLATED→MAIN CustomEvent.detail is wrapped in X-ray
  // wrappers, making it appear as `null` to page scripts. cloneInto()
  // exports the object into the page's compartment safely.
  function dispatchToMain(eventName, detail) {
    const safeDetail =
      typeof cloneInto === "function" ? cloneInto(detail, window) : detail;
    window.dispatchEvent(new CustomEvent(eventName, { detail: safeDetail }));
  }

  // ─── MAIN world → Background relay ──────────────────────────────
  // eme-interceptor.js dispatches CustomEvents on _EVT_MSG. We catch
  // them in ISOLATED world and forward via api.runtime.sendMessage.

  window.addEventListener(_EVT_MSG, async (event) => {
    const detail = event.detail;
    if (!detail || !detail.requestId || !detail.type) return;

    const { requestId, type, ...data } = detail;

    try {
      // Both Firefox (browser.runtime.sendMessage) and
      // Chrome MV3 (chrome.runtime.sendMessage) return Promises.
      // Firefox MV2 browser.* is also Promise-based.
      const response = await api.runtime.sendMessage({
        type: type,
        ...data,
      });

      // Relay response back to MAIN world
      dispatchToMain(_EVT_RSP, {
        requestId: requestId,
        response: response || {},
      });
    } catch (error) {
      // Extension context may have been invalidated (update/reload)
      dispatchToMain(_EVT_RSP, {
        requestId: requestId,
        response: { error: error.message || "Bridge relay failed" },
      });
    }
  });

  // ─── Background → MAIN world relay (broadcasts) ─────────────────
  // The background script can push messages to content scripts.
  // We re-broadcast them to MAIN world via CustomEvent for
  // eme-interceptor.js to receive.

  try {
    api.runtime.onMessage.addListener((message) => {
      if (message && message.type && message.type.startsWith("BROADCAST_")) {
        dispatchToMain(_EVT_BROADCAST, message);
      }
      // Not returning true — we don't send a response for broadcasts
    });
  } catch (e) {
    // onMessage may fail if extension context is invalidated
  }
})();
