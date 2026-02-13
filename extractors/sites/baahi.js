(function () {
  "use strict";

  const SITE_ID = "baahi";

  if (window.__SITE_SPECIALIST_LOADED === SITE_ID) return;
  window.__SITE_SPECIALIST_LOADED = SITE_ID;

  const AUDIO_RE = /\.(mp3|m4a|aac|ogg|wav|flac|opus|weba)(\?|$)/i;
  const STREAM_RE = /\.(m3u8|mpd)(\?|$)/i;
  const sentUrls = new Set();
  let lastUrl = location.href;

  function log(...args) {
    console.log(`[Specialist][${SITE_ID}]`, ...args);
  }

  function sendToBackground(videos) {

    const fresh = videos.filter((v) => !sentUrls.has(v.url));
    if (fresh.length === 0) return;
    fresh.forEach((v) => sentUrls.add(v.url));

    window.postMessage(
      {
        type: "LALHLIMPUII_JAHAU_DETECTED",
        source: SITE_ID,
        data: { videos: fresh },
      },
      "*",
    );
    log(`Sent ${fresh.length} audio tracks`);
  }

  function getSongTitle() {

    const selectors = [
      "h1",
      ".song-title",
      ".track-title",
      ".player-title",
      ".now-playing-title",
      '[class*="songName"]',
      '[class*="song-name"]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim()) return el.textContent.trim();
    }
    return (
      document.title.replace(/\s*[-|]\s*Baahi.*$/i, "").trim() || document.title
    );
  }

  function detectAudioUrl(url) {
    if (!url || typeof url !== "string") return;
    if (!url.startsWith("http")) return;
    if (sentUrls.has(url)) return;

    const isAudio = AUDIO_RE.test(url);
    const isStream = STREAM_RE.test(url);

    if (isAudio || isStream) {
      const ext = url.match(/\.(\w+)(?:\?|$)/)?.[1] || "mp3";
      sendToBackground([
        {
          url,
          quality: "audio",
          format: ext,
          title: getSongTitle(),
          extractor: SITE_ID,
        },
      ]);
    }
  }

  const OrigAudio = window.Audio;
  window.Audio = function (src) {
    if (src) detectAudioUrl(src);
    return new OrigAudio(src);
  };
  window.Audio.prototype = OrigAudio.prototype;

  const srcDescriptor = Object.getOwnPropertyDescriptor(
    HTMLMediaElement.prototype,
    "src",
  );
  if (srcDescriptor && srcDescriptor.set) {
    Object.defineProperty(HTMLMediaElement.prototype, "src", {
      get: srcDescriptor.get,
      set(val) {
        detectAudioUrl(val);
        return srcDescriptor.set.call(this, val);
      },
      configurable: true,
      enumerable: true,
    });
  }

  const origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    setTimeout(() => {
      if (this.src) detectAudioUrl(this.src);
      if (this.currentSrc) detectAudioUrl(this.currentSrc);
    }, 100);
    return origPlay.apply(this, arguments);
  };

  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const url = typeof args[0] === "string" ? args[0] : args[0]?.url;

    if (url) detectAudioUrl(url);

    const result = origFetch.apply(this, args);
    if (
      url &&
      typeof url === "string" &&
      (url.includes("/api/") ||
        url.includes("/song") ||
        url.includes("/stream") ||
        url.includes("/play") ||
        url.includes("/track") ||
        url.includes("xomoy.com"))
    ) {
      result
        .then((resp) => {
          const clone = resp.clone();
          clone
            .text()
            .then((text) => {

              const matches = text.match(
                /https?:\/\/[^"'\s,}]+\.(?:mp3|m4a|aac|ogg|wav|flac|opus|weba|m3u8)(?:[^"'\s,}]*)/gi,
              );
              if (matches) {
                matches.forEach((m) => detectAudioUrl(m));
              }
            })
            .catch(() => {});
        })
        .catch(() => {});
    }

    return result;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__baahiUrl = url;
    if (url) detectAudioUrl(url);
    return origOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("load", function () {
      try {
        const responseText = this.responseText;
        if (
          responseText &&
          (this.__baahiUrl?.includes("/api/") ||
            this.__baahiUrl?.includes("/song") ||
            this.__baahiUrl?.includes("/stream") ||
            this.__baahiUrl?.includes("xomoy.com"))
        ) {
          const matches = responseText.match(
            /https?:\/\/[^"'\s,}]+\.(?:mp3|m4a|aac|ogg|wav|flac|opus|weba|m3u8)(?:[^"'\s,}]*)/gi,
          );
          if (matches) {
            matches.forEach((m) => detectAudioUrl(m));
          }
        }
      } catch {

      }
    });
    return origSend.apply(this, args);
  };

  function scanDom() {

    for (const el of document.querySelectorAll("audio, video")) {
      if (el.src) detectAudioUrl(el.src);
      if (el.currentSrc) detectAudioUrl(el.currentSrc);
      for (const src of el.querySelectorAll("source")) {
        if (src.src) detectAudioUrl(src.src);
      }
    }

    try {
      if (window.Howler && window.Howler._howls) {
        for (const howl of window.Howler._howls) {
          const srcs = howl._src;
          if (Array.isArray(srcs)) srcs.forEach((s) => detectAudioUrl(s));
          else if (typeof srcs === "string") detectAudioUrl(srcs);
        }
      }
    } catch {

    }
  }

  const observer = new MutationObserver((mutations) => {
    for (const mut of mutations) {
      for (const node of mut.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.tagName === "AUDIO" || node.tagName === "VIDEO") {
          if (node.src) detectAudioUrl(node.src);
        }

        const mediaEls = node.querySelectorAll?.("audio, video");
        if (mediaEls) {
          for (const el of mediaEls) {
            if (el.src) detectAudioUrl(el.src);
          }
        }
      }
    }
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  function onNavigation() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;

      sentUrls.clear();
      setTimeout(scanDom, 1000);
    }
  }

  window.addEventListener("popstate", onNavigation);
  setInterval(onNavigation, 2000);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () =>
      setTimeout(scanDom, 1000),
    );
  } else {
    setTimeout(scanDom, 1000);
  }

  window.addEventListener("message", (event) => {
    if (
      event.data?.type === "LALHLIMPUII_JAHAU_EXTRACT" &&
      event.data.source === SITE_ID
    ) {
      scanDom();
    }
  });

  log("Baahi specialist initialized (Audio/fetch/XHR hooks + DOM scan)");
})();
