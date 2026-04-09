(function () {
  "use strict";

  const TAG = "[TikTok]";
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

  function cleanUrl(url) {
    if (!url || typeof url !== "string") return null;
    return url
      .replace(/\\u002F/g, "/")
      .replace(/\\\//g, "/")
      .replace(/&amp;/g, "&")
      .replace(/\\u0026/g, "&");
  }

  function extractVideoId(url) {
    let m = url.match(/\/video\/(\d+)/);
    if (m) return m[1];
    m = url.match(/\/photo\/(\d+)/);
    if (m) return m[1];
    m = url.match(/tiktok\.com\/t\/([A-Za-z0-9]+)/);
    if (m) return m[1];
    return null;
  }

  function extractUsername(url) {
    const m = url.match(/@([^/?#]+)/);
    return m ? m[1] : null;
  }

  function findVideoItems(obj, results, depth) {
    if (!obj || typeof obj !== "object" || (depth || 0) > 15) return;
    const d = (depth || 0) + 1;

    if (
      obj.video &&
      (obj.video.playAddr || obj.video.downloadAddr || obj.video.play_addr) &&
      obj.id
    ) {
      results.push(obj);
      return;
    }

    if (
      obj.aweme_id &&
      obj.video &&
      (obj.video.play_addr || obj.video.download_addr)
    ) {
      results.push(obj);
      return;
    }

    if (Array.isArray(obj)) {
      for (const item of obj) findVideoItems(item, results, d);
    } else {
      for (const key of Object.keys(obj)) {
        try {
          findVideoItems(obj[key], results, d);
        } catch (e) {}
      }
    }
  }

  function sendItem(item) {
    const video = item.video || {};
    const author = item.author || {};
    const stats = item.stats || item.statistics || {};
    const music = item.music || {};
    const videoId = item.id || item.aweme_id;

    if (!videoId || processedIds.has(videoId)) return;

    let videoUrl = null;

    if (video.downloadAddr) videoUrl = cleanUrl(video.downloadAddr);
    if (!videoUrl && video.playAddr) videoUrl = cleanUrl(video.playAddr);

    if (!videoUrl && video.download_addr?.url_list) {
      videoUrl = video.download_addr.url_list.find((u) => u) || null;
    }
    if (!videoUrl && video.play_addr?.url_list) {
      videoUrl = video.play_addr.url_list.find((u) => u) || null;
    }

    if (!videoUrl && video.bitrateInfo) {
      for (const br of video.bitrateInfo) {
        if (br.PlayAddr?.UrlList?.length) {
          videoUrl = br.PlayAddr.UrlList[0];
          break;
        }
      }
    }

    if (!videoUrl) return;

    processedIds.add(videoId);

    const thumbnail =
      video.cover ||
      video.originCover ||
      video.dynamicCover ||
      (video.cover_url?.url_list ? video.cover_url.url_list[0] : null);

    const username =
      author.uniqueId || author.unique_id || extractUsername(location.href);
    const desc = item.desc || item.description || "";
    const title =
      desc.substring(0, 100) || `TikTok by @${username || "unknown"}`;

    const options = {
      customTitle: title,
      description: desc,
      thumbnail: thumbnail,
      stableId: `tiktok_${videoId}`,
      videoId: videoId,
      platform: "tiktok",
      author: username,
      duration: video.duration,
      width: video.width || video.video_width,
      height: video.height || video.video_height,
      viewCount: stats.playCount || stats.play_count,
      likeCount: stats.diggCount || stats.digg_count,
      commentCount: stats.commentCount || stats.comment_count,
    };

    console.log(TAG, `Detected video ${videoId}:`, title.substring(0, 60));
    notifyBackground({ url: videoUrl, type: "MP4", options });
    detectedCount++;
  }

  function extractFromHydration() {

    try {
      const data = window.__UNIVERSAL_DATA_FOR_REHYDRATION__;
      if (data) {
        const scope = data.__DEFAULT_SCOPE__ || data;
        const detail =
          scope["webapp.video-detail"] || scope["webapp.video.detail"];
        if (detail?.itemInfo?.itemStruct) {
          sendItem(detail.itemInfo.itemStruct);
          return true;
        }

        if (detail?.itemStruct) {
          sendItem(detail.itemStruct);
          return true;
        }

        const results = [];
        findVideoItems(data, results);
        if (results.length > 0) {
          for (const item of results) sendItem(item);
          return true;
        }
      }
    } catch (e) {
      console.debug(TAG, "Hydration error:", e.message);
    }

    try {
      const state = window.SIGI_STATE;
      if (state?.ItemModule) {
        const items = Object.values(state.ItemModule);
        for (const item of items) sendItem(item);
        if (items.length > 0) return true;
      }
    } catch (e) {}

    try {
      const el = document.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__");
      if (el) {
        const data = JSON.parse(el.textContent);
        const results = [];
        findVideoItems(data, results);
        for (const item of results) sendItem(item);
        if (results.length > 0) return true;
      }
    } catch (e) {}

    try {
      const nextEl = document.getElementById("__NEXT_DATA__");
      if (nextEl) {
        const data = JSON.parse(nextEl.textContent);
        const results = [];
        findVideoItems(data, results);
        for (const item of results) sendItem(item);
        if (results.length > 0) return true;
      }
    } catch (e) {}

    return false;
  }

  function extractFromScripts() {
    if (detectedCount > 0) return;
    const scripts = document.querySelectorAll("script:not([src])");
    for (const script of scripts) {
      const text = script.textContent || "";
      if (text.length < 200) continue;
      if (
        !text.includes("playAddr") &&
        !text.includes("play_addr") &&
        !text.includes("downloadAddr")
      )
        continue;

      try {
        const results = [];

        const jsonMatch = text.match(
          /\{[^]*"video"\s*:\s*\{[^]*"playAddr"[^]*\}/,
        );
        if (jsonMatch) {
          const data = JSON.parse(jsonMatch[0]);
          findVideoItems(data, results);
          for (const item of results) sendItem(item);
        }
      } catch (e) {}

      const addrMatch = text.match(
        /"(?:downloadAddr|playAddr|play_addr)"\s*:\s*"(https?:[^"]+)"/,
      );
      if (addrMatch && detectedCount === 0) {
        const url = cleanUrl(addrMatch[1]);
        if (url) {
          const videoId = extractVideoId(location.href) || `tt_${Date.now()}`;
          if (!processedIds.has(videoId)) {
            processedIds.add(videoId);
            notifyBackground({
              url: url,
              type: "MP4",
              options: {
                customTitle: document.title.replace(/ \| TikTok$/i, "").trim(),
                stableId: `tiktok_${videoId}`,
                videoId: videoId,
                platform: "tiktok",
                thumbnail: document.querySelector('meta[property="og:image"]')
                  ?.content,
              },
            });
            detectedCount++;
          }
        }
      }
    }
  }

  function processApiData(data) {
    if (!data || typeof data !== "object") return;
    const results = [];
    findVideoItems(data, results);
    for (const item of results) sendItem(item);
  }

  function hookNetworkRequests() {
    const origFetch = window.fetch;
    window.fetch = async function (input, init) {
      const response = await origFetch.apply(this, arguments);
      try {
        const url = typeof input === "string" ? input : input?.url || "";

        if (
          url.includes("/api/") ||
          url.includes("/item/detail") ||
          url.includes("/aweme/") ||
          url.includes("/web/")
        ) {
          const clone = response.clone();
          clone
            .json()
            .then((data) => processApiData(data))
            .catch(() => {});
        }
      } catch (e) {}
      return response;
    };

    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this._ttUrl = url;
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      const xhr = this;
      const url = this._ttUrl || "";
      if (
        url.includes("/api/") ||
        url.includes("/item/detail") ||
        url.includes("/aweme/")
      ) {
        this.addEventListener("load", function () {
          try {
            processApiData(JSON.parse(xhr.responseText));
          } catch (e) {}
        });
      }
      return origSend.apply(this, arguments);
    };
  }

  function extractFromVideoEl() {
    if (detectedCount > 0) return;
    const videoEl = document.querySelector("video");
    if (videoEl?.src && !videoEl.src.startsWith("blob:")) {
      const videoId = extractVideoId(location.href) || `tt_${Date.now()}`;
      if (!processedIds.has(videoId)) {
        processedIds.add(videoId);
        notifyBackground({
          url: videoEl.src,
          type: "MP4",
          options: {
            customTitle: document.title.replace(/ \| TikTok$/i, "").trim(),
            stableId: `tiktok_${videoId}`,
            videoId: videoId,
            platform: "tiktok",
            thumbnail: document.querySelector('meta[property="og:image"]')
              ?.content,
          },
        });
        detectedCount++;
      }
    }
  }

  function run() {
    extractFromHydration();
    if (detectedCount === 0) extractFromScripts();
    if (detectedCount === 0) extractFromVideoEl();
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
      detectedCount = 0;
      processedIds.clear();
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
