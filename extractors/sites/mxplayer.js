(function () {
  const SITE_ID = "mxplayer";

  if (window.__SITE_SPECIALIST_LOADED === SITE_ID) return;
  window.__SITE_SPECIALIST_LOADED = SITE_ID;

  const STREAM_BASE = "https://llvod.mxplay.com/";
  const API_BASE = "https://api.mxplay.com/v1/web/detail/video";

  const URL_RE =
    /\/(movie|show\/[-\w]+\/[-\w]+)\/([-\w]+)-([a-f0-9]{20,})(?:[?#]|$)/i;

  let lastUrl = "";
  let apiFetching = false;

  function log(...args) {
    console.log(`[Specialist][${SITE_ID}]`, ...args);
  }

  function sendToBackground(videos) {
    window.postMessage(
      {
        type: "LALHLIMPUII_JAHAU_DETECTED",
        source: SITE_ID,
        data: { videos },
      },
      "*",
    );
  }

  function parseVideoIdFromUrl(href) {
    const m = href.match(URL_RE);
    if (!m) return null;
    let type = m[1];
    if (type.startsWith("show")) type = "episode";
    return { type, displayId: m[2], id: m[3] };
  }

  async function extractViaApi() {
    if (apiFetching) return;

    const parsed = parseVideoIdFromUrl(location.href);
    if (!parsed) return;

    apiFetching = true;
    log(`API extraction: type=${parsed.type}, id=${parsed.id}`);

    try {
      const apiUrl = `${API_BASE}?type=${encodeURIComponent(parsed.type)}&id=${encodeURIComponent(parsed.id)}`;
      const resp = await fetch(apiUrl, {
        credentials: "include",
        headers: { Accept: "application/json" },
      });

      if (!resp.ok) {
        log(`API returned ${resp.status}`);
        apiFetching = false;
        return;
      }

      const json = await resp.json();
      const videos = [];
      const title = json.title || json.display || document.title;

      const stream = json.stream || {};

      const hlsPath =
        stream.thirdParty?.hlsUrl ||
        stream.hls?.high ||
        stream.hls?.medium ||
        stream.hls?.low;
      if (hlsPath) {
        const hlsUrl = hlsPath.startsWith("http")
          ? hlsPath
          : STREAM_BASE + hlsPath.replace(/^\//, "");
        videos.push({
          url: hlsUrl,
          type: "hls",
          quality: "auto",
          title,
          drm: false,
        });
      }

      const dashPath =
        stream.thirdParty?.dashUrl ||
        stream.dash?.high ||
        stream.dash?.medium ||
        stream.dash?.low;
      if (dashPath) {
        const dashUrl = dashPath.startsWith("http")
          ? dashPath
          : STREAM_BASE + dashPath.replace(/^\//, "");
        videos.push({
          url: dashUrl,
          type: "dash",
          quality: "auto",
          title,
          drm: false,
        });
      }

      const mp4Path =
        stream.thirdParty?.mp4Url ||
        stream.mp4?.high ||
        stream.mp4?.medium ||
        stream.mp4?.low;
      if (mp4Path) {
        const mp4Url = mp4Path.startsWith("http")
          ? mp4Path
          : STREAM_BASE + mp4Path.replace(/^\//, "");
        videos.push({
          url: mp4Url,
          type: "mp4",
          quality: "auto",
          title,
          drm: false,
        });
      }

      if (videos.length > 0) {
        log(`API found ${videos.length} streams`);
        sendToBackground(videos);
      } else {
        log("API response had no stream URLs, falling back to DOM scraping");
      }
    } catch (e) {
      log("API extraction error:", e.message);
    }

    apiFetching = false;
  }

  function extractFromNextData() {
    const videos = [];
    const el = document.querySelector("script#__NEXT_DATA__");
    if (!el) return videos;

    try {
      const d = JSON.parse(el.textContent);
      const pp = d?.props?.pageProps;
      if (!pp) return videos;

      const searchObj = (obj, depth) => {
        if (!obj || depth > 4) return;
        for (const [key, val] of Object.entries(obj)) {
          if (typeof val === "string" && val.length > 10) {
            if (/\.m3u8(\?|$)/i.test(val)) {
              videos.push({
                url: val,
                type: "hls",
                quality: "auto",
                title: document.title,
                drm: false,
              });
            } else if (/\.mpd(\?|$)/i.test(val)) {
              videos.push({
                url: val,
                type: "dash",
                quality: "auto",
                title: document.title,
                drm: false,
              });
            } else if (/\.mp4(\?|$)/i.test(val) && /^https?:\/\//.test(val)) {
              videos.push({
                url: val,
                type: "mp4",
                quality: "auto",
                title: document.title,
                drm: false,
              });
            }
          } else if (typeof val === "object" && val !== null) {
            searchObj(val, depth + 1);
          }
        }
      };

      searchObj(pp, 0);
    } catch {

    }
    return videos;
  }

  function extractFromVideoElements() {
    const videos = [];
    for (const video of document.querySelectorAll("video")) {
      if (video.src && video.src.startsWith("http")) {
        videos.push({
          url: video.src,
          type: "auto",
          quality: "auto",
          title: document.title,
          drm: false,
        });
      }
      for (const src of video.querySelectorAll("source")) {
        if (src.src && src.src.startsWith("http")) {
          videos.push({
            url: src.src,
            type: src.type || "auto",
            quality: "auto",
            title: document.title,
            drm: false,
          });
        }
      }
    }
    return videos;
  }

  function extractFromScripts() {
    const videos = [];
    for (const script of document.querySelectorAll(
      "script:not(#__NEXT_DATA__)",
    )) {
      const c = script.textContent || "";
      if (c.length < 20 || c.length > 500000) continue;

      const m3u8 = c.match(/["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/g);
      if (m3u8)
        for (const m of m3u8) {
          videos.push({
            url: m.slice(1, -1),
            type: "hls",
            quality: "auto",
            title: document.title,
            drm: false,
          });
        }

      const mpd = c.match(/["'](https?:\/\/[^"']+\.mpd[^"']*)["']/g);
      if (mpd)
        for (const m of mpd) {
          videos.push({
            url: m.slice(1, -1),
            type: "dash",
            quality: "auto",
            title: document.title,
            drm: false,
          });
        }

      const mp4 = c.match(/["'](https?:\/\/[^"']+\.mp4[^"']*)["']/g);
      if (mp4)
        for (const m of mp4) {
          videos.push({
            url: m.slice(1, -1),
            type: "mp4",
            quality: "auto",
            title: document.title,
            drm: false,
          });
        }
    }
    return videos;
  }

  function hookNetworkRequests() {

    const origFetch = window.fetch;
    window.fetch = function (...args) {
      const url = typeof args[0] === "string" ? args[0] : args[0]?.url;
      if (url && /\.(m3u8|mpd)(\?|$)/i.test(url)) {
        log("Fetch intercepted stream:", url);
        const type = url.includes(".m3u8") ? "hls" : "dash";
        sendToBackground([
          { url, type, quality: "auto", title: document.title, drm: false },
        ]);
      }
      return origFetch.apply(this, args);
    };

    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      if (url && typeof url === "string" && /\.(m3u8|mpd)(\?|$)/i.test(url)) {
        log("XHR intercepted stream:", url);
        const type = url.includes(".m3u8") ? "hls" : "dash";
        sendToBackground([
          { url, type, quality: "auto", title: document.title, drm: false },
        ]);
      }
      return origOpen.call(this, method, url, ...rest);
    };
  }

  function extractFallback() {
    const all = [
      ...extractFromNextData(),
      ...extractFromVideoElements(),
      ...extractFromScripts(),
    ];

    const seen = new Set();
    const unique = all.filter((v) => {
      if (seen.has(v.url)) return false;
      seen.add(v.url);
      return true;
    });

    if (unique.length > 0) {
      log(`Fallback found ${unique.length} videos`);
      sendToBackground(unique);
    }
  }

  async function runExtraction() {
    const href = location.href;
    if (href === lastUrl) return;
    lastUrl = href;

    await extractViaApi();

    extractFallback();
  }

  hookNetworkRequests();

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () =>
      setTimeout(runExtraction, 500),
    );
  } else {
    setTimeout(runExtraction, 500);
  }

  const observer = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      setTimeout(runExtraction, 500);
    }
  });
  observer.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true,
  });

  setInterval(() => {
    if (location.href !== lastUrl) runExtraction();
  }, 3000);

  log("MX Player specialist initialized (API + fallback + network hook)");
})();
