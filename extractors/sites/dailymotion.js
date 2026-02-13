(function () {
  "use strict";

  console.log("[Dailymotion Specialist] Loaded on:", window.location.href);

  const processedVideos = new Set();
  let lastUrl = window.location.href;

  function notifyBackground(data) {
    window.postMessage(
      {
        type: "MAGIC_M3U8_DETECTION",
        source: "SITE_SPECIALIST",
        data,
      },
      "*",
    );
    window.__SPECIALIST_DETECTED = true;
  }

  function extractVideoId(url) {

    const m = url.match(
      /(?:dailymotion\.com\/(?:embed\/)?video\/|dai\.ly\/)([a-zA-Z0-9]+)/,
    );
    return m ? m[1] : null;
  }

  function parseResolution(url) {

    const m = url.match(/\/H264-(\d+)x(\d+)(?:-(\d+))?/);
    if (m) {
      return {
        width: parseInt(m[1]),
        height: parseInt(m[2]),
        fps: m[3] ? parseInt(m[3]) : 30,
      };
    }
    return { width: 0, height: 0, fps: 30 };
  }

  async function buildFormats(qualities) {
    const formats = [];
    const seenUrls = new Set();

    const qualityKeys = Object.keys(qualities)
      .filter((k) => k !== "auto")
      .sort((a, b) => parseInt(b) - parseInt(a));

    for (const qKey of qualityKeys) {
      const streams = qualities[qKey];
      if (!Array.isArray(streams)) continue;

      let progressive = null;
      let hls = null;

      for (const s of streams) {
        if (!s.url) continue;
        const type = (s.type || "").toLowerCase();
        if (
          type === "video/mp4" ||
          type === "video/webm" ||
          (!type.includes("mpegurl") &&
            !type.includes("lumberjack") &&
            s.url.includes("/H264-"))
        ) {
          progressive = s;
        } else if (
          type === "application/x-mpegurl" ||
          type === "application/vnd.apple.mpegurl"
        ) {
          hls = s;
        }
      }

      const chosen = progressive || hls;
      if (!chosen || !chosen.url) continue;

      const cleanUrl = chosen.url.split("#")[0];
      if (seenUrls.has(cleanUrl)) continue;
      seenUrls.add(cleanUrl);

      const res = parseResolution(cleanUrl);
      const height = res.height || parseInt(qKey) || 0;
      const isProgressive = chosen === progressive;

      formats.push({
        url: cleanUrl,
        quality: `${height}p`,
        qualityLabel: `${height}p${res.fps > 30 ? ` ${res.fps}fps` : ""}`,
        mimeType: isProgressive ? "video/mp4" : "application/x-mpegurl",
        width: res.width || 0,
        height: height,
        isVideo: true,
        isMuxed: true,
        ext: "mp4",
        isHLS: !isProgressive,
      });
    }

    if (formats.length === 0 && qualities["auto"]) {
      let autoHlsUrl = null;
      for (const s of qualities["auto"]) {
        if (!s.url) continue;
        const type = (s.type || "").toLowerCase();
        if (type.includes("mpegurl") || type.includes("apple")) {
          autoHlsUrl = s.url.split("#")[0];
          break;
        }
      }

      if (autoHlsUrl) {

        try {
          const hlsResp = await fetch(autoHlsUrl);
          if (hlsResp.ok) {
            const hlsText = await hlsResp.text();
            const hlsFormats = parseHLSMaster(hlsText, autoHlsUrl);
            if (hlsFormats.length > 0) {
              return hlsFormats;
            }
          }
        } catch (e) {
          console.debug("[Dailymotion] HLS master parse failed:", e);
        }

        formats.push({
          url: autoHlsUrl,
          quality: "auto",
          qualityLabel: "Auto (HLS → MP4)",
          mimeType: "application/x-mpegurl",
          width: 0,
          height: 0,
          isVideo: true,
          isMuxed: true,
          ext: "mp4",
          isHLS: true,
        });
      }
    }

    return formats;
  }

  function parseHLSMaster(text, masterUrl) {
    const formats = [];
    const lines = text.split("\n");
    const baseUrl = masterUrl.substring(0, masterUrl.lastIndexOf("/") + 1);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line.startsWith("#EXT-X-STREAM-INF:")) continue;

      const resMatch = line.match(/RESOLUTION=(\d+)x(\d+)/);
      const bwMatch = line.match(/BANDWIDTH=(\d+)/);
      const fpsMatch = line.match(/FRAME-RATE=([\d.]+)/);

      let variantUrl = "";
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j].trim();
        if (next && !next.startsWith("#")) {
          variantUrl = next;
          break;
        }
      }
      if (!variantUrl) continue;

      if (!variantUrl.startsWith("http")) {
        variantUrl = variantUrl.startsWith("/")
          ? new URL(masterUrl).origin + variantUrl
          : baseUrl + variantUrl;
      }

      const width = resMatch ? parseInt(resMatch[1]) : 0;
      const height = resMatch ? parseInt(resMatch[2]) : 0;
      const fps = fpsMatch ? parseFloat(fpsMatch[1]) : 30;

      formats.push({
        url: variantUrl,
        quality: height ? `${height}p` : "auto",
        qualityLabel: height
          ? `${height}p${fps > 30 ? ` ${Math.round(fps)}fps` : ""}`
          : "auto",
        mimeType: "application/x-mpegurl",
        width,
        height,
        isVideo: true,
        isMuxed: true,
        ext: "mp4",
        isHLS: true,
      });
    }

    formats.sort((a, b) => (b.height || 0) - (a.height || 0));
    return formats;
  }

  function sendFormats(videoId, meta, formats) {
    if (formats.length === 0) return false;

    const owner = meta.owner || {};
    const posters = meta.posters || {};
    const thumbnail =
      posters["1080"] ||
      posters["720"] ||
      posters["480"] ||
      posters["360"] ||
      meta.thumbnail_url ||
      "";

    const best = formats.find((f) => f.ext === "mp4") || formats[0];

    notifyBackground({
      url: best.url,
      type: best.ext === "mp4" ? "MP4" : "HLS",
      videoId: videoId,
      options: {
        customTitle: meta.title || "Dailymotion Video",
        author: owner.screenname || owner.username || "",
        authorUrl: owner.url || null,
        thumbnail: thumbnail,
        duration: meta.duration || 0,
        quality: best.quality,
        platform: "dailymotion",
        pageUrl: window.location.href,
        formats: formats,
      },
    });

    console.log(
      `[Dailymotion] Sent ${formats.length} formats for "${meta.title}"`,
    );
    return true;
  }

  async function extractVideo() {
    const videoId = extractVideoId(window.location.href);
    if (!videoId) {
      console.log("[Dailymotion] No video ID in URL");
      return;
    }

    if (processedVideos.has(videoId)) {
      console.log("[Dailymotion] Already processed:", videoId);
      return;
    }
    processedVideos.add(videoId);

    try {

      const metaUrl = `https://www.dailymotion.com/player/metadata/video/${videoId}?app=com.dailymotion.neon`;
      const resp = await fetch(metaUrl, {
        credentials: "include",
        headers: { Accept: "application/json" },
      });

      if (!resp.ok) {
        console.warn("[Dailymotion] Metadata fetch failed:", resp.status);
        await extractFromPage(videoId);
        return;
      }

      const meta = await resp.json();

      if (meta.error) {
        console.warn(
          "[Dailymotion] API error:",
          meta.error.title || meta.error.raw_message,
        );
        await extractFromPage(videoId);
        return;
      }

      const formats = await buildFormats(meta.qualities || {});

      if (formats.length === 0) {
        console.warn("[Dailymotion] No formats extracted from metadata");
        await extractFromPage(videoId);
        return;
      }

      sendFormats(videoId, meta, formats);
    } catch (err) {
      console.error("[Dailymotion] Extraction error:", err);
      await extractFromPage(videoId);
    }
  }

  async function extractFromPage(videoId) {
    if (processedVideos.has(videoId + "_page")) return;
    processedVideos.add(videoId + "_page");

    try {

      if (window.__PLAYER_CONFIG__) {
        const config = window.__PLAYER_CONFIG__;
        const metadata = config.metadata || {};
        const qualities = metadata.qualities || {};
        const formats = await buildFormats(qualities);

        if (formats.length > 0) {
          const meta = {
            title: metadata.title || "Video",
            owner: { username: metadata.owner?.username || "" },
            posters: {},
            thumbnail_url:
              metadata.posters?.[0]?.url || metadata.thumbnail_url || "",
            duration: metadata.duration || 0,
          };
          sendFormats(videoId, meta, formats);
          console.log(
            `[Dailymotion] Fallback: ${formats.length} formats from __PLAYER_CONFIG__`,
          );
          return;
        }
      }

      const scripts = document.querySelectorAll(
        'script[type="application/ld+json"]',
      );
      for (const script of scripts) {
        try {
          const data = JSON.parse(script.textContent);
          if (data["@type"] === "VideoObject" && data.contentUrl) {
            notifyBackground({
              url: data.contentUrl,
              type: "MP4",
              videoId: videoId,
              options: {
                customTitle: data.name || "Video",
                author: data.author?.name || "",
                thumbnail: data.thumbnailUrl || "",
                duration: parseDuration(data.duration) || 0,
                platform: "dailymotion",
                pageUrl: window.location.href,
              },
            });
            console.log("[Dailymotion] Fallback: extracted from JSON-LD");
            return;
          }
        } catch {

        }
      }

      console.warn("[Dailymotion] All extraction methods failed");
    } catch (err) {
      console.error("[Dailymotion] Page fallback error:", err);
    }
  }

  function hookFetch() {
    const origFetch = window.fetch;
    window.fetch = async function (...args) {
      const resp = await origFetch.apply(this, args);
      try {
        const url =
          typeof args[0] === "string"
            ? args[0]
            : args[0]?.url || args[0]?.href || "";
        if (url.includes("/player/metadata/video/")) {
          const clone = resp.clone();
          clone
            .json()
            .then((data) => processInterceptedMetadata(data))
            .catch(() => {});
        }
      } catch {

      }
      return resp;
    };
  }

  function hookXHR() {
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this._dmUrl = typeof url === "string" ? url : url?.toString?.() || "";
      return origOpen.call(this, method, url, ...rest);
    };

    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (...args) {
      if (this._dmUrl?.includes("/player/metadata/video/")) {
        this.addEventListener("load", function () {
          try {
            const data = JSON.parse(this.responseText);
            processInterceptedMetadata(data);
          } catch {

          }
        });
      }
      return origSend.apply(this, args);
    };
  }

  function processInterceptedMetadata(meta) {
    if (!meta || meta.error || !meta.qualities) return;

    const videoId =
      meta.id ||
      extractVideoId(meta.url || window.location.href) ||
      `dm_${Date.now()}`;

    if (processedVideos.has(videoId)) return;
    processedVideos.add(videoId);

    const formats = await buildFormats(meta.qualities);
    sendFormats(videoId, meta, formats);
  }

  function parseDuration(iso) {
    if (!iso) return null;
    const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (!m) return null;
    return (
      parseInt(m[1] || 0) * 3600 +
      parseInt(m[2] || 0) * 60 +
      parseInt(m[3] || 0)
    );
  }

  window.__SPECIALIST_DETECTED = false;

  hookFetch();
  hookXHR();

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      setTimeout(extractVideo, 300);
    });
  } else {
    setTimeout(extractVideo, 200);
  }

  setTimeout(extractVideo, 1500);

  const origPush = history.pushState;
  const origReplace = history.replaceState;

  history.pushState = function (...args) {
    origPush.apply(this, args);
    setTimeout(onNav, 200);
  };
  history.replaceState = function (...args) {
    origReplace.apply(this, args);
    setTimeout(onNav, 200);
  };
  window.addEventListener("popstate", () => setTimeout(onNav, 200));

  function onNav() {
    const currentUrl = window.location.href;
    if (currentUrl !== lastUrl) {
      lastUrl = currentUrl;
      processedVideos.clear();
      setTimeout(extractVideo, 300);
    }
  }

  new MutationObserver(() => {
    if (window.location.href !== lastUrl) {
      onNav();
    }
  }).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  console.log("[Dailymotion Specialist v2] Initialized");
})();
