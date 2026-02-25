(function () {
  "use strict";

  const SITE_ID = "net22cc";

  if (window.__SITE_SPECIALIST_LOADED === SITE_ID) return;
  window.__SITE_SPECIALIST_LOADED = SITE_ID;

  const processedUrls = new Set();
  let detectionTimeout = null;
  let masterManifestFound = false; // track if we found the master (combined) manifest

  function log(...args) {
    console.log(`[Specialist][${SITE_ID}]`, ...args);
  }

  // ── Helpers ──────────────────────────────────────────────────────

  function cleanTitle() {
    return (
      document.title
        .replace(/\s*[-–|]?\s*(net22|net52|net20|net50).*$/i, "")
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

  // ── Known domains ───────────────────────────────────────────────

  // Player iframe / embed domains used by net22.cc
  const PLAYER_DOMAINS = ["net52.cc", "net50.cc", "net20.cc"];

  // CDN domains used for segment and manifest delivery
  const CDN_DOMAINS = [
    "nm-cdn11.top",
    "nm-cdn",
    "nfmirrorcdn.top",
    "nfmirrorcdn",
  ];

  // Combined domains for video URL detection
  const ALL_VIDEO_DOMAINS = [...PLAYER_DOMAINS, ...CDN_DOMAINS];

  // ── URL detection ───────────────────────────────────────────────

  function isAdUrl(url) {
    const adPatterns = [
      "googleads",
      "doubleclick",
      "googlesyndication",
      "analytics",
      "tracking",
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
      "prd.jwpltx.com",
      "entitlements.jwplayer.com",
    ];
    const lowerUrl = url.toLowerCase();
    return adPatterns.some((p) => lowerUrl.includes(p));
  }

  /**
   * Check if a URL is an audio-only variant (should be skipped as standalone).
   * net22 uses separated audio+video; audio lives under /a/0/ or /a/1/ paths.
   */
  function isAudioOnlyUrl(url) {
    return /\/a\/\d+\/\d+\.m3u8/i.test(url) || /\/files\/\d+\/a\//i.test(url);
  }

  function isVideoUrl(url) {
    if (!url || typeof url !== "string") return false;
    // Standard HLS/DASH/MP4 extensions
    if (/\.(m3u8|mpd|mp4|webm)(\?|#|$)/i.test(url)) return true;
    // URL paths containing hls or playlist on known domains
    if (ALL_VIDEO_DOMAINS.some((d) => url.includes(d))) {
      if (/hls|playlist|m3u8|manifest/i.test(url)) return true;
    }
    return false;
  }

  function getVideoType(url) {
    if (/\.m3u8(\?|#|$)/i.test(url)) return "hls";
    if (/\.mpd(\?|#|$)/i.test(url)) return "dash";
    if (/\.mp4(\?|#|$)/i.test(url)) return "mp4";
    if (/\.webm(\?|#|$)/i.test(url)) return "webm";
    // net22/net52 HLS endpoint pattern: /hls/<id>.m3u8
    if (/\/hls\/\d+\.m3u8/i.test(url)) return "hls";
    return "hls"; // default — site uses HLS
  }

  /**
   * Try to extract quality from URL path (e.g. /1080p/, /720p/, /480p/)
   */
  function extractQuality(url) {
    const m = url.match(/\/(\d{3,4}p)\//i);
    if (m) return m[1];
    if (/master|index/i.test(url)) return "auto";
    return "auto";
  }

  /**
   * Check if URL is a master manifest (vs variant)
   */
  function isMasterManifest(url) {
    // net52.cc/hls/<id>.m3u8 is master; CDN variant has /1080p/ etc.
    if (
      PLAYER_DOMAINS.some((d) => url.includes(d)) &&
      /\/hls\/\d+\.m3u8/i.test(url)
    ) {
      return true;
    }
    if (/master/i.test(url)) return true;
    return false;
  }

  // ── Notification (dual protocol) ────────────────────────────────

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
            detectionSource: "net22cc-specialist",
            headers: videoData.headers || null,
          },
        },
      },
      "*",
    );

    log("Video detected (MAGIC):", videoData.url.substring(0, 100));
  }

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

  function notifyVideo(videoData) {
    notifyVideoMagic(videoData);
    notifyVideoLAL([
      {
        url: videoData.url,
        type: videoData.type || "hls",
        quality: videoData.quality || "auto",
        title: videoData.title || cleanTitle(),
        headers: videoData.headers || null,
      },
    ]);
  }

  // ── Response size guard ─────────────────────────────────────────
  const MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2 MB

  // ── XHR Interception ────────────────────────────────────────────

  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...args) {
    this._net22RequestUrl = typeof url === "string" ? url : url?.toString();
    this._net22Method = method;
    return originalXHROpen.call(this, method, url, ...args);
  };

  XMLHttpRequest.prototype.send = function (body) {
    this.addEventListener("load", function () {
      try {
        const reqUrl = this._net22RequestUrl || "";

        // Catch the master HLS manifest directly
        if (isVideoUrl(reqUrl) && !isAdUrl(reqUrl)) {
          // Prefer master manifest (net52.cc/hls/<id>.m3u8) over individual variants
          if (isMasterManifest(reqUrl)) {
            masterManifestFound = true;
            log("Found MASTER manifest:", reqUrl.substring(0, 100));
            notifyVideo({
              url: reqUrl,
              type: "hls",
              quality: "auto",
              title: cleanTitle(),
            });
          } else if (!isAudioOnlyUrl(reqUrl)) {
            // Only report non-audio variant URLs
            const quality = extractQuality(reqUrl);
            notifyVideo({
              url: reqUrl,
              type: getVideoType(reqUrl),
              quality: quality,
              title: cleanTitle(),
            });
          } else {
            log("Skipping audio-only variant:", reqUrl.substring(0, 80));
          }
        }

        // Intercept play.php POST response (returns embed iframe URL)
        if (/play\.php/i.test(reqUrl) && this._net22Method === "POST") {
          log("play.php POST response:", response?.substring(0, 200));
        }

        // Skip large responses (video segments)
        const contentLength = parseInt(
          this.getResponseHeader("content-length") || "0",
          10,
        );
        if (contentLength > MAX_RESPONSE_BYTES) return;

        const response = this.responseText;
        if (!response || typeof response !== "string") return;
        if (response.length > MAX_RESPONSE_BYTES) return;

        // Parse playlist.php JSON response for metadata + source URLs
        if (/playlist\.php/i.test(reqUrl)) {
          parsePlaylistResponse(response);
        }

        // Search for m3u8/video URLs in any text response
        extractUrlsFromText(response);

        // Parse JSON responses
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

  // ── Fetch Interception ──────────────────────────────────────────

  const originalFetch = window.fetch;
  window.fetch = async function (input, init) {
    const response = await originalFetch.call(this, input, init);

    try {
      const url = typeof input === "string" ? input : input?.url;

      // Catch video URLs in fetch requests
      if (url && isVideoUrl(url) && !isAdUrl(url)) {
        if (isMasterManifest(url)) {
          masterManifestFound = true;
          log("Found MASTER manifest (fetch):", url.substring(0, 100));
          notifyVideo({
            url: url,
            type: "hls",
            quality: "auto",
            title: cleanTitle(),
          });
        } else if (!isAudioOnlyUrl(url)) {
          const quality = extractQuality(url);
          notifyVideo({
            url: url,
            type: getVideoType(url),
            quality: quality,
            title: cleanTitle(),
          });
        }
      }

      // Skip large responses
      const contentLength = parseInt(
        response.headers.get("content-length") || "0",
        10,
      );
      if (contentLength > MAX_RESPONSE_BYTES) {
        return response;
      }

      // Clone and analyze
      const cloned = response.clone();
      cloned
        .text()
        .then((text) => {
          if (!text) return;

          // Parse playlist.php specifically
          if (url && /playlist\.php/i.test(url)) {
            parsePlaylistResponse(text);
          }

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

  // ── Playlist / API response parsing ─────────────────────────────

  /**
   * Parse the playlist.php JSON response which contains JWPlayer sources,
   * tracks (subtitles), thumbnail sprites, etc.
   */
  function parsePlaylistResponse(text) {
    try {
      const data = JSON.parse(text);
      log("Parsed playlist.php response:", Object.keys(data));

      // JWPlayer playlist format: { sources: [...], tracks: [...], image: "..." }
      if (data.sources && Array.isArray(data.sources)) {
        for (const source of data.sources) {
          const file = source.file || source.src || source.url;
          if (file && /\.m3u8/i.test(file)) {
            notifyVideo({
              url: file,
              type: "hls",
              quality: source.label || "auto",
              title: data.title || cleanTitle(),
              thumbnail: data.image || getThumbnail(),
            });
          }
        }
      }

      // Direct file property
      if (data.file && /\.m3u8/i.test(data.file)) {
        notifyVideo({
          url: data.file,
          type: "hls",
          quality: "auto",
          title: data.title || cleanTitle(),
          thumbnail: data.image || getThumbnail(),
        });
      }

      // Subtitles / tracks
      if (data.tracks && Array.isArray(data.tracks)) {
        for (const track of data.tracks) {
          if (track.kind === "captions" || track.kind === "subtitles") {
            log("Subtitle track:", track.label, track.file);
          }
        }
      }
    } catch {
      // Not JSON — might be the m3u8 manifest content itself
      if (text.includes("#EXTM3U")) {
        log("Got raw HLS manifest content from playlist endpoint");
      }
    }
  }

  // ── Generic URL extraction from text ────────────────────────────

  function extractUrlsFromText(text) {
    // m3u8 patterns
    const m3u8Patterns = [
      /(https?:\/\/[^"'\s<>\\\]]+\.m3u8(?:\?[^"'\s<>\\\]]*)?)/gi,
      // net52/net22 HLS endpoint
      /(https?:\/\/[^"'\s<>\\\]]*net\d{2}\.cc\/hls\/[^"'\s<>\\\]]*)/gi,
      // CDN variant manifests
      /(https?:\/\/[^"'\s<>\\\]]*nm-cdn\d*\.top[^"'\s<>\\\]]*\.m3u8[^"'\s<>\\\]]*)/gi,
    ];

    for (const pattern of m3u8Patterns) {
      const matches = [...text.matchAll(pattern)];
      for (const match of matches) {
        const url = match[1].replace(/\\+/g, "");
        if (!isAdUrl(url)) {
          notifyVideo({
            url,
            type: "hls",
            quality: extractQuality(url),
            title: cleanTitle(),
          });
        }
      }
    }

    // MPD patterns (unlikely for this site but covers edge cases)
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

  // ── DOM Scanning ────────────────────────────────────────────────

  /**
   * Scan <script> tags for JWPlayer setup calls and embedded video URLs
   */
  function scanScriptTags() {
    const scripts = document.querySelectorAll("script:not([src])");
    for (const script of scripts) {
      const content = script.textContent || "";
      if (content.length < 10 || content.length > 500000) continue;

      extractUrlsFromText(content);

      // JWPlayer setup pattern (net22 uses JWPlayer)
      const jwMatch = content.match(
        /jwplayer\s*\([^)]*\)\s*\.setup\s*\(\s*({[\s\S]*?})\s*\)/i,
      );
      if (jwMatch) {
        log("Found JWPlayer setup in script tag");
        try {
          extractUrlsFromText(jwMatch[1]);
        } catch {
          /* skip */
        }
      }

      // Generic player config patterns
      const configPatterns = [
        /(?:player|video)(?:Config|Options|Settings|Data)\s*[=:]\s*({[\s\S]*?});/i,
        /sources?\s*[=:]\s*(\[[\s\S]*?\])/i,
        /file\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i,
      ];

      for (const pattern of configPatterns) {
        const match = content.match(pattern);
        if (match) {
          extractUrlsFromText(match[1] || match[0]);
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
   * Scan <iframe> elements for the net52.cc player embed (or other mirror domains)
   */
  function scanIframes() {
    const iframes = document.querySelectorAll("iframe");
    for (const iframe of iframes) {
      const src =
        iframe.src ||
        iframe.getAttribute("data-src") ||
        iframe.getAttribute("data-lazy-src");
      if (!src) continue;

      // Check if this is the net52.cc / net50.cc / net20.cc player embed
      const isPlayerEmbed = PLAYER_DOMAINS.some((d) => src.includes(d));

      if (
        isPlayerEmbed ||
        src.includes("/embed/") ||
        src.includes("/play.php") ||
        src.includes("/player")
      ) {
        log("Found player embed iframe:", src.substring(0, 100));

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
                detectionSource: "net22cc-specialist",
                isEmbed: true,
                embedUrl: src,
              },
            },
          },
          "*",
        );
      }

      // Direct video URL in iframe src
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
   * Scan OpenGraph meta tags for video info
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
          }
        }
      } catch {
        /* invalid JSON-LD */
      }
    }
  }

  /**
   * Scan browser Performance API entries for video resource URLs
   * Catches m3u8 requests that may bypass XHR/fetch hooks
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
            quality: extractQuality(url),
            title: cleanTitle(),
          });
        }
      }
    } catch (e) {
      log("Performance scan error:", e.message);
    }
  }

  /**
   * Listen for cross-origin messages from the net52.cc player iframe.
   * JWPlayer or the custom player may post messages containing video source info.
   */
  function listenForIframeMessages() {
    window.addEventListener("message", (event) => {
      try {
        // Accept messages from known player domains
        if (!event.origin) return;
        const isPlayerOrigin = PLAYER_DOMAINS.some((d) =>
          event.origin.includes(d),
        );
        if (!isPlayerOrigin) return;

        const data = event.data;
        if (!data || typeof data !== "object") return;

        log("Message from player iframe:", data.type || "unknown");

        // Check for video URLs in the message payload
        if (typeof data === "object") {
          extractFromJsonObject(data);
        }
      } catch (e) {
        log("Iframe message error:", e.message);
      }
    });
  }

  // ── Main scan orchestration ─────────────────────────────────────

  function scanAll() {
    log("Running full page scan...");
    scanVideoElements();
    scanScriptTags();
    scanIframes();
    scanJsonLd();
    scanMetaTags();
    scanPerformanceEntries();
  }

  // ── Initialization ──────────────────────────────────────────────

  function initialize() {
    log("Specialist initializing for:", window.location.href);

    listenForIframeMessages();

    // Initial scan after page settles
    if (document.readyState === "complete") {
      setTimeout(scanAll, 1500);
    } else {
      window.addEventListener("load", () => setTimeout(scanAll, 1500));
    }

    // Early scan on DOMContentLoaded
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () =>
        setTimeout(scanAll, 800),
      );
    } else {
      setTimeout(scanAll, 800);
    }

    // Observe DOM changes (dynamic player loading, SPA navigation)
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
