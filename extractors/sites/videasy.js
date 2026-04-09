(function () {
  "use strict";

  const TAG = "[Videasy]";
  console.log(TAG, "Specialist loaded on:", window.location.href);

  window.__SPECIALIST_DETECTED = true;
  window.__VIDEASY_SPECIALIST_ACTIVE = true;

  // ══════════════════════════════════════════════════════════════════
  // ── STATE ─────────────────────────────────────────────────────────
  // ══════════════════════════════════════════════════════════════════
  const processedUrls = new Set();
  let _tmdbTitle = null;
  let _tmdbThumbnail = null;
  let _tmdbFetched = false;
  let _sourcesReported = false;

  function getEmbedHeaders() {
    const origin = window.location.origin;
    return {
      Referer: origin + "/",
      Origin: origin,
    };
  }

  // ── MEDIA INFO FROM URL ──────────────────────────────────────────
  // URL patterns:
  //   /tv/{tmdbId}/{season}/{episode}?...
  //   /movie/{tmdbId}?...
  //   /anime/{tmdbId}/...
  //   /v2/embed/tv/{tmdbId}/{season}/{episode}
  //   /v2/embed/movie/{tmdbId}
  function getMediaInfo() {
    const path = window.location.pathname;
    const tvMatch = path.match(/^\/tv\/(\d+)\/(\d+)\/(\d+)/);
    if (tvMatch) {
      return {
        mediaType: "tv",
        tmdbId: tvMatch[1],
        season: tvMatch[2],
        episode: tvMatch[3],
      };
    }
    const tvEmbedMatch = path.match(
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
    const movieMatch = path.match(/^\/movie\/(\d+)/);
    if (movieMatch) {
      return { mediaType: "movie", tmdbId: movieMatch[1] };
    }
    const movieEmbedMatch = path.match(/^\/(?:v\d+\/)?embed\/movie\/(\d+)/);
    if (movieEmbedMatch) {
      return { mediaType: "movie", tmdbId: movieEmbedMatch[1] };
    }
    const animeMatch = path.match(/^\/anime\/(\d+)/);
    if (animeMatch) {
      return { mediaType: "anime", tmdbId: animeMatch[1] };
    }
    return null;
  }

  // ── TITLE EXTRACTION ─────────────────────────────────────────────
  function getCleanTitle() {
    if (_tmdbTitle) return _tmdbTitle;

    // Try the document title
    let title = document.title || "";
    // videasy.net default title is "Videasy" — useless
    if (/^videasy$/i.test(title.trim())) title = "";

    // Try og:title / meta title
    if (!title) {
      const meta =
        document.querySelector('meta[property="og:title"]') ||
        document.querySelector('meta[name="title"]');
      if (meta) title = meta.getAttribute("content") || "";
    }

    // Fallback to media info
    if (!title) {
      const info = getMediaInfo();
      if (info) {
        if (info.mediaType === "tv") {
          title = `TV Show ${info.tmdbId} S${info.season}E${info.episode}`;
        } else {
          title = `Movie ${info.tmdbId}`;
        }
      }
    }

    return title.trim() || "Videasy Video";
  }

  function getThumbnail() {
    if (_tmdbThumbnail) return _tmdbThumbnail;

    const meta =
      document.querySelector('meta[property="og:image"]') ||
      document.querySelector('meta[name="thumbnail"]');
    if (meta) return meta.getAttribute("content") || null;

    const poster = document.querySelector("video[poster]");
    if (poster) return poster.poster || null;

    return null;
  }

  // ── TMDB API ─────────────────────────────────────────────────────
  // videasy.net proxies TMDB data via https://db.videasy.net/3/
  async function fetchTMDBInfo() {
    if (_tmdbFetched) return;
    _tmdbFetched = true;

    const info = getMediaInfo();
    if (!info) return;

    try {
      let url;
      if (info.mediaType === "tv") {
        url = `https://db.videasy.net/3/tv/${info.tmdbId}?append_to_response=external_ids&language=en`;
      } else {
        url = `https://db.videasy.net/3/movie/${info.tmdbId}?append_to_response=external_ids&language=en`;
      }

      const resp = await fetch(url);
      if (!resp.ok) return;
      const data = await resp.json();

      // Extract title
      if (info.mediaType === "tv") {
        const showName = data.name || data.original_name || "";
        if (showName && info.season && info.episode) {
          _tmdbTitle = `${showName} S${info.season.padStart(2, "0")}E${info.episode.padStart(2, "0")}`;
        } else {
          _tmdbTitle = showName;
        }
      } else {
        _tmdbTitle = data.title || data.original_title || "";
      }

      // Extract poster thumbnail
      const posterPath = data.poster_path || data.backdrop_path;
      if (posterPath) {
        _tmdbThumbnail = `https://image.tmdb.org/t/p/w500${posterPath}`;
      }

      if (_tmdbTitle) {
        console.log(TAG, "TMDB title:", _tmdbTitle);
      }
      if (_tmdbThumbnail) {
        console.log(TAG, "TMDB poster:", _tmdbThumbnail);
        // Push thumbnail update
        window.postMessage(
          {
            type: "SPECIALIST_THUMBNAIL_UPDATE",
            source: "SITE_SPECIALIST",
            data: { thumbnail: _tmdbThumbnail },
          },
          window.location.origin,
        );
      }
    } catch (e) {
      console.log(TAG, "TMDB fetch error:", e.message);
    }
  }

  // ── DISPATCH DETECTION ───────────────────────────────────────────
  function notifyVideo(data) {
    const key = data.url;
    if (processedUrls.has(key)) return;
    processedUrls.add(key);

    const title = getCleanTitle();
    const thumbnail = getThumbnail();

    const payload = {
      url: data.url,
      type: data.type || "HLS",
      options: {
        customTitle: title,
        thumbnail: thumbnail,
        quality: data.quality || null,
        pageUrl: window.location.href,
        detectionSource: data.detectionSource || "videasy-specialist",
        formats: data.formats || undefined,
        subtitles: data.subtitles || undefined,
        // CDN requests should mirror the active embed/player origin.
        headers: getEmbedHeaders(),
      },
    };

    console.log(
      TAG,
      "Dispatching:",
      data.url.substring(0, 100),
      data.quality || "",
    );

    window.postMessage(
      {
        type: "MAGIC_M3U8_DETECTION",
        source: "SITE_SPECIALIST",
        data: payload,
      },
      window.location.origin,
    );
  }

  // ── VIDEASY_SOURCES MESSAGE HANDLER ──────────────────────────────
  // The videasy-source-hook.js (running in the same MAIN world via
  // manifest content_scripts) hooks JSON.parse and posts VIDEASY_SOURCES
  // when it intercepts the decrypted sources object.
  //
  // When browsing player.videasy.net directly (not as iframe),
  // window.parent === window, so the postMessage arrives here.
  window.addEventListener("message", (event) => {
    if (!event.data) return;

    const parsed = event.data;
    if (!parsed || !parsed.type) return;

    // ── VIDEASY_SOURCES: structured quality data from the hook ──────
    if (parsed.type === "VIDEASY_SOURCES" && parsed.source === "VIDEASY_HOOK") {
      const { sources, subtitles, mediaInfo } = parsed.data || {};
      if (!sources || sources.length === 0) return;

      console.log(
        TAG,
        "Received VIDEASY_SOURCES:",
        sources.length,
        "sources,",
        (subtitles || []).length,
        "subtitles",
      );

      // ── Classify sources by type (HLS / DASH / MP4-DIRECT) ────────
      const classifyUrl = (url) => {
        if (!url) return "UNKNOWN";
        if (/\.(m3u8)(\?|#|$)/i.test(url)) return "HLS";
        if (/\.(mpd)(\?|#|$)/i.test(url)) return "DASH";
        if (/\.(mp4|mkv|webm)(\?|#|$)/i.test(url)) return "MP4";
        if (/charliefreeman\.workers\.dev/i.test(url)) return "MP4";
        if (/falseparadise\.workers\.dev/i.test(url)) return "PROXY";
        if (/trueparadise\.workers\.dev/i.test(url)) return "HLS";
        return "UNKNOWN";
      };

      const isAudioTrack = (s) => {
        const q = (s.quality || "").toLowerCase();
        if (/\baudio\b/.test(q)) return true;
        if (s.isAudio === true) return true;
        const url = s.url || "";
        if (/[/.]audio[/.?]/i.test(url)) return true;
        return false;
      };

      const is4KQuality = (q) => /\b(4k|uhd|2160)\b/i.test(q || "");

      // Separate by stream type
      const hlsSources = sources.filter(
        (s) => s.url && classifyUrl(s.url) === "HLS",
      );
      const dashSources = sources.filter(
        (s) => s.url && classifyUrl(s.url) === "DASH",
      );
      const mp4Sources = sources.filter(
        (s) =>
          s.url &&
          (classifyUrl(s.url) === "MP4" || classifyUrl(s.url) === "PROXY"),
      );
      const allValid = sources.filter((s) => s.url);

      // Preferred order: HLS > DASH > MP4 > any
      const streamingSources =
        hlsSources.length > 0
          ? hlsSources
          : dashSources.length > 0
            ? dashSources
            : allValid;

      if (allValid.length === 0) return;

      // Check split audio/video among MP4 sources
      const mp4Audio = mp4Sources.filter((s) => isAudioTrack(s));
      const mp4Video = mp4Sources.filter((s) => !isAudioTrack(s));
      const hasSplitTracks = mp4Audio.length > 0 && mp4Video.length > 0;

      console.log(
        TAG,
        "Source breakdown: HLS=" + hlsSources.length,
        "DASH=" + dashSources.length,
        "MP4=" + mp4Sources.length,
        "(audio=" + mp4Audio.length + " video=" + mp4Video.length + ")",
        "split=" + hasSplitTracks,
      );

      const primary = streamingSources[0];
      const primaryType = classifyUrl(primary.url);

      // Build formats array with proper type/mimeType per source
      const formats = [];

      // Add HLS/DASH formats (muxed streams)
      for (const s of streamingSources) {
        const sType = classifyUrl(s.url);
        if (sType === "HLS" || sType === "DASH") {
          formats.push({
            url: s.url,
            mimeType:
              sType === "DASH"
                ? "application/dash+xml"
                : "application/x-mpegurl",
            quality: s.quality || "Auto",
            qualityLabel: s.quality || "Auto",
            isVideo: true,
            isMuxed: true,
            isHLS: sType === "HLS",
            ext: "mp4",
          });
        }
      }

      // Add MP4/direct formats — properly flag audio vs video
      for (const s of mp4Sources) {
        const audio = isAudioTrack(s);
        formats.push({
          url: s.url,
          mimeType: audio ? "audio/mp4" : "video/mp4",
          quality: s.quality || "Auto",
          qualityLabel: s.quality || (audio ? "Audio" : "Auto"),
          isVideo: !audio,
          isAudio: audio,
          isMuxed: !hasSplitTracks && !audio,
          isHLS: false,
          isDirect: true,
          is4K: is4KQuality(s.quality),
          ext: "mp4",
        });
      }

      // Fallback: if no formats classified, treat all as HLS
      if (formats.length === 0) {
        for (const s of allValid) {
          formats.push({
            url: s.url,
            mimeType: "application/x-mpegurl",
            quality: s.quality || "Auto",
            qualityLabel: s.quality || "Auto",
            isVideo: true,
            isMuxed: true,
            isHLS: true,
            ext: "mp4",
          });
        }
      }

      // Build subtitle list
      const subs = (subtitles || [])
        .filter((s) => s.url)
        .map((s) => ({
          url: s.url,
          language: s.language || "Unknown",
          lang: s.lang || null,
        }));

      // Determine primary stream type
      const dispatchType =
        primaryType === "MP4" || primaryType === "PROXY"
          ? "DIRECT"
          : primaryType === "DASH"
            ? "DASH"
            : "HLS";

      notifyVideo({
        url: primary.url,
        type: dispatchType,
        quality: primary.quality || null,
        formats: formats.length > 1 ? formats : undefined,
        subtitles: subs.length > 0 ? subs : undefined,
        detectionSource: "videasy-hook",
        has4K: formats.some((f) => f.is4K),
      });

      _sourcesReported = true;
      return;
    }

    // ── VIDEASY_STREAM_URL: fallback raw m3u8/mpd URL from the hook ─
    if (
      parsed.type === "VIDEASY_STREAM_URL" &&
      parsed.source === "VIDEASY_HOOK"
    ) {
      const { url: streamUrl, streamType: sType } = parsed.data || {};
      if (!streamUrl || _sourcesReported) return;

      console.log(
        TAG,
        "VIDEASY_STREAM_URL fallback:",
        streamUrl.substring(0, 120),
      );
      notifyVideo({
        url: streamUrl,
        type: sType || "HLS",
        detectionSource: "videasy-hook-fallback",
      });
      return;
    }
  });

  // ── DIRECT DETECTION (fallback if hook doesn't fire) ─────────────
  // Monitor for m3u8 URLs in network requests as a safety net.
  const _origFetch = window.fetch;
  const _origXHROpen = XMLHttpRequest.prototype.open;
  const seenStreamUrls = new Set();

  function onStreamUrl(url) {
    if (!url || typeof url !== "string") return;
    if (seenStreamUrls.has(url)) return;
    if (
      !/\.(m3u8|mpd|mp4)(\?|#|$)/i.test(url) &&
      !/charliefreeman\.workers\.dev/i.test(url)
    )
      return;

    // Skip ad/tracker URLs
    if (
      /doubleclick|googlesyndication|google-analytics|facebook\.net/i.test(url)
    )
      return;

    seenStreamUrls.add(url);

    if (_sourcesReported) {
      console.log(
        TAG,
        "Skipping direct URL (sources already reported):",
        url.substring(0, 80),
      );
      return;
    }

    console.log(TAG, "Direct stream URL detected:", url.substring(0, 120));

    // Try to extract quality from the URL
    // Pattern: /BASE64_QUALITY==/index.m3u8
    let quality = null;
    const b64Match = url.match(/\/([A-Za-z0-9+/]+=*)\/[^/]+\.m3u8/);
    if (b64Match) {
      try {
        const decoded = atob(b64Match[1]);
        if (/^\d{3,4}p?$/.test(decoded)) {
          quality = decoded.replace(/p$/, "") + "p";
        }
      } catch (_) {}
    }

    const streamType =
      /\.(mp4|mkv|webm)(\?|#|$)/i.test(url) ||
      /charliefreeman\.workers\.dev/i.test(url)
        ? "DIRECT"
        : /\.mpd(\?|#|$)/i.test(url)
          ? "DASH"
          : "HLS";

    notifyVideo({
      url: url,
      type: streamType,
      quality: quality,
      detectionSource: "videasy-network",
    });
  }

  window.fetch = function (input) {
    const url = typeof input === "string" ? input : input?.url;
    if (url) onStreamUrl(url);

    return _origFetch.apply(this, arguments).then(function (response) {
      if (response?.url) onStreamUrl(response.url);
      return response;
    });
  };

  // Preserve fetch identity
  try {
    Object.defineProperty(window.fetch, "toString", {
      value: function () {
        return _origFetch.toString();
      },
    });
  } catch (_) {}

  XMLHttpRequest.prototype.open = function (method, url) {
    if (url) {
      const urlStr = typeof url === "string" ? url : url.toString();
      onStreamUrl(urlStr);
    }
    return _origXHROpen.apply(this, arguments);
  };

  // ── BOOTSTRAP ────────────────────────────────────────────────────
  function bootstrap() {
    console.log(TAG, "Bootstrap on", window.location.href.substring(0, 100));
    fetchTMDBInfo();
  }

  if (
    document.readyState === "complete" ||
    document.readyState === "interactive"
  ) {
    bootstrap();
  } else {
    window.addEventListener("DOMContentLoaded", bootstrap);
  }

  // ── SPA NAVIGATION ───────────────────────────────────────────────
  // videasy.net uses Next.js with client-side routing
  let lastUrl = window.location.href;

  function onNavigate() {
    const currentUrl = window.location.href;
    if (currentUrl === lastUrl) return;
    console.log(TAG, "Navigation:", currentUrl.substring(0, 100));
    lastUrl = currentUrl;

    // Reset state
    processedUrls.clear();
    seenStreamUrls.clear();
    _tmdbTitle = null;
    _tmdbThumbnail = null;
    _tmdbFetched = false;
    _sourcesReported = false;

    fetchTMDBInfo();
  }

  window.addEventListener("popstate", onNavigate);

  try {
    const origPush = history.pushState;
    const origReplace = history.replaceState;
    history.pushState = function () {
      const result = origPush.apply(this, arguments);
      setTimeout(onNavigate, 100);
      return result;
    };
    history.replaceState = function () {
      const result = origReplace.apply(this, arguments);
      setTimeout(onNavigate, 100);
      return result;
    };
  } catch (_) {}

  console.log(TAG, "Specialist initialised — listening for decoded sources");
})();
