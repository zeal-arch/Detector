(function () {
  "use strict";

  const SITE_ID = "popcornmovies";

  if (window.__SITE_SPECIALIST_LOADED === SITE_ID) return;
  window.__SITE_SPECIALIST_LOADED = SITE_ID;

  const processedUrls = new Set();
  let detectionTimeout = null;

  function log(...args) {
    console.log(`[Specialist][${SITE_ID}]`, ...args);
  }

  function cleanTitle() {
    return (
      document.title
        .replace(/\s*[-–|]?\s*(PopcornMovies|Popcorn\s*Movies).*$/i, "")
        .replace(/Watch\s+(Online\s+)?Free\s*(HD)?\s*[-–|]?\s*/i, "")
        .replace(/\s*Free\s*Online\s*/i, "")
        .replace(/\s*Online\s*Free\s*/i, "")
        .trim() || document.title
    );
  }

  function getThumbnail() {
    const ogImage = document.querySelector('meta[property="og:image"]');
    if (ogImage) return ogImage.getAttribute("content");
    const poster = document.querySelector(
      ".poster img, .movie-poster img, .detail-poster img, img.poster",
    );
    if (poster) return poster.src || poster.getAttribute("data-src");
    return null;
  }

  // Known proxy/CDN domains used by pirated streaming sites
  const PROXY_DOMAINS = [
    "vodvidl.site",
    "videostr.net",
    "aurorabird",
    "rabbitstream",
    "megacloud",
    "vidplay",
    "filemoon",
    "streamtape",
    "doodstream",
    "mixdrop",
    "upstream",
    "vidcloud",
    "dokicloud",
    "rapid-cloud",
    "vidstreaming",
    "gogo-stream",
    "gogocdn",
    "sbplay",
    "fembed",
    "streamlare",
    "streamsb",
    "mp4upload",
    "streamhub",
    "trueparadise.workers.dev",
    "tigerflare",
    "videasy.net",
    "player.videasy.net",
  ];

  function safeDecodeURIComponent(str) {
    try {
      return decodeURIComponent(str);
    } catch (e) {
      return str;
    }
  }

  function isVideoUrl(url) {
    if (!url || typeof url !== "string") return false;
    // Standard extensions
    if (/\.(m3u8|mpd|mp4|webm|mkv)(\?|#|$)/i.test(url)) return true;
    // URL-encoded .m3u8 in proxy URLs (e.g., cGxheWxpc3QubTN1OA== is base64 for playlist.m3u8)
    if (/\.m3u8/i.test(safeDecodeURIComponent(url))) return true;
    // Proxy URLs that contain encoded m3u8 paths
    if (/m3u8|mpegurl/i.test(url)) return true;
    // Known proxy domain patterns serving video
    if (
      PROXY_DOMAINS.some((d) => url.includes(d)) &&
      /proxy|stream|video|play|embed/i.test(url)
    )
      return true;
    return false;
  }

  function getVideoType(url) {
    if (/\.m3u8(\?|#|$)/i.test(url)) return "hls";
    if (/\.mpd(\?|#|$)/i.test(url)) return "dash";
    if (/\.mp4(\?|#|$)/i.test(url)) return "mp4";
    if (/\.webm(\?|#|$)/i.test(url)) return "webm";
    return "unknown";
  }

  function isAdUrl(url) {
    const adPatterns = [
      "googleads",
      "doubleclick",
      "googlesyndication",
      "analytics",
      "tracking",
      "breedsmuteexams",
      "onesignal",
      "googletagmanager",
      "adserver",
      "adservice",
      "popunder",
      "popads",
      "clicktrack",
      "banner",
      "advertisement",
      "/ads/",
      "adsense",
    ];
    const lowerUrl = url.toLowerCase();
    return adPatterns.some((p) => lowerUrl.includes(p));
  }

  /**
   * Send detected video via MAGIC_M3U8_DETECTION protocol
   */
  function notifyVideoMagic(videoData) {
    const urlKey = videoData.url.substring(0, 150);
    if (processedUrls.has(urlKey)) return;
    processedUrls.add(urlKey);

    window.postMessage(
      {
        type: "MAGIC_M3U8_DETECTION",
        source: "SITE_SPECIALIST",
        data: {
          url: videoData.url,
          type: videoData.type || "HLS",
          options: {
            customTitle: videoData.title || cleanTitle(),
            thumbnail: videoData.thumbnail || getThumbnail(),
            quality: videoData.quality || "auto",
            pageUrl: window.location.href,
            detectionSource: "popcornmovies-specialist",
          },
        },
      },
      "*",
    );

    log("Video detected (MAGIC):", videoData.url.substring(0, 80));
  }

  /**
   * Send detected video via LALHLIMPUII_JAHAU protocol
   */
  function notifyVideoLAL(videos) {
    window.postMessage(
      {
        type: "LALHLIMPUII_JAHAU_DETECTED",
        source: SITE_ID,
        data: { videos },
      },
      "*",
    );
    log(`Sent ${videos.length} video(s) via LAL protocol`);
  }

  /**
   * Notify through both protocols for maximum compatibility
   */
  function notifyVideo(videoData) {
    notifyVideoMagic(videoData);
    notifyVideoLAL([
      {
        url: videoData.url,
        type: videoData.type || "hls",
        quality: videoData.quality || "auto",
        title: videoData.title || cleanTitle(),
      },
    ]);
  }

  // Maximum response size (in bytes) to inspect — skip larger payloads
  // to avoid stalling on video segments or large binary responses.
  const MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2 MB

  // ========== XHR Interception ==========
  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...args) {
    this._pcmRequestUrl = typeof url === "string" ? url : url?.toString();
    return originalXHROpen.call(this, method, url, ...args);
  };

  XMLHttpRequest.prototype.send = function (body) {
    this.addEventListener("load", function () {
      try {
        const reqUrl = this._pcmRequestUrl || "";

        // Check if XHR URL itself is a video URL
        if (isVideoUrl(reqUrl) && !isAdUrl(reqUrl)) {
          notifyVideo({
            url: reqUrl,
            type: getVideoType(reqUrl),
            title: cleanTitle(),
          });
        }

        // Skip large responses to avoid memory issues (e.g., video segments)
        const contentLength = parseInt(
          this.getResponseHeader("content-length") || "0",
          10,
        );
        if (contentLength > MAX_RESPONSE_BYTES) return;

        const response = this.responseText;
        if (!response || typeof response !== "string") return;

        // Also guard by actual string length in case Content-Length was absent
        if (response.length > MAX_RESPONSE_BYTES) return;

        // Search for m3u8/mpd/mp4 URLs in the response
        extractUrlsFromText(response);

        // Try to parse JSON responses from API calls
        if (response.startsWith("{") || response.startsWith("[")) {
          try {
            const json = JSON.parse(response);
            extractFromJsonObject(json);
          } catch {
            /* not valid JSON */
          }
        }
      } catch (e) {
        log("XHR intercept error:", e.message);
      }
    });
    return originalXHRSend.call(this, body);
  };

  // ========== Fetch Interception ==========
  const originalFetch = window.fetch;
  window.fetch = async function (input, init) {
    const response = await originalFetch.call(this, input, init);

    try {
      const url = typeof input === "string" ? input : input?.url;

      // Check if the fetch URL itself is a video
      if (url && isVideoUrl(url) && !isAdUrl(url)) {
        notifyVideo({
          url: url,
          type: getVideoType(url),
          title: cleanTitle(),
        });
      }

      // Skip large responses to avoid OOM on video segments
      const contentLength = parseInt(
        response.headers.get("content-length") || "0",
        10,
      );
      if (contentLength > MAX_RESPONSE_BYTES) {
        return response;
      }

      // Clone and analyze the response body
      const cloned = response.clone();
      cloned
        .text()
        .then((text) => {
          if (!text) return;
          extractUrlsFromText(text);

          if (text.startsWith("{") || text.startsWith("[")) {
            try {
              const json = JSON.parse(text);
              extractFromJsonObject(json);
            } catch {
              /* not valid JSON */
            }
          }
        })
        .catch(() => {});
    } catch (e) {
      log("Fetch intercept error:", e.message);
    }

    return response;
  };

  // ========== Server Tab Detection ==========

  /**
   * Detect and report available server tabs (PopCorn, Viper, 4K Astra, etc.)
   */
  function scanServerTabs() {
    // Look for server selection buttons/tabs on the page
    const serverSelectors = [
      ".server-item",
      ".server-btn",
      "[data-server]",
      "[data-embed]",
      ".tab-server",
      ".source-btn",
      ".server-select a",
      ".server-select button",
      ".sources-list a",
      ".sources-list button",
      ".player-servers a",
      ".player-servers button",
      ".server-list a",
      ".server-list button",
      "a[data-id][data-type]",
      "a[data-linkid]",
      ".nav-server-list a",
    ];

    const servers = [];
    for (const selector of serverSelectors) {
      const elements = document.querySelectorAll(selector);
      for (const el of elements) {
        const name = el.textContent?.trim();
        const embedUrl =
          el.getAttribute("data-embed") ||
          el.getAttribute("data-src") ||
          el.getAttribute("data-url") ||
          el.getAttribute("href");
        const serverId =
          el.getAttribute("data-id") || el.getAttribute("data-server");
        if (name || embedUrl) {
          servers.push({ name, embedUrl, serverId, element: el });
        }
      }
    }

    if (servers.length > 0) {
      log(
        `Found ${servers.length} server tabs:`,
        servers.map((s) => s.name).join(", "),
      );
    }
    return servers;
  }

  // ========== URL Extraction Helpers ==========

  /**
   * Extract video URLs from raw text (HTML, JSON string, etc.)
   */
  function extractUrlsFromText(text) {
    // m3u8 patterns — including proxy/encoded URLs
    const m3u8Patterns = [
      /(https?:\/\/[^"'\s<>\\\]]+\.m3u8(?:\?[^"'\s<>\\\]]*)?)/gi,
      /(https?:\/\/[^"'\s<>\\\]]+master\.m3u8(?:\?[^"'\s<>\\\]]*)?)/gi,
      /(https?:\/\/[^"'\s<>\\\]]+index\.m3u8(?:\?[^"'\s<>\\\]]*)?)/gi,
      // Proxy m3u8 URLs (encoded path with .m3u8 or m3u8 in base64)
      /(https?:\/\/[^"'\s<>\\\]]*vodvidl\.site[^"'\s<>\\\]]*)/gi,
      /(https?:\/\/[^"'\s<>\\\]]*\/proxy\/[^"'\s<>\\\]]*m3u8[^"'\s<>\\\]]*)/gi,
    ];

    for (const pattern of m3u8Patterns) {
      const matches = [...text.matchAll(pattern)];
      for (const match of matches) {
        const url = match[1].replace(/\\+/g, "");
        if (!isAdUrl(url)) {
          notifyVideo({ url, type: "hls", title: cleanTitle() });
        }
      }
    }

    // MPD patterns
    const mpdMatches = [
      ...text.matchAll(
        /(https?:\/\/[^"'\s<>\\\]]+\.mpd(?:\?[^"'\s<>\\\]]*)?)/gi,
      ),
    ];
    for (const match of mpdMatches) {
      const url = match[1].replace(/\\+/g, "");
      if (!isAdUrl(url)) {
        notifyVideo({ url, type: "dash", title: cleanTitle() });
      }
    }

    // Direct MP4/WebM patterns (only from CDN/media domains)
    const directMatches = [
      ...text.matchAll(
        /(https?:\/\/[^"'\s<>\\\]]+\.(mp4|webm)(?:\?[^"'\s<>\\\]]*)?)/gi,
      ),
    ];
    for (const match of directMatches) {
      const url = match[1].replace(/\\+/g, "");
      if (
        !isAdUrl(url) &&
        /cdn|media|stream|video|content|storage|cloud/i.test(url)
      ) {
        notifyVideo({ url, type: getVideoType(url), title: cleanTitle() });
      }
    }
  }

  /**
   * Recursively search JSON objects for video URLs
   */
  function extractFromJsonObject(obj, depth = 0) {
    if (depth > 8 || !obj) return;

    if (typeof obj === "string") {
      if (isVideoUrl(obj) && !isAdUrl(obj)) {
        notifyVideo({ url: obj, type: getVideoType(obj), title: cleanTitle() });
      }
      return;
    }

    if (Array.isArray(obj)) {
      for (const item of obj) {
        extractFromJsonObject(item, depth + 1);
      }
      return;
    }

    if (typeof obj === "object") {
      // Look for known video source property names
      const videoKeys = [
        "url",
        "src",
        "source",
        "file",
        "stream",
        "video_url",
        "videoUrl",
        "video_src",
        "videoSrc",
        "manifest",
        "playlist",
        "hls",
        "dash",
        "mp4",
        "stream_url",
        "streamUrl",
        "content_url",
        "contentUrl",
        "embed_url",
        "embedUrl",
        "link",
        "sources",
        "qualities",
        "video",
      ];

      for (const [key, value] of Object.entries(obj)) {
        if (typeof value === "string" && isVideoUrl(value) && !isAdUrl(value)) {
          const quality =
            obj.quality || obj.label || obj.resolution || obj.name || "auto";
          notifyVideo({
            url: value,
            type: getVideoType(value),
            quality: String(quality),
            title: obj.title || obj.name || cleanTitle(),
          });
        } else if (typeof value === "object" && value !== null) {
          extractFromJsonObject(value, depth + 1);
        }
      }
    }
  }

  // ========== DOM Scanning ==========

  /**
   * Scan all <script> tags for embedded video URLs
   */
  function scanScriptTags() {
    const scripts = document.querySelectorAll("script:not([src])");
    for (const script of scripts) {
      const content = script.textContent || "";
      if (content.length < 10) continue;
      if (content.length > 500000) continue; // skip very large scripts

      extractUrlsFromText(content);

      // Look for common player initialization patterns
      const playerPatterns = [
        // JWPlayer
        /jwplayer\s*\([^)]*\)\s*\.setup\s*\(\s*({[\s\S]*?})\s*\)/i,
        // Video.js
        /videojs\s*\([^,]+,\s*({[\s\S]*?})\s*\)/i,
        // Plyr
        /new\s+Plyr\s*\([^,]+,\s*({[\s\S]*?})\s*\)/i,
        // Generic player config
        /(?:player|video)(?:Config|Options|Settings|Data)\s*[=:]\s*({[\s\S]*?});/i,
        // Source arrays
        /sources?\s*[=:]\s*(\[[\s\S]*?\])/i,
      ];

      for (const pattern of playerPatterns) {
        const match = content.match(pattern);
        if (match) {
          try {
            // Try to extract URLs from matched config
            const configText = match[1];
            extractUrlsFromText(configText);
            // Attempt JSON parse for structured data
            const cleaned = configText
              .replace(/'/g, '"')
              .replace(/(\w+)\s*:/g, '"$1":')
              .replace(/,\s*([}\]])/g, "$1");
            try {
              const parsed = JSON.parse(cleaned);
              extractFromJsonObject(parsed);
            } catch {
              /* not valid JSON after cleanup */
            }
          } catch {
            /* parsing failed */
          }
        }
      }
    }
  }

  /**
   * Scan <video> and <source> elements
   */
  function scanVideoElements() {
    const videos = document.querySelectorAll("video");
    for (const video of videos) {
      const src = video.src || video.currentSrc;
      if (src && !src.startsWith("blob:") && isVideoUrl(src) && !isAdUrl(src)) {
        notifyVideo({
          url: src,
          type: getVideoType(src),
          title: cleanTitle(),
        });
      }

      // Check <source> children
      const sources = video.querySelectorAll("source");
      for (const source of sources) {
        const srcUrl = source.src || source.getAttribute("src");
        if (
          srcUrl &&
          !srcUrl.startsWith("blob:") &&
          isVideoUrl(srcUrl) &&
          !isAdUrl(srcUrl)
        ) {
          notifyVideo({
            url: srcUrl,
            type: getVideoType(srcUrl),
            quality:
              source.getAttribute("label") ||
              source.getAttribute("size") ||
              "auto",
            title: cleanTitle(),
          });
        }
      }
    }
  }

  /**
   * Scan <iframe> elements for known embed players
   */
  function scanIframes() {
    const iframes = document.querySelectorAll("iframe");
    for (const iframe of iframes) {
      const src =
        iframe.src ||
        iframe.getAttribute("data-src") ||
        iframe.getAttribute("data-lazy-src");
      if (!src) continue;

      // Known video embed domains
      const embedDomains = [
        "vidsrc",
        "vidplay",
        "filemoon",
        "streamtape",
        "doodstream",
        "mixdrop",
        "upstream",
        "vidcloud",
        "rabbitstream",
        "megacloud",
        "superembed",
        "embedsu",
        "2embed",
        "autoembed",
        "vidsrc.to",
        "vidsrc.me",
        "vidsrc.cc",
        "multiembed",
        "moviesapi",
        "vidlink",
        "embedsito",
        "videasy.net",
        "player.videasy.net",
        "player",
        "embed",
      ];

      const isEmbedPlayer = embedDomains.some((domain) =>
        src.toLowerCase().includes(domain),
      );

      if (
        isEmbedPlayer ||
        src.includes("/embed/") ||
        src.includes("/e/") ||
        src.includes("/player")
      ) {
        log("Found embed iframe:", src.substring(0, 80));

        // Report the iframe URL as an embed source
        window.postMessage(
          {
            type: "MAGIC_M3U8_DETECTION",
            source: "SITE_SPECIALIST",
            data: {
              url: src,
              type: "EMBED",
              options: {
                customTitle: cleanTitle(),
                thumbnail: getThumbnail(),
                pageUrl: window.location.href,
                detectionSource: "popcornmovies-specialist",
                isEmbed: true,
                embedUrl: src,
              },
            },
          },
          "*",
        );
      }

      // If iframe src is directly a video URL
      if (isVideoUrl(src) && !isAdUrl(src)) {
        notifyVideo({
          url: src,
          type: getVideoType(src),
          title: cleanTitle(),
        });
      }
    }
  }

  /**
   * Scan JSON-LD structured data
   */
  function scanJsonLd() {
    const ldScripts = document.querySelectorAll(
      'script[type="application/ld+json"]',
    );
    for (const script of ldScripts) {
      try {
        const data = JSON.parse(script.textContent);
        const items = Array.isArray(data) ? data : [data];
        for (const item of items) {
          if (
            item["@type"] === "VideoObject" ||
            item["@type"] === "Movie" ||
            item["@type"] === "TVEpisode"
          ) {
            if (item.contentUrl && isVideoUrl(item.contentUrl)) {
              notifyVideo({
                url: item.contentUrl,
                type: getVideoType(item.contentUrl),
                title: item.name || cleanTitle(),
              });
            }
            if (item.embedUrl) {
              log("Found LD+JSON embed URL:", item.embedUrl);
            }
          }
        }
      } catch {
        /* invalid JSON-LD */
      }
    }
  }

  /**
   * Scan OpenGraph and meta tags for video URLs
   */
  function scanMetaTags() {
    const videoMeta = document.querySelectorAll(
      'meta[property="og:video"], meta[property="og:video:url"], ' +
        'meta[property="og:video:secure_url"], meta[name="twitter:player:stream"]',
    );
    for (const meta of videoMeta) {
      const url = meta.getAttribute("content");
      if (url && isVideoUrl(url) && !isAdUrl(url)) {
        notifyVideo({
          url: url,
          type: getVideoType(url),
          title: cleanTitle(),
        });
      }
    }
  }

  /**
   * Check for __NEXT_DATA__, Nuxt, Laravel/Inertia page data
   */
  function scanPageData() {
    // Laravel Inertia / page props
    const inertiaEl = document.getElementById("app");
    if (inertiaEl) {
      const dataPage = inertiaEl.getAttribute("data-page");
      if (dataPage) {
        try {
          const pageData = JSON.parse(dataPage);
          extractFromJsonObject(pageData);
        } catch {
          /* not valid JSON */
        }
      }
    }

    // __NEXT_DATA__
    const nextData = document.getElementById("__NEXT_DATA__");
    if (nextData) {
      try {
        const data = JSON.parse(nextData.textContent);
        extractFromJsonObject(data);
      } catch {
        /* not valid JSON */
      }
    }

    // Nuxt data
    if (window.__NUXT__) {
      try {
        extractFromJsonObject(window.__NUXT__);
      } catch {
        /* failed */
      }
    }

    // Generic window data objects
    const windowKeys = [
      "__INITIAL_STATE__",
      "__APP_DATA__",
      "pageData",
      "movieData",
      "videoData",
    ];
    for (const key of windowKeys) {
      if (window[key] && typeof window[key] === "object") {
        try {
          extractFromJsonObject(window[key]);
        } catch {
          /* failed */
        }
      }
    }
  }

  // ========== Main Scan Orchestration ==========

  function scanAll() {
    log("Running full page scan...");
    scanVideoElements();
    scanScriptTags();
    scanIframes();
    scanJsonLd();
    scanMetaTags();
    scanPageData();
    scanServerTabs();
    scanPerformanceEntries();
  }

  /**
   * Scan browser Performance API entries for video resource URLs
   * This catches m3u8 requests even if XHR/fetch hooks missed them
   */
  function scanPerformanceEntries() {
    if (!window.performance || !window.performance.getEntriesByType) return;
    try {
      const entries = performance.getEntriesByType("resource");
      for (const entry of entries) {
        const url = entry.name;
        if (url && isVideoUrl(url) && !isAdUrl(url)) {
          notifyVideo({
            url: url,
            type: getVideoType(url),
            title: cleanTitle(),
          });
        }
      }
    } catch (e) {
      log("Performance scan error:", e.message);
    }
  }

  // ========== Initialization ==========

  function initialize() {
    log("Specialist initializing for:", window.location.href);

    // Initial scan after page settles
    if (document.readyState === "complete") {
      setTimeout(scanAll, 1500);
    } else {
      window.addEventListener("load", () => setTimeout(scanAll, 1500));
    }

    // Also scan on DOMContentLoaded for early detection
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () =>
        setTimeout(scanAll, 800),
      );
    } else {
      setTimeout(scanAll, 800);
    }

    // Observe DOM changes (SPA navigation, dynamic player loading)
    const observer = new MutationObserver((mutations) => {
      let shouldRescan = false;
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          const tag = node.tagName?.toLowerCase();
          if (
            tag === "video" ||
            tag === "iframe" ||
            tag === "script" ||
            tag === "source" ||
            tag === "object" ||
            tag === "embed"
          ) {
            shouldRescan = true;
            break;
          }
          // Check if added node contains video-related elements
          if (
            node.querySelector &&
            node.querySelector("video, iframe, source")
          ) {
            shouldRescan = true;
            break;
          }
        }
        if (shouldRescan) break;
      }

      if (shouldRescan) {
        if (detectionTimeout) clearTimeout(detectionTimeout);
        detectionTimeout = setTimeout(scanAll, 1500);
      }
    });

    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
    });

    // Periodic rescan for dynamically loaded content
    setInterval(() => {
      scanVideoElements();
      scanIframes();
      scanPerformanceEntries();
    }, 8000);

    log("Specialist initialized successfully");
  }

  initialize();
})();
