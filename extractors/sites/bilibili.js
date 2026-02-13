(function () {
  "use strict";

  const TAG = "[Bilibili]";
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

  function getVideoId() {
    const url = location.href;
    let m = url.match(/BV([a-zA-Z0-9]+)/);
    if (m) return `BV${m[1]}`;
    m = url.match(/av(\d+)/i);
    if (m) return `av${m[1]}`;
    m = url.match(/\/bangumi\/play\/(ep|ss)(\d+)/);
    if (m) return `${m[1]}${m[2]}`;
    return null;
  }

  function getPartNumber() {
    const m = location.href.match(/[?&]p=(\d+)/);
    return m ? parseInt(m[1]) : 1;
  }

  const QUALITY_MAP = {
    127: "8K 超高清",
    126: "杜比视界",
    125: "HDR 真彩",
    120: "4K 超清",
    116: "1080P 60帧",
    112: "1080P 高码率",
    80: "1080P 高清",
    74: "720P 60帧",
    64: "720P 高清",
    48: "720P (APP)",
    32: "480P 清晰",
    16: "360P 流畅",
    6: "240P 极速",
  };

  function qualityLabel(qn) {
    return QUALITY_MAP[qn] || `${qn}`;
  }

  function extractMeta() {
    const meta = {
      title: null,
      thumbnail: null,
      author: null,
      description: null,
      duration: null,
    };
    try {

      if (window.__INITIAL_STATE__) {
        const s = window.__INITIAL_STATE__;
        const vd = s.videoData || s.videoInfo;
        if (vd) {
          meta.title = vd.title;
          meta.author = vd.owner?.name;
          meta.thumbnail = vd.pic;
          meta.description = vd.desc;
          meta.duration = vd.duration;

          const pages = vd.pages;
          if (pages && pages.length > 1) {
            const p = getPartNumber();
            const page = pages[p - 1];
            if (page) meta.title = `${vd.title} - P${p} ${page.part}`;
          }
        }
      }
    } catch (e) {}

    if (!meta.title) {
      const h1 = document.querySelector("h1");
      meta.title =
        h1?.textContent?.trim() ||
        document.title.replace(/_哔哩哔哩.*/, "").trim();
    }
    if (!meta.thumbnail) {
      const ogImage = document.querySelector('meta[property="og:image"]');
      if (ogImage) meta.thumbnail = ogImage.content;
    }
    return meta;
  }

  function processPlayinfo(playinfo) {
    if (!playinfo?.data) return false;
    const data = playinfo.data;
    const dash = data.dash;

    if (!dash || !dash.video?.length) return false;

    const videoId = getVideoId();
    if (!videoId || processedIds.has(videoId)) return false;

    const meta = extractMeta();
    const videoTracks = dash.video || [];
    const audioTracks = dash.audio || [];

    videoTracks.sort(
      (a, b) => (b.id || b.quality || 0) - (a.id || a.quality || 0),
    );

    const bestAudio = audioTracks.sort(
      (a, b) => (b.bandwidth || 0) - (a.bandwidth || 0),
    )[0];

    if (videoTracks.length === 0) return false;

    const bestVideo = videoTracks[0];
    const bestUrl =
      bestVideo.baseUrl || bestVideo.base_url || bestVideo.backupUrl?.[0];

    if (!bestUrl) return false;

    processedIds.add(videoId);

    const formats = videoTracks
      .slice(1)
      .map((v) => {
        const url = v.baseUrl || v.base_url || v.backupUrl?.[0];
        const qn = v.id || v.quality;
        return {
          url: url,
          quality: qualityLabel(qn),
          qualityLabel: `${qualityLabel(qn)} (${v.width}x${v.height})`,
          mimeType: v.mimeType || v.mime_type || "video/mp4",
          width: v.width || 0,
          height: v.height || 0,
          isMuxed: false,
          isVideo: true,
          ext: "mp4",
        };
      })
      .filter((f) => f.url);

    if (bestAudio) {
      const audioUrl =
        bestAudio.baseUrl || bestAudio.base_url || bestAudio.backupUrl?.[0];
      if (audioUrl) {
        formats.push({
          url: audioUrl,
          quality: "Audio",
          qualityLabel: `Audio ${bestAudio.bandwidth ? Math.round(bestAudio.bandwidth / 1000) + "kbps" : ""}`,
          mimeType: bestAudio.mimeType || bestAudio.mime_type || "audio/mp4",
          isMuxed: false,
          isVideo: false,
          isAudio: true,
          ext: "m4a",
        });
      }
    }

    const qn = bestVideo.id || bestVideo.quality;
    notifyBackground({
      url: bestUrl,
      type: "MP4",
      options: {
        customTitle: meta.title,
        thumbnail: meta.thumbnail,
        author: meta.author,
        description: meta.description,
        duration: meta.duration || (dash.duration ? dash.duration : null),
        stableId: `bilibili_${videoId}`,
        videoId: videoId,
        platform: "bilibili",
        quality: qualityLabel(qn),
        qualityLabel: `${qualityLabel(qn)} (${bestVideo.width}x${bestVideo.height})`,
        formats: formats,
      },
    });

    detectedCount++;
    console.log(
      TAG,
      `Detected ${videoTracks.length} video + ${audioTracks.length} audio tracks for ${videoId}`,
    );
    return true;
  }

  function processDurl(playinfo) {
    if (!playinfo?.data?.durl?.length) return false;
    const videoId = getVideoId();
    if (!videoId || processedIds.has(videoId)) return false;

    const meta = extractMeta();
    const durl = playinfo.data.durl;
    const best = durl[0];

    processedIds.add(videoId);

    const formats = durl.slice(1).map((d) => ({
      url: d.url,
      quality: "Alt",
      qualityLabel: `Part ${d.order || "?"}`,
      mimeType: "video/mp4",
      isMuxed: true,
      isVideo: true,
      ext: "mp4",
    }));

    notifyBackground({
      url: best.url,
      type: best.url.includes(".flv") ? "FLV" : "MP4",
      options: {
        customTitle: meta.title,
        thumbnail: meta.thumbnail,
        author: meta.author,
        stableId: `bilibili_${videoId}`,
        videoId: videoId,
        platform: "bilibili",
        formats: formats,
      },
    });
    detectedCount++;
    return true;
  }

  function scanGlobalState() {

    try {
      if (window.__playinfo__) {
        if (processPlayinfo(window.__playinfo__)) return true;
        if (processDurl(window.__playinfo__)) return true;
      }
    } catch (e) {}
    return false;
  }

  function scanScriptTags() {
    if (detectedCount > 0) return false;
    const scripts = document.querySelectorAll("script:not([src])");
    for (const script of scripts) {
      const text = script.textContent || "";

      const piMatch = text.match(
        /__playinfo__\s*=\s*(\{[\s\S]*?\})\s*(?:;|<\/script>)/,
      );
      if (piMatch) {
        try {
          const pi = JSON.parse(piMatch[1]);
          if (processPlayinfo(pi)) return true;
          if (processDurl(pi)) return true;
        } catch (e) {}
      }

      const ssrMatch = text.match(/playurlSSRData\s*=\s*(\{[\s\S]*?\})\s*;/);
      if (ssrMatch) {
        try {
          const pi = JSON.parse(ssrMatch[1]);
          if (processPlayinfo(pi)) return true;
        } catch (e) {}
      }
    }
    return false;
  }

  function hookNetworkRequests() {
    const origFetch = window.fetch;
    window.fetch = async function (input, init) {
      const response = await origFetch.apply(this, arguments);
      try {
        const url = typeof input === "string" ? input : input?.url || "";
        if (
          url.includes("/playurl") ||
          url.includes("/player/") ||
          url.includes("pgc/player")
        ) {
          const clone = response.clone();
          clone
            .json()
            .then((data) => {
              processPlayinfo(data) || processDurl(data);
            })
            .catch(() => {});
        }
      } catch (e) {}
      return response;
    };

    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this._biliUrl = url;
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      const xhr = this;
      if ((this._biliUrl || "").match(/playurl|player|pgc\/player/)) {
        this.addEventListener("load", function () {
          try {
            const data = JSON.parse(xhr.responseText);
            processPlayinfo(data) || processDurl(data);
          } catch (e) {}
        });
      }
      return origSend.apply(this, arguments);
    };
  }

  function run() {
    scanGlobalState();
    if (detectedCount === 0) scanScriptTags();
  }

  hookNetworkRequests();
  run();
  setTimeout(run, 1500);
  setTimeout(run, 4000);
  setTimeout(run, 8000);

  let lastUrl = location.href;
  const onNav = () => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
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
