(function () {
  "use strict";

  const SITE_ID = "lersiaplay";
  const TAG = "[LersiaPlay-Specialist]";
  const sentUrls = new Set();
  let lastUrl = location.href;

  const STREAM_RE = /\.(?:m3u8|mpd|mp4|webm|ts)(\?|$)/i;
  const API_STREAM_RE = /["'](https?:\/\/[^"']+\.(?:m3u8|mpd|mp4|webm))["']/gi;

  function isStreamUrl(url) {
    return (
      typeof url === "string" && STREAM_RE.test(url) && url.startsWith("http")
    );
  }

  function getTitle() {
    const sels = [
      ".video-title",
      ".movie-title",
      ".series-title",
      ".content-title",
      ".title",
      "h1",
      "h2",
      ".player-title",
    ];
    for (const s of sels) {
      const el = document.querySelector(s);
      if (el && el.textContent.trim()) return el.textContent.trim();
    }
    return document.title;
  }

  function guessQuality(url) {
    if (url.includes("1080")) return "1080p";
    if (url.includes("720")) return "720p";
    if (url.includes("480")) return "480p";
    if (url.includes("360")) return "360p";
    return "auto";
  }

  function guessFormat(url) {
    if (url.includes(".m3u8")) return "m3u8";
    if (url.includes(".mpd")) return "mpd";
    if (url.includes(".webm")) return "webm";
    return "mp4";
  }

  function send(videos) {
    const fresh = videos.filter((v) => !sentUrls.has(v.url));
    if (fresh.length === 0) return;
    fresh.forEach((v) => sentUrls.add(v.url));
    console.log(TAG, `Sending ${fresh.length} stream(s)`);
    window.postMessage(
      {
        type: "LALHLIMPUII_JAHAU_DETECTED",
        source: SITE_ID,
        data: { videos: fresh },
      },
      "*",
    );
  }

  function sendOne(url, extra) {
    send([
      {
        url,
        quality: guessQuality(url),
        format: guessFormat(url),
        title: getTitle(),
        ...extra,
      },
    ]);
  }

  try {
    const origFetch = window.fetch;
    window.fetch = function (...args) {
      const reqUrl = typeof args[0] === "string" ? args[0] : args[0]?.url || "";

      if (isStreamUrl(reqUrl)) sendOne(reqUrl);

      return origFetch.apply(this, args).then((resp) => {
        try {
          const ct = resp.headers?.get("content-type") || "";

          if (
            ct.includes("json") ||
            reqUrl.includes("/api/") ||
            reqUrl.includes("lersia")
          ) {
            resp
              .clone()
              .text()
              .then((body) => {
                const matches = body.match(API_STREAM_RE);
                if (matches) {
                  const vids = [];
                  for (const m of matches) {
                    const url = m.slice(1, -1);
                    if (isStreamUrl(url))
                      vids.push({
                        url,
                        quality: guessQuality(url),
                        format: guessFormat(url),
                        title: getTitle(),
                      });
                  }
                  if (vids.length) send(vids);
                }
              })
              .catch(() => {});
          }

          if (ct.includes("mpegurl") || ct.includes("x-mpegURL")) {
            sendOne(reqUrl, { format: "m3u8" });
          }

          if (ct.includes("dash+xml")) {
            sendOne(reqUrl, { format: "mpd" });
          }
        } catch (e) {

        }
        return resp;
      });
    };
    console.log(TAG, "fetch() hooked");
  } catch (e) {
    console.warn(TAG, "Failed to hook fetch:", e.message);
  }

  try {
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this._lerspUrl = url;
      if (isStreamUrl(url)) sendOne(url);
      return origOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function (...args) {
      this.addEventListener("load", function () {
        try {
          const ct = this.getResponseHeader("content-type") || "";
          if (ct.includes("mpegurl") || ct.includes("x-mpegURL")) {
            sendOne(this._lerspUrl, { format: "m3u8" });
          }
          if (ct.includes("dash+xml")) {
            sendOne(this._lerspUrl, { format: "mpd" });
          }
          if (
            ct.includes("json") ||
            (this._lerspUrl &&
              (this._lerspUrl.includes("/api/") ||
                this._lerspUrl.includes("lersia")))
          ) {
            const body = this.responseText || "";
            const matches = body.match(API_STREAM_RE);
            if (matches) {
              const vids = [];
              for (const m of matches) {
                const url = m.slice(1, -1);
                if (isStreamUrl(url))
                  vids.push({
                    url,
                    quality: guessQuality(url),
                    format: guessFormat(url),
                    title: getTitle(),
                  });
              }
              if (vids.length) send(vids);
            }
          }
        } catch (e) {

        }
      });
      return origSend.apply(this, args);
    };
    console.log(TAG, "XMLHttpRequest hooked");
  } catch (e) {
    console.warn(TAG, "Failed to hook XHR:", e.message);
  }

  function hookHlsJs() {
    try {
      if (typeof window.Hls === "function" && window.Hls.prototype) {
        const origLoad = window.Hls.prototype.loadSource;
        if (origLoad && !origLoad._lerspHooked) {
          window.Hls.prototype.loadSource = function (url) {
            console.log(TAG, "HLS.js loadSource:", url);
            if (url && url.startsWith("http")) sendOne(url, { format: "m3u8" });
            return origLoad.call(this, url);
          };
          window.Hls.prototype.loadSource._lerspHooked = true;
          console.log(TAG, "HLS.js loadSource hooked");
        }
      }
    } catch (e) {

    }
  }

  function hookVideoJs() {
    try {
      if (
        typeof window.videojs === "function" &&
        !window.videojs._lerspHooked
      ) {
        const origVideoJs = window.videojs;
        window.videojs = function (...args) {
          const player = origVideoJs.apply(this, args);
          try {
            if (player && typeof player.src === "function") {
              const origSrc = player.src.bind(player);
              player.src = function (source) {
                if (source) {
                  const srcs = Array.isArray(source) ? source : [source];
                  for (const s of srcs) {
                    const url = typeof s === "string" ? s : s.src;
                    if (url && url.startsWith("http")) {
                      console.log(TAG, "Video.js source:", url);
                      sendOne(url);
                    }
                  }
                }
                return origSrc(source);
              };
            }
          } catch (e) {

          }
          return player;
        };

        for (const k of Object.keys(origVideoJs)) {
          try {
            window.videojs[k] = origVideoJs[k];
          } catch (e) {

          }
        }
        window.videojs._lerspHooked = true;
        console.log(TAG, "Video.js hooked");
      }
    } catch (e) {

    }
  }

  try {
    const desc = Object.getOwnPropertyDescriptor(
      HTMLMediaElement.prototype,
      "src",
    );
    if (desc && desc.set) {
      const origSet = desc.set;
      Object.defineProperty(HTMLMediaElement.prototype, "src", {
        ...desc,
        set(val) {
          if (val && typeof val === "string" && isStreamUrl(val)) {
            console.log(TAG, "MediaElement.src set:", val);
            sendOne(val);
          }
          return origSet.call(this, val);
        },
      });
      console.log(TAG, "HTMLMediaElement.src setter hooked");
    }
  } catch (e) {
    console.warn(TAG, "Failed to hook MediaElement.src:", e.message);
  }

  try {
    if (typeof MediaSource !== "undefined") {
      const origAddSB = MediaSource.prototype.addSourceBuffer;
      if (origAddSB && !origAddSB._lerspHooked) {
        MediaSource.prototype.addSourceBuffer = function (mimeType) {
          console.log(TAG, "MediaSource.addSourceBuffer:", mimeType);

          return origAddSB.call(this, mimeType);
        };
        MediaSource.prototype.addSourceBuffer._lerspHooked = true;
      }
    }
  } catch (e) {

  }

  function scanDom() {
    const videos = [];
    const title = getTitle();

    for (const v of document.querySelectorAll("video")) {
      const src = v.src || v.currentSrc;
      if (src && src.startsWith("http") && !src.startsWith("blob:")) {
        videos.push({
          url: src,
          quality: guessQuality(src),
          format: guessFormat(src),
          title,
        });
      }
      for (const s of v.querySelectorAll("source")) {
        if (s.src && s.src.startsWith("http")) {
          videos.push({
            url: s.src,
            quality: guessQuality(s.src),
            format: guessFormat(s.src),
            title,
          });
        }
      }
    }

    for (const el of document.querySelectorAll(
      "[data-hls-url], [data-m3u8], [data-stream-url], [data-dash-url], [data-mpd], [data-video-url], [data-src]",
    )) {
      for (const attr of [
        "data-hls-url",
        "data-m3u8",
        "data-stream-url",
        "data-dash-url",
        "data-mpd",
        "data-video-url",
        "data-src",
      ]) {
        const u = el.getAttribute(attr);
        if (u && u.startsWith("http") && isStreamUrl(u)) {
          videos.push({
            url: u,
            quality: guessQuality(u),
            format: guessFormat(u),
            title,
          });
        }
      }
    }

    for (const iframe of document.querySelectorAll(
      'iframe[src*="youtube"], iframe[src*="youtu.be"], iframe[src*="vimeo"]',
    )) {
      const src = iframe.src;
      if (src.includes("youtube.com/embed/")) {
        const id = src.match(/embed\/([^?/]+)/);
        if (id)
          videos.push({
            url: `https://www.youtube.com/watch?v=${id[1]}`,
            quality: "embed",
            format: "embed",
            title: title + " (Trailer)",
          });
      } else if (src.includes("youtu.be/")) {
        const id = src.match(/youtu\.be\/([^?/]+)/);
        if (id)
          videos.push({
            url: `https://www.youtube.com/watch?v=${id[1]}`,
            quality: "embed",
            format: "embed",
            title: title + " (Trailer)",
          });
      } else if (src.includes("vimeo.com/")) {
        const id = src.match(/vimeo\.com\/(?:video\/)?(\d+)/);
        if (id)
          videos.push({
            url: `https://vimeo.com/${id[1]}`,
            quality: "embed",
            format: "embed",
            title: title + " (Trailer)",
          });
      }
    }

    for (const script of document.querySelectorAll("script")) {
      const c = script.textContent || "";
      if (c.length < 20 || c.length > 500000) continue;
      const matches = c.match(API_STREAM_RE);
      if (matches) {
        for (const m of matches) {
          const url = m.slice(1, -1);
          if (isStreamUrl(url))
            videos.push({
              url,
              quality: guessQuality(url),
              format: guessFormat(url),
              title,
            });
        }
      }
    }

    if (videos.length > 0) send(videos);
  }

  new MutationObserver((mutations) => {
    let needsScan = false;
    for (const mut of mutations) {
      for (const node of mut.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (
          node.tagName === "VIDEO" ||
          node.tagName === "IFRAME" ||
          node.querySelector?.("video, iframe")
        ) {
          needsScan = true;
          break;
        }
      }
      if (needsScan) break;
    }
    if (needsScan) setTimeout(scanDom, 500);

    hookHlsJs();
    hookVideoJs();
  }).observe(document.documentElement, { childList: true, subtree: true });

  hookHlsJs();
  hookVideoJs();
  setTimeout(() => {
    hookHlsJs();
    hookVideoJs();
  }, 3000);
  setTimeout(() => {
    hookHlsJs();
    hookVideoJs();
  }, 8000);

  setTimeout(scanDom, 2000);

  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      sentUrls.clear();
      console.log(TAG, "SPA navigation detected");
      setTimeout(scanDom, 2000);
    }
  }, 1500);

  setInterval(scanDom, 8000);

  window.addEventListener("popstate", () => {
    sentUrls.clear();
    setTimeout(scanDom, 2000);
  });

  window.addEventListener("message", (e) => {
    if (
      e.data?.type === "LALHLIMPUII_JAHAU_EXTRACT" &&
      e.data.source === SITE_ID
    )
      scanDom();
  });

  console.log(TAG, "Specialist loaded — network hooks active");
})();
