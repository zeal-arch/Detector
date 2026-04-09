(function () {
  "use strict";

  const TAG = "[Facebook]";
  const processedUrls = new Set();
  const processedIds = new Set();
  let detectedCount = 0;

  function notifyBackground(videoData) {
    window.postMessage(
      {
        type: "MAGIC_M3U8_DETECTION",
        source: "SITE_SPECIALIST",
        data: videoData,
      },
      "*",
    );
  }

  function cleanFbUrl(url) {
    if (!url || typeof url !== "string") return null;
    try {
      url = url
        .replace(/\\u0025/g, "%")
        .replace(/\\\//g, "/")
        .replace(/\\u003C/g, "<");
      url = url.replace(/&amp;/g, "&");
      if (url.startsWith("https://") || url.startsWith("http://")) return url;
    } catch (e) {}
    return null;
  }

  function getVideoId() {
    const url = location.href;
    const patterns = [
      /facebook\.com\/(?:watch|video)\/?\?v=(\d+)/,
      /facebook\.com\/(?:[^/]+\/)?videos\/(\d+)/,
      /facebook\.com\/reel\/(\d+)/,
      /facebook\.com\/(?:stories|story)\/(\d+)/,
      /fb\.watch\/([^/?]+)/,
    ];
    for (const re of patterns) {
      const m = url.match(re);
      if (m) return m[1];
    }
    return null;
  }

  function extractMetadata() {
    const meta = {
      title: null,
      thumbnail: null,
      author: null,
      description: null,
    };
    try {
      const ogTitle = document.querySelector('meta[property="og:title"]');
      if (ogTitle) meta.title = ogTitle.content;
      const ogImage = document.querySelector('meta[property="og:image"]');
      if (ogImage) meta.thumbnail = ogImage.content;
      const ogDesc = document.querySelector('meta[property="og:description"]');
      if (ogDesc) meta.description = ogDesc.content;
      if (!meta.title)
        meta.title = document.title
          .replace(/\s*[|–-]\s*Facebook.*$/i, "")
          .trim();
      if (meta.title) meta.author = meta.title.split(" - ")[0].trim();
    } catch (e) {}
    return meta;
  }

  function findVideoData(obj, results, depth) {
    if (!obj || typeof obj !== "object" || (depth || 0) > 20) return;
    const d = (depth || 0) + 1;

    if (
      typeof obj.playable_url === "string" ||
      typeof obj.browser_native_sd_url === "string"
    ) {
      const entry = {
        sd: cleanFbUrl(obj.playable_url || obj.browser_native_sd_url),
        hd: cleanFbUrl(
          obj.playable_url_quality_hd || obj.browser_native_hd_url,
        ),
        dash: cleanFbUrl(obj.dash_manifest || obj.dash_manifest_url),
        hls: cleanFbUrl(
          obj.hls_manifest || obj.hls_manifest_url || obj.playlist,
        ),
        id: obj.videoId || obj.video_id || obj.id,
        width: obj.original_width || obj.width,
        height: obj.original_height || obj.height,
        duration: obj.playable_duration_in_ms || obj.duration || null,
        title: obj.name || obj.title || null,
        thumbnail: cleanFbUrl(
          obj.preferred_thumbnail?.image?.uri ||
            obj.thumbnailImage?.uri ||
            obj.thumbnail_url ||
            obj.thumbnailUrl,
        ),
      };
      if (entry.sd || entry.hd || entry.dash || entry.hls) {
        results.push(entry);
        return;
      }
    }

    if (typeof obj.video_url === "string") {
      results.push({
        sd: cleanFbUrl(obj.video_url),
        hd: cleanFbUrl(obj.video_url_hd || obj.video_hd_url),
        id: obj.video_id || obj.id,
        title: obj.title || null,
      });
      return;
    }

    if (Array.isArray(obj)) {
      for (const item of obj) findVideoData(item, results, d);
    } else {
      for (const key of Object.keys(obj)) {
        try {
          findVideoData(obj[key], results, d);
        } catch (e) {}
      }
    }
  }

  function sendVideo(entry) {
    const url = entry.hd || entry.sd;
    if (!url) return;
    const urlKey = url.substring(0, 120);
    if (processedUrls.has(urlKey)) return;
    processedUrls.add(urlKey);

    const meta = extractMetadata();
    const videoId = entry.id || getVideoId() || `fb_${Date.now()}`;

    if (processedIds.has(videoId) && detectedCount > 0) return;
    processedIds.add(videoId);

    const isReel = location.href.includes("/reel/");

    const options = {
      customTitle:
        entry.title || meta.title || document.title.split("|")[0].trim(),
      thumbnail: entry.thumbnail || meta.thumbnail,
      stableId: `facebook_${videoId}`,
      videoId: videoId,
      author: meta.author,
      description: meta.description,
      contentType: isReel ? "reel" : "video",
      platform: "facebook",
      formats: [],
    };

    let primaryUrl = url;
    let primaryType = "MP4";
    if (entry.hls) {
      primaryUrl = entry.hls;
      primaryType = "HLS";
    } else if (entry.dash) {
      primaryUrl = entry.dash;
      primaryType = "DASH";
    }

    if (entry.hd && entry.hd !== primaryUrl) {
      options.formats.push({
        url: entry.hd,
        quality: "HD",
        qualityLabel: "HD (720p+)",
        mimeType: "video/mp4",
        isMuxed: true,
        isVideo: true,
        ext: "mp4",
      });
    }
    if (entry.sd && entry.sd !== primaryUrl && entry.sd !== entry.hd) {
      options.formats.push({
        url: entry.sd,
        quality: "SD",
        qualityLabel: "SD",
        mimeType: "video/mp4",
        isMuxed: true,
        isVideo: true,
        ext: "mp4",
      });
    }

    console.log(TAG, `Detected: ${primaryType}`, {
      videoId,
      title: options.customTitle,
      extras: options.formats.length,
    });
    notifyBackground({ url: primaryUrl, type: primaryType, options });
    detectedCount++;
  }

  function processApiResponse(data) {
    if (!data || typeof data !== "object") return;
    const results = [];
    findVideoData(data, results);
    for (const entry of results) sendVideo(entry);
  }

  function hookNetworkRequests() {

    const origFetch = window.fetch;
    window.fetch = async function (input, init) {
      const response = await origFetch.apply(this, arguments);
      try {
        const url = typeof input === "string" ? input : input?.url || "";
        if (
          url.includes("/api/graphql") ||
          url.includes("/graphql") ||
          url.includes("video")
        ) {
          const clone = response.clone();
          clone
            .text()
            .then((text) => {

              const lines = text
                .split("\n")
                .filter((l) => l.trim().startsWith("{"));
              for (const line of lines) {
                try {
                  processApiResponse(JSON.parse(line));
                } catch (e) {}
              }
            })
            .catch(() => {});
        }
      } catch (e) {}
      return response;
    };

    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this._fbUrl = url;
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      const xhr = this;
      const url = this._fbUrl || "";
      if (
        url.includes("/api/graphql") ||
        url.includes("/graphql") ||
        url.includes("video")
      ) {
        this.addEventListener("load", function () {
          try {
            const lines = xhr.responseText
              .split("\n")
              .filter((l) => l.trim().startsWith("{"));
            for (const line of lines) {
              try {
                processApiResponse(JSON.parse(line));
              } catch (e) {}
            }
          } catch (e) {}
        });
      }
      return origSend.apply(this, arguments);
    };
  }

  function scanGlobalState() {
    const results = [];
    try {
      if (window.__RELAY_STORE__) {
        for (const key in window.__RELAY_STORE__) {
          try {
            findVideoData(window.__RELAY_STORE__[key], results, 0);
          } catch (e) {}
        }
      }
    } catch (e) {}
    try {
      if (window.__comet_data__)
        findVideoData(window.__comet_data__, results, 0);
    } catch (e) {}
    try {
      if (window.__RELAY_STORE_DATA__)
        findVideoData(window.__RELAY_STORE_DATA__, results, 0);
    } catch (e) {}
    for (const entry of results) sendVideo(entry);
    return results.length > 0;
  }

  function scanScriptTags() {
    if (detectedCount > 0) return;
    const scripts = document.querySelectorAll("script:not([src])");
    for (const script of scripts) {
      const text = script.textContent || "";
      if (text.length < 100) continue;
      if (
        !text.includes("playable_url") &&
        !text.includes("browser_native") &&
        !text.includes("dash_manifest") &&
        !text.includes("video_url")
      )
        continue;

      const entry = {};
      const pats = [
        [/"playable_url_quality_hd"\s*:\s*"((?:[^"\\]|\\.)*)"/g, "hd"],
        [/"playable_url"\s*:\s*"((?:[^"\\]|\\.)*)"/g, "sd"],
        [/"browser_native_hd_url"\s*:\s*"((?:[^"\\]|\\.)*)"/g, "hd"],
        [/"browser_native_sd_url"\s*:\s*"((?:[^"\\]|\\.)*)"/g, "sd"],
        [/"dash_manifest_url"\s*:\s*"((?:[^"\\]|\\.)*)"/g, "dash"],
        [/"dash_manifest"\s*:\s*"((?:[^"\\]|\\.)*)"/g, "dash"],
        [/"hls_manifest_url"\s*:\s*"((?:[^"\\]|\\.)*)"/g, "hls"],
        [/"video_url"\s*:\s*"((?:[^"\\]|\\.)*)"/g, "sd"],
      ];
      for (const [re, key] of pats) {
        const m = re.exec(text);
        if (m && !entry[key]) entry[key] = cleanFbUrl(m[1]);
      }
      if (entry.sd || entry.hd || entry.dash || entry.hls) sendVideo(entry);
    }
  }

  function scanDom() {
    if (detectedCount > 0) return;
    const ogVideo =
      document.querySelector('meta[property="og:video"]') ||
      document.querySelector('meta[property="og:video:url"]') ||
      document.querySelector('meta[property="og:video:secure_url"]');
    if (ogVideo?.content && !ogVideo.content.includes("blob:")) {
      sendVideo({ sd: ogVideo.content });
    }
    const videos = document.querySelectorAll("video[src]");
    for (const v of videos) {
      if (v.src && !v.src.startsWith("blob:"))
        sendVideo({ sd: v.src, thumbnail: v.poster || null });
    }
  }

  function run() {
    scanGlobalState();
    if (detectedCount === 0) scanScriptTags();
    if (detectedCount === 0) scanDom();
  }

  hookNetworkRequests();
  run();
  setTimeout(run, 1000);
  setTimeout(run, 3000);
  setTimeout(run, 6000);

  let lastUrl = location.href;
  const onNav = () => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      processedUrls.clear();
      processedIds.clear();
      detectedCount = 0;
      setTimeout(run, 500);
      setTimeout(run, 2000);
    }
  };
  window.addEventListener("popstate", onNav);
  const origPush = history.pushState;
  const origReplace = history.replaceState;
  history.pushState = function () {
    origPush.apply(this, arguments);
    setTimeout(onNav, 100);
  };
  history.replaceState = function () {
    origReplace.apply(this, arguments);
    setTimeout(onNav, 100);
  };

  console.log(TAG, "v2 specialist loaded");
})();
