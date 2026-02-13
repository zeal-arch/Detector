(() => {
  "use strict";

  const MAGIC = "__ytdl_ext__";
  let lastVideoId = null;
  let injected = false;

  function injectMainWorldScript() {
    if (injected) return;
    injected = true;

    const s = document.createElement("script");
    s.src = chrome.runtime.getURL("extractors/sites/youtube/inject.js");
    s.onload = function () {
      s.remove();
    };
    (document.head || document.documentElement).appendChild(s);
    console.log("[YT-DL] inject.js injected into MAIN world");
  }

  function getVideoId() {
    const url = window.location.href;
    let m;
    if ((m = url.match(/[?&]v=([a-zA-Z0-9_-]{11})/))) return m[1];
    if ((m = url.match(/\/shorts\/([a-zA-Z0-9_-]{11})/))) return m[1];
    if ((m = url.match(/\/embed\/([a-zA-Z0-9_-]{11})/))) return m[1];
    if ((m = url.match(/\/live\/([a-zA-Z0-9_-]{11})/))) return m[1];
    return null;
  }

  function scanScriptTags() {
    const data = {};

    for (const script of document.querySelectorAll("script:not([src])")) {
      const text = script.textContent;
      if (!text || text.length < 100) continue;

      if (text.includes("ytcfg.set")) {
        let m = text.match(/"STS":(\d{5,})/);
        if (m) data.sts = parseInt(m[1]);

        m = text.match(/"VISITOR_DATA":"([^"]+)"/);
        if (m) data.visitorData = m[1];

        m = text.match(/"PLAYER_JS_URL":"([^"]+)"/);
        if (m) {
          data.playerUrl = m[1];
          if (data.playerUrl && !data.playerUrl.startsWith("http")) {
            data.playerUrl = "https://www.youtube.com" + data.playerUrl;
          }
        }

        m = text.match(/"LOGGED_IN":(true|false)/);
        if (m) data.loggedIn = m[1] === "true";

        m = text.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/);
        if (m) data.clientVersion = m[1];
      }

      if (text.includes("ytInitialPlayerResponse")) {
        const pr = extractPlayerResponseFromScript(text);
        if (pr) data.playerResponse = pr;
      }
    }

    return data;
  }

  function extractPlayerResponseFromScript(text) {
    const marker = "ytInitialPlayerResponse";
    const idx = text.indexOf(marker);
    if (idx === -1) return null;

    let eqIdx = text.indexOf("=", idx + marker.length);
    if (eqIdx === -1) return null;

    let startIdx = -1;
    for (let i = eqIdx + 1; i < text.length; i++) {
      if (text[i] === "{") {
        startIdx = i;
        break;
      }
      if (
        text[i] !== " " &&
        text[i] !== "\n" &&
        text[i] !== "\r" &&
        text[i] !== "\t"
      )
        break;
    }
    if (startIdx === -1) return null;

    let depth = 0,
      inStr = false,
      strCh = "",
      escaped = false;
    for (let i = startIdx; i < text.length; i++) {
      const c = text[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (c === "\\") {
        escaped = true;
        continue;
      }
      if (inStr) {
        if (c === strCh) inStr = false;
        continue;
      }
      if (c === '"' || c === "'") {
        inStr = true;
        strCh = c;
        continue;
      }
      if (c === "{") depth++;
      if (c === "}") {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(text.substring(startIdx, i + 1));
          } catch (e) {
            return null;
          }
        }
      }
    }
    return null;
  }

  window.addEventListener("message", (e) => {
    if (!e.data || e.data.type !== MAGIC) return;

    const videoId = getVideoId();
    if (!videoId) return;

    const payload = e.data.payload || {};

    const scriptData = scanScriptTags();

    const merged = {
      videoId: payload.videoId || videoId,
      playerUrl: payload.playerUrl || scriptData.playerUrl || null,
      visitorData: payload.visitorData || scriptData.visitorData || null,
      sts: payload.sts || scriptData.sts || null,
      apiKey: payload.apiKey || null,
      clientVersion: payload.clientVersion || scriptData.clientVersion || null,
      playerResponse:
        payload.playerResponse || scriptData.playerResponse || null,
      resolvedFormats: payload.resolvedFormats || null,
      formatSource: payload.formatSource || null,
      nSigCode: payload.nSigCode || null,
      cipherCode: payload.cipherCode || null,
      cipherArgName: payload.cipherArgName || null,
      resolveError: payload.resolveError || null,
    };

    console.log("[YT-DL] Sending VIDEO_DETECTED:", videoId, {
      hasPlayerResponse: !!merged.playerResponse,
      resolvedFormats: merged.resolvedFormats
        ? merged.resolvedFormats.length
        : 0,
      formatSource: merged.formatSource,
      playerUrl: merged.playerUrl ? "yes" : "no",
      visitorData: merged.visitorData ? "yes" : "no",
    });

    try {
      chrome.runtime.sendMessage({
        action: "VIDEO_DETECTED",
        videoId: videoId,
        url: window.location.href,
        pageData: merged,
      });
    } catch {
      // Extension context invalidated (reload/update) — silently ignore
    }
  });

  let debounceTimer = null;

  function onNavigate() {
    const videoId = getVideoId();
    if (!videoId) return;
    if (videoId === lastVideoId) return;
    lastVideoId = videoId;

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      window.postMessage({ type: MAGIC + "_request" }, "*");

      setTimeout(() => {
        const scriptData = scanScriptTags();
        if (scriptData.playerResponse || scriptData.playerUrl) {
          try {
            chrome.runtime.sendMessage({
              action: "VIDEO_DETECTED",
              videoId: videoId,
              url: window.location.href,
              pageData: scriptData,
            });
          } catch {
            // Extension context invalidated (reload/update) — silently ignore
          }
        }
      }, 2500);
    }, 500);
  }

  window.addEventListener("yt-navigate-finish", () =>
    setTimeout(onNavigate, 100),
  );
  window.addEventListener("popstate", () => setTimeout(onNavigate, 200));

  const origPush = history.pushState;
  history.pushState = function () {
    origPush.apply(this, arguments);
    setTimeout(onNavigate, 200);
  };
  const origReplace = history.replaceState;
  history.replaceState = function () {
    origReplace.apply(this, arguments);
    setTimeout(onNavigate, 200);
  };

  injectMainWorldScript();

  if (
    document.readyState === "complete" ||
    document.readyState === "interactive"
  ) {
    setTimeout(onNavigate, 500);
  } else {
    document.addEventListener("DOMContentLoaded", () =>
      setTimeout(onNavigate, 500),
    );
  }

  console.log("[YT-DL] Content script loaded (MV3 ISOLATED)");
})();
