(function () {
  "use strict";

  const MAGIC = "__generic_extractor__";
  const seen = new Set();
  const blobMap = new Map();

  // Known proxy/CDN domains used by pirated streaming sites.
  // Entries should be full domain suffixes (e.g. "filemoon.sx") or
  // unique-enough substrings that won't false-positive on legitimate sites.
  // Matching for SW unregistration uses strict domain-suffix comparison;
  // URL-based proxy detection (XHR/fetch interception) uses includes().
  const PROXY_DOMAINS = [
    "vodvidl.site",
    "trueparadise.workers.dev",
    "tigerflare.com",
    "videasy.net",
    "rabbitstream.net",
    "megacloud.tv",
    "vidplay.site",
    "filemoon.sx",
    "dokicloud.one",
    "rapid-cloud.co",
    "vidstreaming.io",
    // Additional pirate CDN/embed domains
    "streamtape.com",
    "doodstream.com",
    "mixdrop.co",
    "upstream.to",
    "streamlare.com",
    "fembed.com",
    "voe.sx",
    "streamhub.to",
    "streamsb.net",
    "vidcloud.co",
    "mycloud.to",
    "mp4upload.com",
    "evoload.io",
    "streamz.ws",
    "vidoza.net",
    "netu.tv",
    "supervideo.tv",
    "jetload.net",
    "vido.gg",
    "streamwish.to",
    "vidhide.com",
    "embedrise.com",
    "closeload.top",
    "filelions.to",
    "vidguard.to",
    "lulustream.com",
    "vembed.net",
    "multiembed.mov",
    "2embed.cc",
    "vidsrc.me",
    "autoembed.cc",
    "flixhq.to",
    "sflix.to",
    "fmovies.to",
    "gomovies.sx",
    "123movies.to",
    "putlocker.vip",
    "kinox.to",
    "primewire.li",
  ];

  // Known ad/tracker URL patterns to ignore when detected in XHR/fetch
  const AD_URL_PATTERNS = [
    /doubleclick\.net/i,
    /googlesyndication\.com/i,
    /googletagmanager\.com/i,
    /googleads\./i,
    /google-analytics\.com/i,
    /facebook\.net\/.*\/sdk/i,
    /adnxs\.com/i,
    /amazon-adsystem\.com/i,
    /outbrain\.com/i,
    /taboola\.com/i,
    /popads\.net/i,
    /popcash\.net/i,
    /propellerads\.com/i,
    /exoclick\.com/i,
    /juicyads\.com/i,
    /trafficjunky\.net/i,
    /ad\.atdmt\.com/i,
    /bidgear\.com/i,
    /hilltopads\.net/i,
    /clickadu\.com/i,
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

  /**
   * Strict domain-suffix match: checks if hostname exactly equals or
   * ends with ".{domain}". Prevents false positives like "vido" matching
   * "video.example.com" or "megacloud" matching "megaclouds.org".
   */
  function isProxyHostname(hostname) {
    var h = hostname.toLowerCase();
    return PROXY_DOMAINS.some(function (d) {
      return h === d || h.endsWith("." + d);
    });
  }

  function checkUrl(url, extraData) {
    extraData = extraData || {};
    if (!url || typeof url !== "string") return;
    if (seen.has(url)) return;

    // Skip known ad/tracker URLs to avoid false positive detections
    for (var i = 0; i < AD_URL_PATTERNS.length; i++) {
      if (AD_URL_PATTERNS[i].test(url)) return;
    }

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

  // Check if response text is an HLS manifest or DASH manifest
  function checkResponseForHLS(url, text) {
    if (!text || typeof text !== "string") return;
    if (seen.has(url)) return;
    var trimmed = text.trimStart();

    // HLS manifest detection
    if (trimmed.startsWith("#EXTM3U") || trimmed.startsWith("#EXT-X-")) {
      seen.add(url);
      window.postMessage({ type: MAGIC, url: url, hlsContent: true }, "*");
      return;
    }

    // DASH MPD manifest detection
    if (
      trimmed.startsWith("<?xml") &&
      (trimmed.includes("<MPD") || trimmed.includes("<mpd"))
    ) {
      seen.add(url);
      window.postMessage({ type: MAGIC, url: url, dashContent: true }, "*");
      return;
    }

    // Extract m3u8/mpd URLs embedded in JSON/HTML responses (pirate sites often
    // return video URLs inside API responses or inline script tags)
    if (text.length < 500000) {
      var m3u8Matches = text.match(
        /(?:https?:)?\/\/[^\s"'<>]+\.m3u8(?:\?[^\s"'<>]*)?/gi,
      );
      if (m3u8Matches) {
        for (var j = 0; j < m3u8Matches.length; j++) {
          var mUrl = m3u8Matches[j];
          if (mUrl.startsWith("//")) mUrl = "https:" + mUrl;
          if (!seen.has(mUrl)) {
            // Skip ad URLs found in responses
            var isAd = false;
            for (var k = 0; k < AD_URL_PATTERNS.length; k++) {
              if (AD_URL_PATTERNS[k].test(mUrl)) {
                isAd = true;
                break;
              }
            }
            if (!isAd) {
              seen.add(mUrl);
              window.postMessage(
                { type: MAGIC, url: mUrl, extractedFromResponse: true },
                "*",
              );
            }
          }
        }
      }

      var mpdMatches = text.match(
        /(?:https?:)?\/\/[^\s"'<>]+\.mpd(?:\?[^\s"'<>]*)?/gi,
      );
      if (mpdMatches) {
        for (var m = 0; m < mpdMatches.length; m++) {
          var mpdUrl = mpdMatches[m];
          if (mpdUrl.startsWith("//")) mpdUrl = "https:" + mpdUrl;
          if (!seen.has(mpdUrl)) {
            var isAdMpd = false;
            for (var n = 0; n < AD_URL_PATTERNS.length; n++) {
              if (AD_URL_PATTERNS[n].test(mpdUrl)) {
                isAdMpd = true;
                break;
              }
            }
            if (!isAdMpd) {
              seen.add(mpdUrl);
              window.postMessage(
                { type: MAGIC, url: mpdUrl, extractedFromResponse: true },
                "*",
              );
            }
          }
        }
      }
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
            if (xhr.readyState === 4 && xhr.status >= 200 && xhr.status < 400) {
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
          } catch (e) {}
        });
      } catch (e) {}
    }
    return origSend.apply(this, arguments);
  };

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : input?.url;
    checkUrl(url);

    // Flag DRM license server requests (isLicenseUrl defined below with EME hooks)
    if (typeof isLicenseUrl === "function" && isLicenseUrl(url)) {
      window.postMessage(
        {
          type: MAGIC,
          drmLicenseServerUrl: true,
          licenseUrl: url,
          method: (init && init.method) || "GET",
        },
        "*",
      );
    }

    var result;
    try {
      result = origFetch.apply(this, arguments);
    } catch (e) {
      // If the underlying fetch (or a proxy wrapping it) throws synchronously,
      // re-throw so the page sees the original error, not a "Cannot read
      // property 'then' of undefined" from our response body inspection below.
      throw e;
    }

    // Inspect response body for HLS manifests
    if (url && !seen.has(url) && result && typeof result.then === "function") {
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

  // ───────────── Pirate site ad→content transition detection ─────────────
  // Pirate sites play an ad pre-roll then switch the video src to real content.
  // IDM handles this via DOM element scanning with largest-visible-wins heuristic.
  // We watch for: (1) video.src changes after initial load, (2) new video elements
  // appearing, (3) source elements being added/changed.

  const videoSrcTracker = new Map(); // element → last known src

  function scanVideoElements() {
    try {
      var videos = document.querySelectorAll("video");
      for (var i = 0; i < videos.length; i++) {
        var video = videos[i];
        var currentSrc = video.src || video.currentSrc || "";
        var lastSrc = videoSrcTracker.get(video);

        if (
          currentSrc &&
          currentSrc !== lastSrc &&
          !currentSrc.startsWith("data:")
        ) {
          videoSrcTracker.set(video, currentSrc);
          checkUrl(currentSrc, { mediaElement: "video", srcChange: true });

          // Also check source child elements
          var sources = video.querySelectorAll("source");
          for (var j = 0; j < sources.length; j++) {
            if (sources[j].src) {
              checkUrl(sources[j].src, {
                mediaElement: "source",
                srcChange: true,
              });
            }
          }
        }
      }
    } catch (e) {}
  }

  // Run periodic video element scan — catches ad→content transitions
  // that bypass property setter hooks (e.g. direct attribute setting, innerHTML)
  var scanInterval = setInterval(scanVideoElements, 3000);

  // Also watch for new video elements being added to the DOM
  if (typeof MutationObserver !== "undefined") {
    try {
      var domObserver = new MutationObserver(function (mutations) {
        for (var i = 0; i < mutations.length; i++) {
          var addedNodes = mutations[i].addedNodes;
          for (var j = 0; j < addedNodes.length; j++) {
            var node = addedNodes[j];
            if (node.nodeType !== 1) continue;

            // Direct video/audio element added
            if (node.tagName === "VIDEO" || node.tagName === "AUDIO") {
              if (node.src)
                checkUrl(node.src, {
                  mediaElement: node.tagName,
                  dynamicAdd: true,
                });
              var childSources = node.querySelectorAll("source");
              for (var k = 0; k < childSources.length; k++) {
                if (childSources[k].src)
                  checkUrl(childSources[k].src, {
                    mediaElement: "source",
                    dynamicAdd: true,
                  });
              }
            }

            // Check if added element contains video/audio elements (e.g. player container)
            if (node.querySelectorAll) {
              var embeddedVideos = node.querySelectorAll("video, audio");
              for (var m = 0; m < embeddedVideos.length; m++) {
                var ev = embeddedVideos[m];
                if (ev.src)
                  checkUrl(ev.src, {
                    mediaElement: ev.tagName,
                    dynamicAdd: true,
                  });
              }
            }

            // Iframe added — check for embed player URLs
            if (node.tagName === "IFRAME" && node.src) {
              if (
                isProxyDomain(node.src) ||
                /player|embed|video|stream/i.test(node.src)
              ) {
                window.postMessage(
                  {
                    type: MAGIC,
                    embedUrl: node.src,
                    embedDetected: true,
                  },
                  "*",
                );
              }
            }
          }
        }
      });

      // Observe after DOM ready
      var startObserving = function () {
        if (document.body) {
          domObserver.observe(document.body, {
            childList: true,
            subtree: true,
          });
        }
      };
      if (document.body) {
        startObserving();
      } else {
        document.addEventListener("DOMContentLoaded", startObserving);
      }
    } catch (e) {}
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SourceBuffer.appendBuffer hook — detect raw MSE segment data
  // ═══════════════════════════════════════════════════════════════════════
  // Sites using MSE push segment data through SourceBuffer.appendBuffer().
  // We don't capture the full data (too much volume) but we log that MSE
  // segments are flowing + their sizes. If the fetch/XHR hooks already
  // captured the underlying URL, we know the pipeline. If NOT, this tells
  // us the data is being constructed in-memory (e.g., from WebSocket or
  // WebRTC DataChannel), which is a signal we need SourceBuffer reconstruction.
  if (typeof SourceBuffer !== "undefined") {
    try {
      var sbAppendCount = 0;
      var sbTotalBytes = 0;
      var origAppendBuffer = SourceBuffer.prototype.appendBuffer;
      SourceBuffer.prototype.appendBuffer = function (data) {
        sbAppendCount++;
        var byteLen =
          data instanceof ArrayBuffer
            ? data.byteLength
            : data.buffer
              ? data.byteLength
              : 0;
        sbTotalBytes += byteLen;

        // Report every 10th append to avoid flooding (video can have 1000s of appends)
        if (sbAppendCount % 10 === 1) {
          window.postMessage(
            {
              type: MAGIC,
              mseAppend: true,
              mimeType: this.mimeType || "unknown",
              appendCount: sbAppendCount,
              totalBytes: sbTotalBytes,
              chunkSize: byteLen,
            },
            "*",
          );
        }

        return origAppendBuffer.call(this, data);
      };
    } catch (e) {}
  }

  // ═══════════════════════════════════════════════════════════════════════
  // HTMLMediaElement.srcObject setter hook — Worker MediaSource (Chrome 108+)
  // ═══════════════════════════════════════════════════════════════════════
  // When MediaSource is created in a Dedicated Worker, it uses
  // video.srcObject = handle (MediaSourceHandle), NOT URL.createObjectURL.
  // Our createObjectURL hook would miss this entirely. We must intercept
  // the srcObject setter on HTMLMediaElement.
  try {
    var srcObjDesc = Object.getOwnPropertyDescriptor(
      HTMLMediaElement.prototype,
      "srcObject",
    );
    if (srcObjDesc && srcObjDesc.set) {
      var origSrcObjSet = srcObjDesc.set;
      Object.defineProperty(HTMLMediaElement.prototype, "srcObject", {
        set: function (value) {
          // MediaSourceHandle is the transfer object from Worker MediaSource
          if (
            value &&
            value.constructor &&
            value.constructor.name === "MediaSourceHandle"
          ) {
            window.postMessage(
              {
                type: MAGIC,
                mseHandleDetected: true,
                elementTag: this.tagName,
              },
              "*",
            );
          } else if (
            value &&
            typeof MediaStream !== "undefined" &&
            value instanceof MediaStream
          ) {
            // MediaStream (e.g., from getUserMedia, tab capture, canvas capture)
            window.postMessage(
              {
                type: MAGIC,
                mediaStreamDetected: true,
                elementTag: this.tagName,
                trackCount: value.getTracks ? value.getTracks().length : 0,
              },
              "*",
            );
          }
          return origSrcObjSet.call(this, value);
        },
        get: srcObjDesc.get
          ? srcObjDesc.get
          : function () {
              return undefined;
            },
        configurable: true,
        enumerable: true,
      });
    }
  } catch (e) {}

  // ═══════════════════════════════════════════════════════════════════════
  // EME hooks — REMOVED
  // ═══════════════════════════════════════════════════════════════════════
  // EME interception is now handled by content/eme-interceptor.js which
  // provides superior anti-detection (stealthProxy, Symbols, toString
  // preservation), ClearKey auto-detection, challenge swap support,
  // and session.update response capture. The old basic hooks here
  // conflicted with the Proxy-based approach and lacked anti-detection.
  //
  // The eme-interceptor.js is injected via content/bridge.js using a
  // <script src> tag technique (universal: Chrome + Firefox, MV2 + MV3).

  // License URL detection is still useful for the fetch/XHR hooks above —
  // it flags requests to known DRM license endpoints.
  var LICENSE_URL_PATTERNS = [
    /license/i,
    /widevine/i,
    /playready/i,
    /fairplay/i,
    /clearkey/i,
    /drm/i,
    /eme/i,
    /\/proxy\?provider=/i,
    /modular.*drm/i,
    /cwip-shaka-proxy/i,
  ];

  function isLicenseUrl(url) {
    if (!url) return false;
    for (var i = 0; i < LICENSE_URL_PATTERNS.length; i++) {
      if (LICENSE_URL_PATTERNS[i].test(url)) return true;
    }
    return false;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Service Worker detection and unregistration
  // ═══════════════════════════════════════════════════════════════════════
  // Site service workers can intercept fetch requests and serve cached
  // responses, making those requests invisible to chrome.webRequest and
  // declarativeNetRequest. We detect active SWs and optionally unregister
  // them so network requests flow through the normal stack where our
  // extension can see them.
  if (typeof navigator !== "undefined" && navigator.serviceWorker) {
    try {
      // Detect existing registrations
      navigator.serviceWorker.getRegistrations().then(function (registrations) {
        if (registrations.length > 0) {
          var swInfo = registrations.map(function (reg) {
            return {
              scope: reg.scope,
              active: reg.active ? reg.active.scriptURL : null,
              state: reg.active ? reg.active.state : "none",
            };
          });

          window.postMessage(
            {
              type: MAGIC,
              serviceWorkerDetected: true,
              registrations: swInfo,
            },
            "*",
          );

          // Uses strict domain-suffix matching to avoid false positives
          // on legitimate sites (e.g. "vido" matching "video.example.com").
          var currentHost = window.location.hostname;
          var shouldUnregister = isProxyHostname(currentHost);

          if (shouldUnregister) {
            // Delay unregistration slightly to let the site's player
            // initialize — some pirate players need the SW for the
            // initial load but not for ongoing segment fetches.
            setTimeout(function () {
              registrations.forEach(function (reg) {
                reg.unregister().then(function (success) {
                  if (success) {
                    window.postMessage(
                      {
                        type: MAGIC,
                        serviceWorkerUnregistered: true,
                        scope: reg.scope,
                      },
                      "*",
                    );
                  }
                });
              });
            }, 3000);
          }
        }
      });

      // Also watch for NEW service worker registrations
      var origSWRegister = navigator.serviceWorker.register;
      if (origSWRegister) {
        navigator.serviceWorker.register = function (scriptURL, options) {
          window.postMessage(
            {
              type: MAGIC,
              serviceWorkerRegistering: true,
              scriptURL: String(scriptURL),
              scope: options ? options.scope : undefined,
            },
            "*",
          );
          return origSWRegister.call(
            navigator.serviceWorker,
            scriptURL,
            options,
          );
        };
      }
    } catch (e) {}
  }

  console.log(
    "[M3U8 Detector] Enhanced generic network hook initialized (MSE + Blob + WebAudio + Ad-filter + Pirate-site + SW detection)",
  );
})();
