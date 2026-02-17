(function () {
  "use strict";

  console.log("[Flixtor] Specialist loaded");

  window.__SPECIALIST_DETECTED = true;
  window.__FLIXTOR_SPECIALIST_ACTIVE = true;

  const processedUrls = new Set();
  let detectionTimeout = null;

  function getCleanTitle() {
    return (
      document.title
        .replace(/\s*[-|]\s*Flixtor.*$/i, "")
        .replace(/^Watch\s+/i, "")
        .trim() || document.title
    );
  }

  function notifyVideo(videoData) {
    const urlHash = videoData.url.substring(0, 100);
    if (processedUrls.has(urlHash)) return;
    processedUrls.add(urlHash);

    window.postMessage(
      {
        type: "MAGIC_M3U8_DETECTION",
        source: "SITE_SPECIALIST",
        data: {
          url: videoData.url,
          type: videoData.type || "HLS",
          options: {
            customTitle: videoData.title || getCleanTitle(),
            thumbnail: videoData.thumbnail,
            quality: videoData.quality,
            pageUrl: window.location.href,
            detectionSource: "flixtor-specialist",
          },
        },
      },
      "*",
    );

    window.__SPECIALIST_DETECTED = true;
    console.log("[Flixtor] Video detected:", videoData.url.substring(0, 120));
  }

  // --- XHR interception ---
  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...args) {
    this._requestUrl = typeof url === "string" ? url : url?.toString?.() || "";
    return originalXHROpen.call(this, method, url, ...args);
  };
  XMLHttpRequest.prototype.send = function (body) {
    this.addEventListener("load", function () {
      try {
        const _url = this._requestUrl || "";

        // Direct m3u8 request URL detection
        if (typeof _url === "string" && /\.m3u8(\?|#|$)/i.test(_url)) {
          notifyVideo({
            url: _url,
            type: "HLS",
            title: getCleanTitle(),
          });
        }

        const response = this.responseText;

        if (response && typeof response === "string") {
          // Check if the response body itself is an HLS manifest
          const trimmed = response.trimStart();
          if (trimmed.startsWith("#EXTM3U") || trimmed.startsWith("#EXT-X-")) {
            notifyVideo({
              url: _url,
              type: "HLS",
              title: getCleanTitle(),
            });
          }

          // Check response body for m3u8 URLs
          const m3u8Match = response.match(
            /(https?:\/\/[^"'\s<>]+\.m3u8(?:\?[^"'\s<>]*)?)/i,
          );
          if (m3u8Match) {
            notifyVideo({
              url: m3u8Match[1],
              type: "HLS",
              title: getCleanTitle(),
            });
          }

          // Deep JSON search
          if (response.startsWith("{") || response.startsWith("[")) {
            try {
              const json = JSON.parse(response);
              const findStreamUrl = (obj, depth = 0) => {
                if (depth > 8) return null;
                if (typeof obj === "string") {
                  if (/\.m3u8(\?|#|$)/i.test(obj)) return obj;
                  if (/\.mpd(\?|#|$)/i.test(obj)) return obj;
                }
                if (typeof obj === "object" && obj !== null) {
                  if (Array.isArray(obj)) {
                    for (const item of obj) {
                      const found = findStreamUrl(item, depth + 1);
                      if (found) return found;
                    }
                    return null;
                  }
                  const priorityKeys = [
                    "url",
                    "src",
                    "source",
                    "file",
                    "stream",
                    "playlist",
                    "manifest",
                    "hls",
                    "dash",
                  ];
                  const entries = Object.entries(obj);
                  const sorted = entries.sort(([a], [b]) => {
                    const aP = priorityKeys.some((k) =>
                      a.toLowerCase().includes(k),
                    )
                      ? -1
                      : 0;
                    const bP = priorityKeys.some((k) =>
                      b.toLowerCase().includes(k),
                    )
                      ? -1
                      : 0;
                    return aP - bP;
                  });
                  for (const [, value] of sorted) {
                    const found = findStreamUrl(value, depth + 1);
                    if (found) return found;
                  }
                }
                return null;
              };
              const streamUrl = findStreamUrl(json);
              if (streamUrl) {
                const type = /\.mpd(\?|#|$)/i.test(streamUrl) ? "DASH" : "HLS";
                notifyVideo({
                  url: streamUrl,
                  type,
                  title: json.title || json.name || getCleanTitle(),
                });
              }
            } catch (e) {
              console.debug("[Flixtor] Failed to parse XHR JSON response");
            }
          }
        }
      } catch (e) {
        // Silence CSP/cross-origin DOMExceptions from third-party XHRs (e.g. JWPlayer entitlements)
        if (!(e instanceof DOMException)) {
          console.warn("[Flixtor] XHR intercept error:", e.message || e);
        }
      }
    });
    return originalXHRSend.call(this, body);
  };

  // --- Fetch interception ---
  const originalFetch = window.fetch;
  window.fetch = async function (input, init) {
    const response = await originalFetch.call(this, input, init);

    try {
      const url = typeof input === "string" ? input : input?.url;

      // Direct m3u8/mpd URL detection
      if (url && /\.(m3u8|mpd)(\?|#|$)/i.test(url)) {
        const type = /\.mpd(\?|#|$)/i.test(url) ? "DASH" : "HLS";
        notifyVideo({
          url: url,
          type,
          title: getCleanTitle(),
        });
      }

      const cloned = response.clone();
      cloned
        .text()
        .then((text) => {
          if (!text) return;

          // Check if the response itself is an HLS manifest
          const trimmed = text.trimStart();
          if (trimmed.startsWith("#EXTM3U") || trimmed.startsWith("#EXT-X-")) {
            notifyVideo({
              url: url,
              type: "HLS",
              title: getCleanTitle(),
            });
            return;
          }

          // Search for m3u8/mpd URLs in response body
          if (text.includes(".m3u8") || text.includes(".mpd")) {
            const m3u8Match = text.match(
              /(https?:\/\/[^"'\s<>]+\.m3u8(?:\?[^"'\s<>]*)?)/i,
            );
            if (m3u8Match) {
              notifyVideo({
                url: m3u8Match[1],
                type: "HLS",
                title: getCleanTitle(),
              });
            }
            const mpdMatch = text.match(
              /(https?:\/\/[^"'\s<>]+\.mpd(?:\?[^"'\s<>]*)?)/i,
            );
            if (mpdMatch) {
              notifyVideo({
                url: mpdMatch[1],
                type: "DASH",
                title: getCleanTitle(),
              });
            }
          }
        })
        .catch(() => {});
    } catch (e) {
      console.debug("[Flixtor] Fetch intercept error:", e);
    }

    return response;
  };

  // --- MSE / Blob URL detection ---
  // Flixtor uses MediaSource Extensions with blob URLs for the video element.
  // Intercept URL.createObjectURL to detect when MSE is being used,
  // then scan Performance API for the actual stream URLs.
  const originalCreateObjectURL = URL.createObjectURL;
  URL.createObjectURL = function (obj) {
    const blobUrl = originalCreateObjectURL.call(this, obj);
    if (obj instanceof MediaSource) {
      console.log("[Flixtor] MSE blob URL created:", blobUrl.substring(0, 60));
      setTimeout(() => scanForBlobVideo(), 1500);
    }
    return blobUrl;
  };

  function scanForBlobVideo() {
    const videos = document.querySelectorAll("video");
    for (const video of videos) {
      const src = video.src || video.currentSrc;
      if (src && src.startsWith("blob:") && video.duration > 30) {
        console.log(
          "[Flixtor] Found blob video element, duration:",
          video.duration,
        );
        // The actual stream URL should have been caught by XHR/fetch hooks.
        // If not, scan Performance API entries as last resort.
        scanPerformanceEntries();
      }
    }
  }

  function scanPerformanceEntries() {
    if (typeof performance === "undefined" || !performance.getEntriesByType)
      return;
    const entries = performance.getEntriesByType("resource");
    for (const entry of entries) {
      const url = entry.name;
      if (/\.m3u8(\?|#|$)/i.test(url)) {
        notifyVideo({
          url: url,
          type: "HLS",
          title: getCleanTitle(),
        });
        return;
      }
      if (/\.mpd(\?|#|$)/i.test(url)) {
        notifyVideo({
          url: url,
          type: "DASH",
          title: getCleanTitle(),
        });
        return;
      }
    }
  }

  // --- Page scanning ---
  function scanPage() {
    const html = document.documentElement.outerHTML;

    const patterns = [
      /(https?:\/\/[^"'\s<>]+master\.m3u8(?:\?[^"'\s<>]*)?)/gi,
      /(https?:\/\/[^"'\s<>]+\/\d+p\.m3u8(?:\?[^"'\s<>]*)?)/gi,
      /(https?:\/\/[^"'\s<>]+\.m3u8(?:\?[^"'\s<>]*)?)/gi,
    ];

    for (const pattern of patterns) {
      const matches = [...html.matchAll(pattern)];
      for (const match of matches) {
        const url = match[1];

        if (
          url.includes("googleads") ||
          url.includes("analytics") ||
          url.includes("tracking")
        )
          continue;

        notifyVideo({
          url: url,
          type: "HLS",
          title: getCleanTitle(),
        });
        return;
      }
    }

    // Fallback: check Performance API for stream resources
    scanPerformanceEntries();

    // Fallback: check video elements with blob sources
    scanForBlobVideo();
  }

  if (document.readyState === "complete") {
    setTimeout(scanPage, 1000);
  } else {
    window.addEventListener("load", () => setTimeout(scanPage, 1000));
  }

  const observer = new MutationObserver(() => {
    if (detectionTimeout) clearTimeout(detectionTimeout);
    detectionTimeout = setTimeout(scanPage, 2000);
  });

  observer.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true,
  });
})();
