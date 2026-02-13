(function () {
  "use strict";

  const TAG = "[Snapchat]";
  const processedUrls = new Set();
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

    try {
      url = url.replace(/\\u002F/g, "/").replace(/\\\//g, "/");
    } catch {}

    if (!url.startsWith("http")) return null;
    return url;
  }

  function guessType(url) {
    if (!url) return "MP4";
    if (url.includes(".m3u8")) return "HLS";
    if (url.includes(".mpd")) return "DASH";
    return "MP4";
  }

  function sendVideo(url, meta) {
    url = cleanUrl(url);
    if (!url || processedUrls.has(url)) return;

    if (url.match(/\.(jpg|jpeg|png|gif|webp|svg)(\?|$)/i)) return;
    processedUrls.add(url);

    const title =
      meta?.title ||
      meta?.name ||
      document.title.replace(/\s*[-•|].*Snapchat.*$/i, "").trim() ||
      "Snapchat Video";
    const thumbnail =
      meta?.thumbnail ||
      document.querySelector('meta[property="og:image"]')?.content;

    notifyBackground({
      url: url,
      type: guessType(url),
      options: {
        customTitle: title,
        thumbnail: thumbnail,
        author: meta?.author || meta?.username || "",
        stableId: `snapchat_${url.replace(/[^a-z0-9]/gi, "").slice(-30)}`,
        videoId: meta?.id || "",
        platform: "snapchat",
        description: meta?.description || "",
      },
    });
    detectedCount++;
    console.log(TAG, `Detected: ${title.substring(0, 50)}`);
  }

  function deepSearch(obj, results, depth) {
    if (!obj || typeof obj !== "object" || (depth || 0) > 12) return;
    const d = (depth || 0) + 1;

    if (Array.isArray(obj)) {
      for (const item of obj) deepSearch(item, results, d);
      return;
    }

    const videoKeys = [
      "mediaUrl",
      "videoUrl",
      "snap_url",
      "snapUrl",
      "contentUrl",
      "media_url",
      "video_url",
      "source_url",
      "sourceUrl",
      "previewVideoUrl",
      "playbackUrl",
      "mp4Url",
      "hlsUrl",
    ];

    for (const key of videoKeys) {
      const val = obj[key];
      if (
        typeof val === "string" &&
        val.startsWith("http") &&
        (val.includes(".mp4") ||
          val.includes(".m3u8") ||
          val.includes("media") ||
          val.includes("video"))
      ) {
        const meta = {
          title: obj.title || obj.name || obj.snapTitle || obj.displayName,
          author: obj.username || obj.displayName || obj.creator,
          thumbnail:
            obj.thumbnailUrl ||
            obj.thumbnail ||
            obj.coverUrl ||
            obj.previewImageUrl,
          id: obj.id || obj.snapId || obj.storyId,
        };
        results.push({ url: val, meta });
      }
    }

    if (
      typeof obj.playlistUrl === "string" &&
      obj.playlistUrl.includes(".m3u8")
    ) {
      results.push({ url: obj.playlistUrl, meta: { title: obj.title } });
    }

    for (const key of Object.keys(obj)) {
      try {
        deepSearch(obj[key], results, d);
      } catch {}
    }
  }

  function extractFromNextData() {
    try {

      let nextData = window.__NEXT_DATA__;
      if (!nextData) {
        const el = document.getElementById("__NEXT_DATA__");
        if (el) nextData = JSON.parse(el.textContent);
      }
      if (!nextData?.props?.pageProps) return;

      const pageProps = nextData.props.pageProps;
      const results = [];
      deepSearch(pageProps, results);
      for (const { url, meta } of results) sendVideo(url, meta);

      const story = pageProps.story || pageProps.snap || pageProps.initialSnap;
      if (story?.media?.mediaUrl)
        sendVideo(story.media.mediaUrl, { title: story.title });
      if (story?.snapUrls?.mediaUrl)
        sendVideo(story.snapUrls.mediaUrl, { title: story.title });

      const snaps =
        pageProps.snaps || pageProps.spotlightSnaps || pageProps.stories;
      if (Array.isArray(snaps)) {
        for (const snap of snaps) {
          const vidUrl =
            snap.mediaUrl ||
            snap.snapUrl ||
            snap.media?.mediaUrl ||
            snap.snapUrls?.mediaUrl;
          if (vidUrl)
            sendVideo(vidUrl, {
              title: snap.title,
              author: snap.username,
              id: snap.id,
            });
        }
      }
    } catch (e) {
      console.debug(TAG, "NEXT_DATA parse error:", e.message);
    }
  }

  function scanScriptTags() {
    const scripts = document.querySelectorAll("script:not([src])");
    for (const script of scripts) {
      const text = script.textContent || "";
      if (text.length < 50 || text.length > 2_000_000) continue;

      const jsonPatterns = [
        /window\.__APOLLO_STATE__\s*=\s*({.+?});?\s*<\/script/s,
        /window\.__SNAP_STATE__\s*=\s*({.+?});?\s*<\/script/s,
        /"props"\s*:\s*\{.*"pageProps"/s,
      ];

      for (const pattern of jsonPatterns) {
        const m = text.match(pattern);
        if (m?.[1]) {
          try {
            const data = JSON.parse(m[1]);
            const results = [];
            deepSearch(data, results);
            for (const { url, meta } of results) sendVideo(url, meta);
          } catch {}
        }
      }

      const urlPatterns = [
        /"mediaUrl"\s*:\s*"([^"]+)"/g,
        /"snapUrl"\s*:\s*"([^"]+)"/g,
        /"videoUrl"\s*:\s*"([^"]+)"/g,
        /"contentUrl"\s*:\s*"([^"]+)"/g,
        /"source_url"\s*:\s*"([^"]+)"/g,
        /"mp4Url"\s*:\s*"([^"]+)"/g,
        /"hlsUrl"\s*:\s*"([^"]+\.m3u8[^"]*)"/g,
        /(https?:\/\/[^\s"']+cf\.sc-cdn\.net[^\s"']+\.(?:mp4|m3u8)[^\s"']*)/g,
      ];

      for (const pattern of urlPatterns) {
        let match;
        while ((match = pattern.exec(text)) !== null) {
          const url = match[1];
          if (url && !url.includes("preview") && !url.includes("thumbnail")) {
            sendVideo(url, {});
          }
        }
      }
    }
  }

  function extractFromLdJson() {
    const scripts = document.querySelectorAll(
      'script[type="application/ld+json"]',
    );
    for (const script of scripts) {
      try {
        const data = JSON.parse(script.textContent);
        const items = Array.isArray(data) ? data : [data];
        for (const item of items) {
          if (item["@type"] === "VideoObject") {
            const url = item.contentUrl || item.embedUrl;
            if (url) {
              sendVideo(url, {
                title: item.name || item.headline,
                description: item.description,
                thumbnail:
                  typeof item.thumbnailUrl === "string"
                    ? item.thumbnailUrl
                    : item.thumbnailUrl?.[0],
                author: item.author?.name || item.creator?.name,
              });
            }
          }
        }
      } catch {}
    }
  }

  function extractFromDom() {

    const ogVideo =
      document.querySelector('meta[property="og:video"]')?.content ||
      document.querySelector('meta[property="og:video:url"]')?.content;
    if (ogVideo) sendVideo(ogVideo, {});

    const videos = document.querySelectorAll("video");
    for (const v of videos) {
      const src = v.src || v.currentSrc;
      if (src && !src.startsWith("blob:")) sendVideo(src, {});

      for (const source of v.querySelectorAll("source")) {
        if (source.src && !source.src.startsWith("blob:"))
          sendVideo(source.src, {});
      }
    }
  }

  function hookNetworkRequests() {
    const origFetch = window.fetch;
    window.fetch = async function (input, init) {
      const response = await origFetch.apply(this, arguments);
      try {
        const url = typeof input === "string" ? input : input?.url || "";

        if (
          url.includes("snapchat.com") &&
          (url.includes("/api/") ||
            url.includes("/bolt/") ||
            url.includes("/web/") ||
            url.includes("/graphql"))
        ) {
          const clone = response.clone();
          clone
            .json()
            .then((data) => {
              const results = [];
              deepSearch(data, results);
              for (const { url: vidUrl, meta } of results)
                sendVideo(vidUrl, meta);
            })
            .catch(() => {});
        }
      } catch {}
      return response;
    };

    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__snapUrl = url;
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      if (
        this.__snapUrl &&
        typeof this.__snapUrl === "string" &&
        this.__snapUrl.includes("snapchat.com")
      ) {
        this.addEventListener("load", () => {
          try {
            const data = JSON.parse(this.responseText);
            const results = [];
            deepSearch(data, results);
            for (const { url: vidUrl, meta } of results)
              sendVideo(vidUrl, meta);
          } catch {}
        });
      }
      return origSend.apply(this, arguments);
    };
  }

  function run() {
    extractFromNextData();
    extractFromLdJson();
    scanScriptTags();
    extractFromDom();
  }

  hookNetworkRequests();
  setTimeout(run, 1500);
  setTimeout(run, 4000);

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

  const observer = new MutationObserver(() => setTimeout(run, 1500));
  observer.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true,
  });

  console.log(TAG, "v2 specialist loaded");
})();
