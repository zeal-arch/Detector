/**
 * Videasy / Vidsrc Source Hook
 *
 * Runs inside videasy/vidsrc player iframes (MAIN world) to intercept
 * decrypted video sources after the WASM → AES pipeline completes.
 *
 * The videasy/vidsrc player decrypts API responses through:
 *   1. WASM decrypt(ciphertext, tmdbId)
 *   2. CryptoJS.AES.decrypt(intermediate, "")
 *   3. JSON.parse(plaintext) → { sources: [...], subtitles: [...] }
 *
 * We hook JSON.parse to catch step 3 and relay the structured source
 * data to the parent frame (e.g. tmovie.tv) via window.parent.postMessage.
 *
 * This gives the extension:
 *   - Full source list with quality labels
 *   - Subtitle URLs and languages
 *   - Structured data instead of raw m3u8 URL detection
 */
(function () {
  "use strict";

  // Only run inside videasy/vidsrc player domains
  var _host = window.location.hostname;
  var _isVideasyDomain =
    _host.includes("videasy.net") ||
    _host.includes("videasy.") ||
    /(?:^|\.)vidsrc\.(cc|to|me|in|net|xyz)$/i.test(_host);
  if (!_isVideasyDomain) {
    return;
  }

  var TAG = "[VideasyHook]";
  var reported = new Set();
  var hookActive = false;

  // Tell the generic-network-hook to stand down — we handle detection
  window.__SPECIALIST_DETECTED = true;

  // ── Extract media info from the URL path ─────────────────────────
  // URL pattern: /tv/{tmdbId}/{season}/{episode}
  //              /movie/{tmdbId}
  //              /anime/{tmdbId}/{...}
  //              /v2/embed/tv/{tmdbId}/{season}/{episode}
  //              /v2/embed/movie/{tmdbId}
  function getMediaInfo() {
    var path = window.location.pathname;
    var tvMatch = path.match(/^\/tv\/(\d+)\/(\d+)\/(\d+)/);
    if (tvMatch) {
      return {
        mediaType: "tv",
        tmdbId: tvMatch[1],
        season: tvMatch[2],
        episode: tvMatch[3],
      };
    }
    var tvEmbedMatch = path.match(
      /^\/(?:v\d+\/)?embed\/tv\/(\d+)\/(\d+)\/(\d+)/,
    );
    if (tvEmbedMatch) {
      return {
        mediaType: "tv",
        tmdbId: tvEmbedMatch[1],
        season: tvEmbedMatch[2],
        episode: tvEmbedMatch[3],
      };
    }
    var movieMatch = path.match(/^\/movie\/(\d+)/);
    if (movieMatch) {
      return { mediaType: "movie", tmdbId: movieMatch[1] };
    }
    var movieEmbedMatch = path.match(/^\/(?:v\d+\/)?embed\/movie\/(\d+)/);
    if (movieEmbedMatch) {
      return { mediaType: "movie", tmdbId: movieEmbedMatch[1] };
    }
    var animeMatch = path.match(/^\/anime\/(\d+)/);
    if (animeMatch) {
      return { mediaType: "anime", tmdbId: animeMatch[1] };
    }
    return null;
  }

  // ── Validate that a parsed object looks like decoded sources ─────
  function isSourcesObject(obj) {
    if (!obj || typeof obj !== "object") return false;
    // Must have a sources array
    if (!Array.isArray(obj.sources)) return false;
    // Sources should contain objects with url/quality
    if (obj.sources.length === 0) return false;
    var first = obj.sources[0];
    if (!first || typeof first !== "object") return false;
    // Must have a url or file property
    return !!(first.url || first.file || first.link || first.src);
  }

  // ── Classify a source URL by stream type ──────────────────────────
  function classifySourceUrl(url) {
    if (!url || typeof url !== "string") return "UNKNOWN";
    if (/\.(m3u8)(\?|#|$)/i.test(url)) return "HLS";
    if (/\.(mpd)(\?|#|$)/i.test(url)) return "DASH";
    if (/\.(mp4|mkv|webm)(\?|#|$)/i.test(url)) return "MP4";
    // Known MP4 CDN domains
    if (/charliefreeman\.workers\.dev/i.test(url)) return "MP4";
    // Proxy domains — could be HLS or MP4, mark as PROXY
    if (/falseparadise\.workers\.dev/i.test(url)) return "PROXY";
    if (/trueparadise\.workers\.dev/i.test(url)) return "HLS";
    return "UNKNOWN";
  }

  // ── Detect if a source is audio-only from its metadata ───────────
  function isAudioSource(source) {
    var q = (source.quality || source.label || "").toLowerCase();
    if (/\baudio\b/i.test(q)) return true;
    var url = source.url || source.file || source.link || source.src || "";
    if (/[/.]audio[/.?]/i.test(url)) return true;
    return false;
  }

  // ── Relay sources to parent frame ────────────────────────────────
  function relaySources(sources) {
    // Build a fingerprint to avoid duplicate reports
    var urls = sources.sources
      .map(function (s) {
        return s.url || s.file || "";
      })
      .sort()
      .join("|");
    if (reported.has(urls)) return;
    reported.add(urls);

    var mediaInfo = getMediaInfo();

    var payload = {
      type: "VIDEASY_SOURCES",
      source: "VIDEASY_HOOK",
      data: {
        sources: sources.sources.map(function (s) {
          var url = s.url || s.file || s.link || s.src || "";
          return {
            url: url,
            quality: s.quality || s.label || "Auto",
            lang: s.lang || s.language || null,
            sourceType: classifySourceUrl(url),
            isAudio: isAudioSource(s),
          };
        }),
        subtitles: Array.isArray(sources.subtitles)
          ? sources.subtitles.map(function (s) {
              return {
                url: s.url || s.file || "",
                language: s.language || s.lang || s.label || "Unknown",
                lang: s.lang || null,
              };
            })
          : [],
        mediaInfo: mediaInfo,
        playerUrl: window.location.href,
        timestamp: Date.now(),
      },
    };

    console.log(
      TAG,
      "Relaying",
      payload.data.sources.length,
      "sources +",
      payload.data.subtitles.length,
      "subtitles to parent",
    );

    // Send to parent frame (tmovie.tv or whoever embedded us)
    try {
      window.parent.postMessage(payload, "*");
    } catch (e) {
      console.log(TAG, "postMessage to parent failed:", e.message);
    }

    // Also dispatch on current window for any local listeners
    try {
      window.postMessage(payload, "*");
    } catch (_) {}
  }

  // ── Hook JSON.parse to intercept decoded source data ─────────────
  var _origJSONParse = JSON.parse;

  JSON.parse = function (text) {
    var result = _origJSONParse.apply(this, arguments);

    // Check if the parsed result looks like decoded video sources
    try {
      if (isSourcesObject(result)) {
        console.log(
          TAG,
          "Intercepted decoded sources:",
          result.sources.length,
          "streams",
        );
        relaySources(result);
      }
    } catch (e) {
      // Don't break normal JSON.parse on error
    }

    return result;
  };

  // Preserve toString identity
  try {
    Object.defineProperty(JSON.parse, "toString", {
      value: function () {
        return "function parse() { [native code] }";
      },
    });
    Object.defineProperty(JSON.parse, "length", {
      value: _origJSONParse.length,
    });
  } catch (_) {}

  hookActive = true;
  console.log(TAG, "Source hook active on", window.location.href);

  // ── Also monitor for stream URLs in network requests ─────────────
  // In case JSON.parse hook misses something, also check fetch/XHR
  // responses for m3u8/mpd URLs

  var seenUrls = new Set();

  function checkForStreamUrl(url) {
    if (!url || typeof url !== "string") return;
    if (seenUrls.has(url)) return;

    var streamType = classifySourceUrl(url);
    // Only relay URLs that are clearly media streams or known CDN domains
    if (
      streamType === "UNKNOWN" &&
      !/\.(m3u8|mpd|mp4|mkv|webm)(\?|#|$)/i.test(url)
    )
      return;
    seenUrls.add(url);

    console.log(
      TAG,
      "Stream URL detected (" + streamType + "):",
      url.substring(0, 120),
    );

    var mediaInfo = getMediaInfo();
    try {
      window.parent.postMessage(
        {
          type: "VIDEASY_STREAM_URL",
          source: "VIDEASY_HOOK",
          data: {
            url: url,
            streamType:
              streamType === "MP4"
                ? "DIRECT"
                : streamType === "DASH"
                  ? "DASH"
                  : "HLS",
            mediaInfo: mediaInfo,
            playerUrl: window.location.href,
          },
        },
        "*",
      );
    } catch (_) {}
  }

  // Hook fetch
  var _origFetch = window.fetch;
  window.fetch = function (input) {
    var url = typeof input === "string" ? input : input && input.url;
    if (url) checkForStreamUrl(url);

    return _origFetch.apply(this, arguments).then(function (response) {
      // Check the response URL (may differ from request URL after redirects)
      if (response && response.url) checkForStreamUrl(response.url);
      return response;
    });
  };

  // Hook XHR
  var _origXHROpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__videasyUrl = url && url.toString ? url.toString() : url;
    if (this.__videasyUrl) checkForStreamUrl(this.__videasyUrl);
    return _origXHROpen.apply(this, arguments);
  };
})();
