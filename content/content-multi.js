(() => {
  "use strict";

  if (/youtube\.com|youtu\.be/.test(window.location.hostname)) {
    return;
  }

  console.log(
    "[Multi-DL] Content script loaded for:",
    window.location.hostname,
  );

  const registry =
    typeof ExtractorRegistry !== "undefined" ? new ExtractorRegistry() : null;

  let relayInvalidated = false;
  // Navigation generation counter: increments on every SPA navigation.
  // MAIN-world hooks (e.g. twitter-network-hook.js) cannot be unhooked
  // on SPA navigation. When they fire postMessage for an OLD video after
  // a navigation, the relay must discard the stale message to prevent
  // overwriting the new page's tabData in background.js.
  let navGeneration = 0;

  function relayToBackground(msg) {
    if (relayInvalidated || !chrome?.runtime?.sendMessage) return;
    // Attach generation so background can ignore stale relays
    msg._navGen = navGeneration;
    msg._navHref = lastHref;
    chrome.runtime.sendMessage(msg).catch((err) => {
      if (
        err.message?.includes("Extension context invalidated") ||
        err.message?.includes("Cannot read properties")
      ) {
        relayInvalidated = true;
      }
    });
  }

  window.addEventListener("message", (event) => {
    if (!event || event.source !== window || !event.data) return;
    const { type, source, data } = event.data;

    // Discard messages whose pageUrl doesn't match the current page.
    // This catches stale MAIN-world hook messages that fired for a
    // previously navigated-away page on SPA sites like Twitter/X.
    const msgPageUrl = data?.pageUrl || event.data?.pageUrl;
    if (msgPageUrl && msgPageUrl !== window.location.href) {
      console.debug(
        "[Multi-DL] Dropping stale MAIN-world message (URL mismatch):",
        msgPageUrl?.substring(0, 60),
      );
      return;
    }

    if (type === "MAGIC_M3U8_DETECTION" && source === "SITE_SPECIALIST") {
      console.log("[Multi-DL] Relaying MAGIC_M3U8 specialist detection");
      relayToBackground({
        action: "SPECIALIST_DETECTED",
        protocol: "MAGIC_M3U8",
        payload: data,
        pageUrl: window.location.href,
      });
    }

    if (type === "LALHLIMPUII_JAHAU_DETECTED" && source) {
      console.log(
        "[Multi-DL] Relaying LALHLIMPUII_JAHAU detection from:",
        source,
      );
      relayToBackground({
        action: "SPECIALIST_DETECTED",
        protocol: "LALHLIMPUII_JAHAU",
        siteId: source,
        payload: data,
        pageUrl: window.location.href,
      });
    }
  });

  async function activate() {
    if (!registry) return;

    // Ask background.js if a specialist extractor exists for this site.
    // If so, skip the generic extractor — the specialist will be injected
    // separately by background.js via chrome.scripting.executeScript.
    try {
      const resp = await chrome.runtime.sendMessage({
        action: "CHECK_SPECIALIST",
        hostname: window.location.hostname,
      });
      if (resp && resp.hasSpecialist) {
        console.log(
          `[Multi-DL] Specialist "${resp.scriptFile}" exists for ${window.location.hostname} — skipping generic extractor`,
        );
        return;
      }
    } catch (e) {
      // If the check fails (e.g. extension context invalidated), fall through to generic
      console.debug(
        "[Multi-DL] CHECK_SPECIALIST failed, falling back to generic:",
        e.message,
      );
    }

    const extractor = await registry.activate(window.location.href);
    if (extractor) {
      console.log(`[Multi-DL] Extractor active: ${extractor.name}`);
    }
  }

  if (
    document.readyState === "complete" ||
    document.readyState === "interactive"
  ) {
    setTimeout(activate, 500);
  } else {
    document.addEventListener("DOMContentLoaded", () =>
      setTimeout(activate, 500),
    );
  }

  let lastHref = window.location.href;

  window.addEventListener("popstate", () => {
    setTimeout(() => {
      if (window.location.href !== lastHref) {
        lastHref = window.location.href;
        navGeneration++;
        activate();
      }
    }, 300);
  });

  const origPush = history.pushState;
  history.pushState = function () {
    origPush.apply(this, arguments);
    setTimeout(() => {
      if (window.location.href !== lastHref) {
        lastHref = window.location.href;
        navGeneration++;
        activate();
      }
    }, 300);
  };

  const origReplace = history.replaceState;
  history.replaceState = function () {
    origReplace.apply(this, arguments);
    setTimeout(() => {
      if (window.location.href !== lastHref) {
        lastHref = window.location.href;
        navGeneration++;
        activate();
      }
    }, 300);
  };

  window.addEventListener("beforeunload", () => {
    if (registry) registry.destroy();
  });
})();
