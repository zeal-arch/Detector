(function () {
  "use strict";

  const MAGIC = "__generic_extractor__";
  const seen = new Set();
  const blobMap = new Map();

  // Known proxy/CDN domains used by pirated streaming sites
  const PROXY_DOMAINS = [
    "vodvidl.site",
    "trueparadise.workers.dev",
    "tigerflare",
    "videasy.net",
    "rabbitstream",
    "megacloud",
    "vidplay",
    "filemoon",
    "dokicloud",
    "rapid-cloud",
    "vidstreaming",
  ];

  function isProxyDomain(url) {
    try {
      return PROXY_DOMAINS.some(function (d) {
        return url.includes(d);
      });
    } catch (e) {
      return false;
    }
  }

  function checkUrl(url, extraData) {
    extraData = extraData || {};
    if (!url || typeof url !== "string") return;
    if (seen.has(url)) return;

    // Standard extension matching
    if (/\.(m3u8|mpd)(\?|#|$)/i.test(url)) {
      seen.add(url);
      window.postMessage({ type: MAGIC, url: url, ...extraData }, "*");
      return;
    }

    // Proxy domain matching — any request to a known proxy with stream-like path
    if (isProxyDomain(url)) {
      if (
        /m3u8|proxy|stream|video|manifest|playlist|master|hls|dash/i.test(url)
      ) {
        seen.add(url);
        window.postMessage(
          { type: MAGIC, url: url, proxyDetected: true, ...extraData },
          "*",
        );
        return;
      }
    }

    if (/\/video\/|\.(mp4|webm)(\?|#|$)/i.test(url) && url.length < 500) {
      if (/cdn|media|stream|video|content/i.test(url)) {
        seen.add(url);
        window.postMessage(
          { type: MAGIC, url: url, direct: true, ...extraData },
          "*",
        );
      }
    }
  }

  // Check if response text is an HLS manifest
  function checkResponseForHLS(url, text) {
    if (!text || typeof text !== "string") return;
    if (seen.has(url)) return;
    var trimmed = text.trimStart();
    if (trimmed.startsWith("#EXTM3U") || trimmed.startsWith("#EXT-X-")) {
      seen.add(url);
      window.postMessage({ type: MAGIC, url: url, hlsContent: true }, "*");
    }
  }

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__hookUrl = url?.toString();
    checkUrl(this.__hookUrl);
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    var xhr = this;
    var hookUrl = xhr.__hookUrl;
    if (hookUrl && !seen.has(hookUrl)) {
      try {
        xhr.addEventListener("load", function () {
          try {
            if (
              xhr.readyState === 4 &&
              xhr.status >= 200 &&
              xhr.status < 400
            ) {
              var ct = (
                xhr.getResponseHeader("content-type") || ""
              ).toLowerCase();
              if (
                ct.includes("mpegurl") ||
                ct.includes("text") ||
                ct.includes("json") ||
                ct.includes("octet") ||
                ct.includes("binary") ||
                ct === "" ||
                isProxyDomain(hookUrl)
              ) {
                var len = parseInt(
                  xhr.getResponseHeader("content-length") || "0",
                  10,
                );
                if (!len || len <= 1048576) {
                  checkResponseForHLS(hookUrl, xhr.responseText);
                }
              }
            }
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : input?.url;
    checkUrl(url);

    var result = origFetch.apply(this, arguments);

    // Inspect response body for HLS manifests
    if (url && !seen.has(url)) {
      result
        .then(function (response) {
          try {
            var ct = (response.headers.get("content-type") || "").toLowerCase();
            var isTextLike =
              ct.includes("mpegurl") ||
              ct.includes("text") ||
              ct.includes("json");
            var isBinaryLike =
              ct.includes("octet") ||
              ct.includes("binary") ||
              ct === "" ||
              isProxyDomain(url);
            if (isTextLike || isBinaryLike) {
              // Skip large binary payloads (video segments) to avoid freezing the page
              var len = parseInt(
                response.headers.get("content-length") || "0",
                10,
              );
              if (len && len > 1048576) return response;
              // For binary/unknown content types without Content-Length (chunked),
              // skip body inspection to avoid pulling large video segments into memory
              if (isBinaryLike && !isTextLike && !len) return response;
              // Clone to avoid consuming the body
              response
                .clone()
                .text()
                .then(function (text) {
                  checkResponseForHLS(url, text);
                })
                .catch(function () {});
            }
          } catch (e) {}
          return response;
        })
        .catch(function () {});
    }

    return result;
  };

  const origSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    if ((name === "src" || name === "data-src") && typeof value === "string") {
      checkUrl(value);
    }
    return origSetAttribute.call(this, name, value);
  };

  if (typeof MediaSource !== "undefined") {
    const mseDetectedMimeTypes = new Set();

    const origAddSourceBuffer = MediaSource.prototype.addSourceBuffer;
    MediaSource.prototype.addSourceBuffer = function (mimeType) {
      const sb = origAddSourceBuffer.call(this, mimeType);

      if (!mseDetectedMimeTypes.has(mimeType)) {
        mseDetectedMimeTypes.add(mimeType);
        window.postMessage(
          {
            type: MAGIC,
            mseDetected: true,
            mimeType: mimeType,
          },
          "*",
        );
      }

      return sb;
    };
  }

  if (typeof URL !== "undefined" && URL.createObjectURL) {
    const origCreateObjectURL = URL.createObjectURL;
    URL.createObjectURL = function (obj) {
      const blobUrl = origCreateObjectURL.call(this, obj);

      if (obj instanceof Blob || obj instanceof MediaSource) {
        blobMap.set(blobUrl, {
          type: obj.type || "unknown",
          size: obj.size || 0,
          timestamp: Date.now(),
        });

        if (obj instanceof Blob && obj.type && obj.type.startsWith("video")) {
          window.postMessage(
            {
              type: MAGIC,
              blobUrl: blobUrl,
              blobType: obj.type,
              blobSize: obj.size,
              isBlobVideo: true,
            },
            "*",
          );
        }
      }

      return blobUrl;
    };

    const origRevokeObjectURL = URL.revokeObjectURL;
    URL.revokeObjectURL = function (url) {
      blobMap.delete(url);
      return origRevokeObjectURL.call(this, url);
    };
  }

  if (
    typeof AudioContext !== "undefined" ||
    typeof webkitAudioContext !== "undefined"
  ) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const origCreateMediaElementSource =
      AudioCtx.prototype.createMediaElementSource;

    AudioCtx.prototype.createMediaElementSource = function (mediaElement) {
      if (mediaElement && mediaElement.src) {
        checkUrl(mediaElement.src, { webAudioDetected: true });
      }
      return origCreateMediaElementSource.call(this, mediaElement);
    };
  }

  ["HTMLVideoElement", "HTMLAudioElement"].forEach(function (elemType) {
    if (typeof window[elemType] === "undefined") return;

    const proto = window[elemType].prototype;
    const srcDescriptor = Object.getOwnPropertyDescriptor(proto, "src");

    if (srcDescriptor && srcDescriptor.set) {
      const origSet = srcDescriptor.set;
      srcDescriptor.set = function (value) {
        checkUrl(value, { mediaElement: elemType });
        return origSet.call(this, value);
      };
      Object.defineProperty(proto, "src", srcDescriptor);
    }
  });

  console.log(
    "[M3U8 Detector] Enhanced generic network hook initialized (MSE + Blob + WebAudio)",
  );
})();
