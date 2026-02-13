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

  function relayToBackground(msg) {
    if (relayInvalidated || !chrome?.runtime?.sendMessage) return;
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
        activate();
      }
    }, 300);
  };

  window.addEventListener("beforeunload", () => {
    if (registry) registry.destroy();
  });
})();
