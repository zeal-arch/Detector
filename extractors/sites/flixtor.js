(function () {
  "use strict";

  const TAG = "[Flixtor]";
  console.log(TAG, "Specialist loaded");

  window.__SPECIALIST_DETECTED = true;
  window.__FLIXTOR_SPECIALIST_ACTIVE = true;

  // ── State ──────────────────────────────────────────────────────────
  const processedUrls = new Set();
  let detectionTimeout = null;
  let lastPageUrl = window.location.href;
  let mseRetryTimer = null;
  const trackedTimers = new Set();
  let domObserver = null;
  let videoEventsBound = new WeakSet();

  // ── Ad / tracker URL patterns ───────────────────────────────────
  const AD_URL_PATTERNS = [
    // Google ad ecosystem
    /doubleclick\.net/i,
    /googlesyndication\.com/i,
    /googletagmanager\.com/i,
    /googleads\./i,
    /google-analytics\.com/i,
    /securepubads\.g\.doubleclick\.net/i,
    /imasdk\.googleapis\.com/i,
    /pagead2\.googlesyndication\.com/i,

    // Social / mainstream ad SDKs
    /facebook\.net\/.*\/sdk/i,
    /adnxs\.com/i,
    /amazon-adsystem\.com/i,
    /outbrain\.com/i,
    /taboola\.com/i,

    // Pop-under / redirect networks (pirate streaming)
    /popads\.net/i,
    /popcash\.net/i,
    /onclicka\.com/i,
    /dolohen\.com/i,
    /trafogrand\.com/i,
    /go\.oclasrv\.com/i,
    /adskeeper\.co\.uk/i,
    /syndication\.realsrv\.com/i,
    /a\.realsrv\.com/i,
    /tsyndicate\.com/i,
    /trk\.nzbrn\.com/i,

    // Ad networks prevalent on pirate sites
    /propellerads\.com/i,
    /exoclick\.com/i,
    /a\.magsrv\.com/i,
    /syndication\.exoclick\.com/i,
    /juicyads\.com/i,
    /trafficjunky\.net/i,
    /bidvertiser\.com/i,
    /hilltopads\.net/i,
    /clickadu\.com/i,
    /adsterra\.com/i,
    /a-ads\.com/i,
    /coinzilla\.com/i,

    // Video ad servers / VAST / VPAID
    /vidazoo\.com/i,
    /springserve\.com/i,
    /spotx\.tv/i,
    /spotxchange\.com/i,
    /connatix\.com/i,
    /teads\.tv/i,
    /tremorhub\.com/i,
    /ad\.71i\.de/i,
    /served-by\.pixfuture\.com/i,

    // VAST / VPAID / pre-roll path patterns
    /\/vast[\/\?]/i,
    /\/vpaid[\/\?]/i,
    /\/preroll[\/\?]/i,
    /\/midroll[\/\?]/i,
    /\/adbreak[\/\?]/i,
    /\/ad_tag[\/\?]/i,
    /[?&]ad_type=/i,
    /[?&]vastUrl=/i,
    /[?&]vast_url=/i,
    /\/ima3?[\/\?]/i,
    /\/ads\/master\.m3u8/i,

    // Overlay / interstitial CDNs
    /ad\.atdmt\.com/i,
    /cdn\.adsafeprotected\.com/i,
    /static\.adsafeprotected\.com/i,
    /cdn\.districtm\.io/i,
    /cdn\.pubfuture\.com/i,
  ];

  // Known embed / CDN domains used by Flixtor and similar streaming sites
  const EMBED_DOMAINS = [
    "rabbitstream.net",
    "megacloud.tv",
    "vidcloud.co",
    "mycloud.to",
    "rapid-cloud.co",
    "vidplay.site",
    "dokicloud.one",
    "vidstreaming.io",
    "filemoon.sx",
    "streamtape.com",
    "doodstream.com",
    "mixdrop.co",
    "voe.sx",
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
    "xcdn.to",
  ];

  // Known ad CDN domains (streams from these are almost certainly ads)
  const AD_CDN_DOMAINS = [
    "imasdk.googleapis.com",
    "vid.springserve.com",
    "vid.spotxchange.com",
    "delivery.vidazoo.com",
    "ads.stickyadstv.com",
    "cdn.adsrvr.org",
    "creative.ad.admixer.net",
    "cdn.connatix.com",
  ];

  // ── Smart stream candidate system ─────────────────────────────────
  // Instead of immediately notifying every stream URL, we collect
  // candidates and after a debounce window, pick the best one.
  const MIN_VIDEO_DURATION = 45; // seconds — anything shorter is likely an ad
  const CANDIDATE_DEBOUNCE_MS = 2500; // wait 2.5s after last candidate before deciding
  const streamCandidates = []; // { url, type, title, score, timestamp, meta }
  let candidateTimer = null;

  // ── Helpers ────────────────────────────────────────────────────────
  function isAdUrl(url) {
    if (!url || typeof url !== "string") return false;
    return AD_URL_PATTERNS.some((re) => re.test(url));
  }

  function isAdCDN(url) {
    try {
      const hostname = new URL(url).hostname;
      return AD_CDN_DOMAINS.some(
        (d) => hostname === d || hostname.endsWith("." + d),
      );
    } catch (_) {
      return false;
    }
  }

  function isStreamUrl(url) {
    return /\.(m3u8|mpd)(\?|#|$)/i.test(url);
  }

  function streamType(url) {
    return /\.mpd(\?|#|$)/i.test(url) ? "DASH" : "HLS";
  }

  /**
   * Check if a manifest's content looks like an ad (short, few segments).
   * Returns true if the manifest is likely an ad pre-roll/mid-roll.
   */
  function isAdManifest(text) {
    if (!text || typeof text !== "string") return false;
    const trimmed = text.trimStart();

    // HLS manifest ad detection
    if (trimmed.startsWith("#EXTM3U") || trimmed.startsWith("#EXT-X-")) {
      // Count media segments
      const segmentCount = (text.match(/#EXTINF:/g) || []).length;

      // Calculate total duration from EXTINF tags
      let totalDuration = 0;
      const durationMatches = text.matchAll(/#EXTINF:\s*([\d.]+)/g);
      for (const m of durationMatches) {
        totalDuration += parseFloat(m[1]);
      }

      // Short manifests with few segments are likely ads
      if (segmentCount > 0 && segmentCount <= 5 && totalDuration < 35) {
        console.log(
          TAG,
          `Ad manifest detected: ${segmentCount} segments, ${totalDuration.toFixed(1)}s total`,
        );
        return true;
      }

      // Check for SCTE-35 / CUE-OUT ad markers
      if (
        /#EXT-X-CUE-OUT/i.test(text) ||
        /#EXT-X-DATERANGE:.*SCTE35/i.test(text) ||
        (/#EXT-X-DISCONTINUITY/i.test(text) &&
          segmentCount <= 8 &&
          totalDuration < 45)
      ) {
        console.log(TAG, "Ad manifest: SCTE-35/CUE-OUT markers found");
        return true;
      }

      // Master playlist referencing only very low bitrate (ad placeholder)
      if (/#EXT-X-STREAM-INF/i.test(text) && !/#EXTINF:/i.test(text)) {
        // This is a master playlist — not an ad itself, score it higher later
        return false;
      }
    }

    // DASH manifest ad detection
    if (trimmed.includes("<MPD") || trimmed.includes("<Period")) {
      // Very short DASH manifests
      const durationMatch = text.match(
        /mediaPresentationDuration="PT(?:(\d+)H)?(?:(\d+)M)?([\d.]+)S"/i,
      );
      if (durationMatch) {
        const hours = parseInt(durationMatch[1] || "0", 10);
        const minutes = parseInt(durationMatch[2] || "0", 10);
        const seconds = parseFloat(durationMatch[3] || "0");
        const totalSec = hours * 3600 + minutes * 60 + seconds;
        if (totalSec < 35) {
          console.log(
            TAG,
            `Ad DASH manifest: duration ${totalSec.toFixed(1)}s`,
          );
          return true;
        }
      }

      // Period with ad signaling
      if (/<Period[^>]*id="[^"]*ad[^"]*"/i.test(text)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Score a stream candidate. Higher = more likely to be real content.
   *  +100 : known long duration (> MIN_VIDEO_DURATION)
   *  +20  : master playlist (contains variant streams)
   *  +10  : late arrival (not the first stream detected)
   *  -200 : ad URL pattern match
   *  -150 : ad CDN domain
   *  -100 : known short duration (ad-length)
   *  -80  : ad manifest content (few segments, short duration)
   *  -30  : CDN domain mismatch (stream domain ≠ page TLD and is not a
   *          known embed domain — may be an ad server)
   */
  function scoreCandidate(candidate) {
    let score = 0;
    const url = candidate.url;

    // Hard disqualifiers
    if (isAdUrl(url)) score -= 200;
    if (isAdCDN(url)) score -= 150;
    if (candidate.meta?.isAdManifest) score -= 80;

    // Duration-based scoring
    if (candidate.meta?.duration > 0) {
      if (candidate.meta.duration >= MIN_VIDEO_DURATION) {
        score += 100;
      } else {
        score -= 100; // ad-length video
      }
    }

    // Master playlist bonus (contains EXT-X-STREAM-INF)
    if (candidate.meta?.isMaster) score += 20;

    // Late arrival bonus: streams detected later are typically the main
    // content (ads load first to fill pre-roll time)
    if (streamCandidates.length > 1) {
      score += 10;
    }

    // CDN domain mismatch heuristic
    if (url.startsWith("http")) {
      try {
        const streamHost = new URL(url).hostname;
        const pageHost = window.location.hostname;
        const streamTLD = streamHost.split(".").slice(-2).join(".");
        const pageTLD = pageHost.split(".").slice(-2).join(".");
        if (
          streamTLD !== pageTLD &&
          !isEmbedDomain(url) &&
          !EMBED_DOMAINS.some((d) => streamHost.includes(d))
        ) {
          // Unknown external domain — minor penalty
          score -= 30;
        }
      } catch (_) {}
    }

    return score;
  }

  function trackedTimeout(fn, ms) {
    const id = setTimeout(() => {
      trackedTimers.delete(id);
      fn();
    }, ms);
    trackedTimers.add(id);
    return id;
  }

  function getCleanTitle() {
    // Try to extract episode-specific title from URL first
    // URL patterns: /watch/tv/{id}/{show}/season/{s}/episode/{e}
    //               /watch/movie/{id}/{title}
    const path = window.location.pathname;
    const tvMatch = path.match(
      /\/watch\/tv\/\d+\/([^/]+)\/season\/(\d+)\/episode\/(\d+)/i,
    );
    if (tvMatch) {
      const showName = tvMatch[1]
        .replace(/-/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
      const season = tvMatch[2].padStart(2, "0");
      const episode = tvMatch[3].padStart(2, "0");

      // Try to find episode title from the page
      let epTitle = "";
      // Check the player status text (e.g. "Paused: Hijack, Season 2, Episode 6")
      const statusEl = document.querySelector(
        '.jw-title-primary, .player-title, [class*="title"][class*="episode"]',
      );
      if (statusEl && statusEl.textContent) {
        const epName = statusEl.textContent
          .replace(/^(Paused|Playing|Buffering):\s*/i, "")
          .replace(/,?\s*Season\s*\d+/i, "")
          .replace(/,?\s*Episode\s*\d+/i, "")
          .replace(new RegExp(showName.replace(/\s+/g, "\\s+"), "i"), "")
          .replace(/^[,\s-]+|[,\s-]+$/g, "")
          .trim();
        if (epName && epName.length > 1 && epName.length < 80) {
          epTitle = " - " + epName;
        }
      }

      // Also try episode title from episode list (highlighted/active row)
      if (!epTitle) {
        const activeEp = document.querySelector(
          "tr.active td:nth-child(2), .episode-item.active .title, " +
            '.episode.selected .name, [class*="episode"][class*="active"] a',
        );
        if (activeEp && activeEp.textContent?.trim()) {
          epTitle = " - " + activeEp.textContent.trim();
        }
      }

      return `${showName} S${season}E${episode}${epTitle}`;
    }

    // Movie: clean up the page title
    const movieMatch = path.match(/\/watch\/movie\/\d+\/([^/]+)/i);
    if (movieMatch) {
      const movieName = movieMatch[1]
        .replace(/-/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
      // Extract year from page title if available
      const yearMatch = document.title.match(/\((\d{4})\)/);
      return yearMatch ? `${movieName} (${yearMatch[1]})` : movieName;
    }

    // Fallback: clean page title
    return (
      document.title
        .replace(/\s*[-|]\s*Flixtor.*$/i, "")
        .replace(/\s+on\s+Flixtor.*$/i, "")
        .replace(/^Watch\s+(all\s+Episodes\s+of\s+)?/i, "")
        .trim() || document.title
    );
  }

  /**
   * Lightweight DRM check on manifest text.
   * Returns { hasDRM, drmType } or null.
   */
  function checkManifestDRM(text) {
    if (!text || typeof text !== "string") return null;
    const trimmed = text.trimStart();

    // HLS DRM detection
    if (trimmed.startsWith("#EXTM3U") || trimmed.startsWith("#EXT-X-")) {
      const drmPatterns = [
        {
          re: /#EXT-X-(?:SESSION-)?KEY:.*?URI="skd:\/\//,
          type: "FairPlay",
        },
        {
          re: /#EXT-X-(?:SESSION-)?KEY:.*?KEYFORMAT="com\.apple\.streamingkeydelivery"/,
          type: "FairPlay",
        },
        {
          re: /#EXT-X-(?:SESSION-)?KEY:.*?KEYFORMAT="com\.microsoft\.playready"/,
          type: "PlayReady",
        },
        {
          re: /#EXT-X-(?:SESSION-)?KEY:.*?KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/,
          type: "Widevine",
        },
        {
          re: /#EXT-X-(?:SESSION-)?KEY:.*?KEYFORMAT="urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95"/,
          type: "PlayReady",
        },
        { re: /#EXT-X-FAXS-CM:/, type: "FlashAccess" },
      ];
      for (const p of drmPatterns) {
        if (p.re.test(text)) return { hasDRM: true, drmType: p.type };
      }
    }

    // DASH DRM detection
    if (trimmed.includes("<MPD") || trimmed.includes("<ContentProtection")) {
      if (/<ContentProtection[^>]*>/i.test(text)) {
        let drmType = "DRM";
        if (/edef8ba9-79d6-4ace-a3c8-27dcd51d21ed/i.test(text))
          drmType = "Widevine";
        else if (/9a04f079-9840-4286-ab92-e65be0885f95/i.test(text))
          drmType = "PlayReady";
        return { hasDRM: true, drmType };
      }
    }

    return null;
  }

  // ── Notify (candidate-based) ────────────────────────────────────
  /**
   * Queue a stream candidate for scoring. After a debounce window
   * with no new candidates, the best one is dispatched.
   * Immediate dispatch is used when the candidate is a clear winner
   * (e.g. known long duration, master playlist).
   */
  function notifyVideo(videoData) {
    const url = videoData.url;
    if (!url || typeof url !== "string") return;
    if (processedUrls.has(url)) return;
    if (isAdUrl(url)) {
      console.log(TAG, "Blocked ad URL:", url.substring(0, 100));
      return;
    }
    if (isAdCDN(url)) {
      console.log(TAG, "Blocked ad CDN:", url.substring(0, 100));
      return;
    }

    processedUrls.add(url);

    const candidate = {
      url: url,
      type: videoData.type || "HLS",
      title: videoData.title || getCleanTitle(),
      thumbnail: videoData.thumbnail || null,
      quality: videoData.quality || null,
      isDRM: videoData.isDRM || false,
      drmType: videoData.drmType || null,
      meta: videoData.meta || {},
      timestamp: Date.now(),
    };

    candidate.score = scoreCandidate(candidate);

    // Hard-reject candidates with very negative scores
    if (candidate.score <= -100) {
      console.log(
        TAG,
        `Rejected stream (score ${candidate.score}):`,
        url.substring(0, 100),
      );
      return;
    }

    streamCandidates.push(candidate);
    console.log(
      TAG,
      `Candidate queued (score ${candidate.score}):`,
      url.substring(0, 120),
    );

    // If this is a high-confidence or reasonable candidate, dispatch immediately
    if (candidate.score >= 10) {
      dispatchBestCandidate();
      return;
    }

    // Otherwise, debounce: wait for more candidates
    if (candidateTimer) clearTimeout(candidateTimer);
    candidateTimer = trackedTimeout(
      dispatchBestCandidate,
      CANDIDATE_DEBOUNCE_MS,
    );
  }

  /**
   * Pick the best candidate from the queue and dispatch it.
   */
  function dispatchBestCandidate() {
    if (candidateTimer) {
      clearTimeout(candidateTimer);
      candidateTimer = null;
    }
    if (streamCandidates.length === 0) return;

    // Sort by score descending, then by timestamp (prefer later arrivals)
    streamCandidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.timestamp - a.timestamp;
    });

    const best = streamCandidates[0];
    console.log(
      TAG,
      `Dispatching best of ${streamCandidates.length} candidates (score ${best.score}):`,
      best.url.substring(0, 120),
    );

    // Clear candidates (keep URLs in processedUrls to avoid re-detection)
    streamCandidates.length = 0;

    const payload = {
      url: best.url,
      type: best.type,
      options: {
        customTitle: best.title,
        thumbnail: best.thumbnail,
        quality: best.quality,
        pageUrl: window.location.href,
        detectionSource: "flixtor-specialist",
      },
    };

    // If the master playlist was parsed, include variant streams as formats
    // so the popup can show quality options (720p, 1080p, etc.)
    if (best.meta?.variants && best.meta.variants.length > 0) {
      payload.options.formats = best.meta.variants.map((v) => ({
        url: v.url,
        mimeType: "application/x-mpegurl",
        quality: v.qualityLabel || "Auto",
        qualityLabel: v.qualityLabel || "Auto",
        width: v.width || 0,
        height: v.height || 0,
        bandwidth: v.bandwidth || 0,
        isVideo: true,
        isMuxed: true,
        isHLS: true,
        ext: "mp4",
      }));
      console.log(
        TAG,
        `Sending ${payload.options.formats.length} quality variants to popup`,
      );
    }

    // Forward duration so the popup can display it
    if (best.meta?.duration) {
      payload.options.duration = best.meta.duration;
    }

    if (best.isDRM) {
      payload.options.isDRM = true;
      payload.options.drmType = best.drmType || "DRM";
    }

    window.postMessage(
      {
        type: "MAGIC_M3U8_DETECTION",
        source: "SITE_SPECIALIST",
        data: payload,
      },
      window.location.origin,
    );

    window.__SPECIALIST_DETECTED = true;

    // Prevent variant sub-playlists from triggering a second detection
    // that would overwrite the master+variants in the popup
    if (best.meta?.variants) {
      for (const v of best.meta.variants) {
        if (v.url) processedUrls.add(v.url);
      }
    }

    console.log(
      TAG,
      "Video detected:",
      best.url.substring(0, 120),
      best.isDRM ? "(DRM:" + best.drmType + ")" : "",
    );
  }

  /**
   * Parse #EXT-X-STREAM-INF variants from a master playlist.
   * Returns an array of { url, bandwidth, width, height, qualityLabel }.
   */
  function parseMasterVariants(masterText, masterUrl) {
    const variants = [];
    const lines = masterText.split(/\r?\n/);
    let baseUrl = masterUrl;
    try {
      // Resolve base: strip the filename from master URL
      const u = new URL(masterUrl);
      baseUrl = u.href.substring(0, u.href.lastIndexOf("/") + 1);
    } catch (_) {}

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line.startsWith("#EXT-X-STREAM-INF:")) continue;

      // Parse attributes
      const bwMatch = line.match(/BANDWIDTH=(\d+)/);
      const resMatch = line.match(/RESOLUTION=(\d+)x(\d+)/);
      const nameMatch = line.match(/NAME="([^"]+)"/);

      // Next non-empty, non-comment line is the variant URI
      let variantUri = null;
      for (let j = i + 1; j < lines.length; j++) {
        const nextLine = lines[j].trim();
        if (nextLine && !nextLine.startsWith("#")) {
          variantUri = nextLine;
          break;
        }
      }
      if (!variantUri) continue;

      // Resolve relative URLs
      let fullUrl;
      try {
        fullUrl = new URL(variantUri, baseUrl).href;
      } catch (_) {
        fullUrl = variantUri;
      }

      const width = resMatch ? parseInt(resMatch[1], 10) : 0;
      const height = resMatch ? parseInt(resMatch[2], 10) : 0;
      const bandwidth = bwMatch ? parseInt(bwMatch[1], 10) : 0;
      const qualityLabel = nameMatch
        ? nameMatch[1]
        : height
          ? height + "p"
          : bandwidth
            ? Math.round(bandwidth / 1000) + "kbps"
            : "Auto";

      variants.push({ url: fullUrl, bandwidth, width, height, qualityLabel });
    }

    // Sort by height descending (best first)
    variants.sort((a, b) => (b.height || 0) - (a.height || 0));
    return variants;
  }

  // ── Deep JSON search (shared by XHR & fetch hooks) ─────────────────
  const PRIORITY_KEYS = [
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

  function findStreamUrl(obj, depth) {
    if (depth === undefined) depth = 0;
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
      const entries = Object.entries(obj);
      const sorted = entries.sort(([a], [b]) => {
        const aP = PRIORITY_KEYS.some((k) => a.toLowerCase().includes(k))
          ? -1
          : 0;
        const bP = PRIORITY_KEYS.some((k) => b.toLowerCase().includes(k))
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
  }

  /**
   * Inspect a response body for stream URLs.
   * Shared by XHR and fetch hooks. Applies manifest ad detection.
   */
  function inspectResponseBody(text, requestUrl) {
    if (!text || typeof text !== "string") return;

    const trimmed = text.trimStart();

    // Response itself is an HLS manifest
    if (trimmed.startsWith("#EXTM3U") || trimmed.startsWith("#EXT-X-")) {
      // P3/P4: Check if manifest is an ad
      if (isAdManifest(text)) {
        console.log(
          TAG,
          "Skipping ad manifest:",
          requestUrl?.substring(0, 100),
        );
        return;
      }

      const drm = checkManifestDRM(text);
      const isMaster = /#EXT-X-STREAM-INF/i.test(text);

      // Extract duration info from media playlists
      let totalDuration = 0;
      const durMatches = text.matchAll(/#EXTINF:\s*([\d.]+)/g);
      for (const m of durMatches) totalDuration += parseFloat(m[1]);

      // Parse variant streams from master playlist
      let variants = null;
      if (isMaster && requestUrl) {
        variants = parseMasterVariants(text, requestUrl);
      }

      notifyVideo({
        url: requestUrl,
        type: "HLS",
        title: getCleanTitle(),
        isDRM: drm ? drm.hasDRM : false,
        drmType: drm ? drm.drmType : null,
        meta: {
          isMaster,
          duration: totalDuration > 0 ? totalDuration : undefined,
          variants: variants && variants.length > 0 ? variants : undefined,
        },
      });
      return;
    }

    // Response itself is a DASH manifest
    if (trimmed.startsWith("<?xml") && trimmed.includes("<MPD")) {
      if (isAdManifest(text)) {
        console.log(
          TAG,
          "Skipping ad DASH manifest:",
          requestUrl?.substring(0, 100),
        );
        return;
      }

      const drm = checkManifestDRM(text);
      notifyVideo({
        url: requestUrl,
        type: "DASH",
        title: getCleanTitle(),
        isDRM: drm ? drm.hasDRM : false,
        drmType: drm ? drm.drmType : null,
        meta: {},
      });
      return;
    }

    // Search for m3u8/mpd URLs in response body
    if (text.includes(".m3u8") || text.includes(".mpd")) {
      const m3u8Match = text.match(
        /(https?:\/\/[^"'\s<>]+\.m3u8(?:\?[^"'\s<>]*)?)/i,
      );
      if (m3u8Match && !isAdUrl(m3u8Match[1]) && !isAdCDN(m3u8Match[1])) {
        notifyVideo({
          url: m3u8Match[1],
          type: "HLS",
          title: getCleanTitle(),
        });
      }
      const mpdMatch = text.match(
        /(https?:\/\/[^"'\s<>]+\.mpd(?:\?[^"'\s<>]*)?)/i,
      );
      if (mpdMatch && !isAdUrl(mpdMatch[1]) && !isAdCDN(mpdMatch[1])) {
        notifyVideo({
          url: mpdMatch[1],
          type: "DASH",
          title: getCleanTitle(),
        });
      }
    }

    // Deep JSON search
    if (text.startsWith("{") || text.startsWith("[")) {
      try {
        const json = JSON.parse(text);
        const streamUrl = findStreamUrl(json);
        if (streamUrl && !isAdUrl(streamUrl) && !isAdCDN(streamUrl)) {
          notifyVideo({
            url: streamUrl,
            type: streamType(streamUrl),
            title: json.title || json.name || getCleanTitle(),
          });
        }
      } catch (_) {
        // Not valid JSON — ignore
      }
    }
  }

  // Domains we should never intercept in XHR/fetch wrappers (third-party
  // services that trigger CSP connect-src violations when called through
  // our wrapper or whose responses are irrelevant to stream detection)
  const INTERCEPT_SKIP_DOMAINS = [
    "jwplayer.com",
    "jwpltx.com",
    "jwpsrv.com",
    "jwpcdn.com",
    "googlesyndication.com",
    "google-analytics.com",
    "googletagmanager.com",
    "doubleclick.net",
    "facebook.net",
    "sentry.io",
  ];

  function shouldSkipIntercept(url) {
    try {
      if (!url || !url.startsWith("http")) return false;
      const hostname = new URL(url).hostname;
      return INTERCEPT_SKIP_DOMAINS.some(
        (d) => hostname === d || hostname.endsWith("." + d),
      );
    } catch (_) {
      return false;
    }
  }

  // ── XHR interception ──────────────────────────────────────────────
  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...args) {
    this._requestUrl = typeof url === "string" ? url : url?.toString?.() || "";
    return originalXHROpen.call(this, method, url, ...args);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const reqUrl = this._requestUrl || "";

    // Pass through third-party requests without wrapping to avoid CSP noise
    if (shouldSkipIntercept(reqUrl)) {
      return originalXHRSend.call(this, body);
    }

    this.addEventListener("load", function () {
      try {
        const _url = this._requestUrl || "";
        if (isAdUrl(_url)) return;

        // For m3u8/mpd URLs, let inspectResponseBody handle them — it
        // provides richer metadata (isMaster, variants, duration).
        // Only notify directly for non-manifest stream URLs (e.g. .mp4).
        if (
          typeof _url === "string" &&
          isStreamUrl(_url) &&
          !/\.m3u8|\b\.mpd/i.test(_url)
        ) {
          notifyVideo({
            url: _url,
            type: streamType(_url),
            title: getCleanTitle(),
          });
        }

        inspectResponseBody(this.responseText, _url);
      } catch (e) {
        // Silence CSP/cross-origin DOMExceptions from third-party XHRs
        if (!(e instanceof DOMException)) {
          console.log(TAG, "XHR intercept error:", e.message || e);
        }
      }
    });
    return originalXHRSend.call(this, body);
  };

  // ── Fetch interception ────────────────────────────────────────────
  const originalFetch = window.fetch;
  window.fetch = async function (input, init) {
    const inputUrl = typeof input === "string" ? input : input?.url || "";

    // Pass through third-party requests without wrapping to avoid CSP noise
    if (shouldSkipIntercept(inputUrl)) {
      return originalFetch.call(this, input, init);
    }

    let response;
    try {
      response = await originalFetch.call(this, input, init);
    } catch (fetchErr) {
      throw fetchErr;
    }

    try {
      if (isAdUrl(inputUrl)) return response;

      // For m3u8/mpd URLs, let inspectResponseBody handle them — it
      // provides richer metadata (isMaster, variants, duration).
      // Only notify directly for non-manifest stream URLs (e.g. .mp4).
      if (
        inputUrl &&
        isStreamUrl(inputUrl) &&
        !/\.m3u8|\b\.mpd/i.test(inputUrl)
      ) {
        notifyVideo({
          url: inputUrl,
          type: streamType(inputUrl),
          title: getCleanTitle(),
        });
      }

      const cloned = response.clone();
      cloned
        .text()
        .then((text) => inspectResponseBody(text, inputUrl))
        .catch(() => {});
    } catch (e) {
      console.debug(TAG, "Fetch intercept error:", e);
    }

    return response;
  };

  // ── HTMLVideoElement.src setter hook ──────────────────────────────
  try {
    const srcDesc = Object.getOwnPropertyDescriptor(
      HTMLMediaElement.prototype,
      "src",
    );
    if (srcDesc && srcDesc.set) {
      const originalSrcSet = srcDesc.set;
      Object.defineProperty(HTMLMediaElement.prototype, "src", {
        set: function (val) {
          if (
            val &&
            typeof val === "string" &&
            isStreamUrl(val) &&
            !isAdUrl(val) &&
            !isAdCDN(val)
          ) {
            notifyVideo({
              url: val,
              type: streamType(val),
              title: getCleanTitle(),
            });
          }
          return originalSrcSet.call(this, val);
        },
        get: srcDesc.get,
        configurable: true,
        enumerable: true,
      });
    }
  } catch (e) {
    console.debug(TAG, "Could not hook HTMLMediaElement.src setter:", e);
  }

  // ── MSE / Blob URL + SourceBuffer hooks ───────────────────────────
  const originalCreateObjectURL = URL.createObjectURL;
  URL.createObjectURL = function (obj) {
    const blobUrl = originalCreateObjectURL.call(this, obj);
    if (obj instanceof MediaSource) {
      console.log(TAG, "MSE blob URL created:", blobUrl.substring(0, 60));
      scheduleMSERetry();
    }
    return blobUrl;
  };

  // Track SourceBuffer additions for codec visibility
  try {
    const origAddSB = MediaSource.prototype.addSourceBuffer;
    MediaSource.prototype.addSourceBuffer = function (mimeCodec) {
      console.log(TAG, "MSE addSourceBuffer:", mimeCodec);
      return origAddSB.call(this, mimeCodec);
    };
  } catch (e) {
    console.debug(TAG, "Could not hook addSourceBuffer:", e);
  }

  /**
   * Exponential retry for MSE blob scan: 1s, 3s, 6s, 10s.
   * Stops once a stream is found or after 4 attempts.
   */
  function scheduleMSERetry() {
    if (mseRetryTimer) return; // already running
    const delays = [1000, 3000, 6000, 10000];
    let attempt = 0;
    function tick() {
      if (attempt >= delays.length) {
        mseRetryTimer = null;
        return;
      }
      mseRetryTimer = trackedTimeout(() => {
        const found = scanForBlobVideo();
        attempt++;
        if (!found) tick();
        else mseRetryTimer = null;
      }, delays[attempt]);
    }
    tick();
  }

  function scanForBlobVideo() {
    const videos = document.querySelectorAll("video");
    let found = false;
    for (const video of videos) {
      const src = video.src || video.currentSrc;
      if (src && src.startsWith("blob:")) {
        // P1: Duration-based ad filtering
        if (video.duration && video.duration < MIN_VIDEO_DURATION) {
          console.log(
            TAG,
            `Skipping short blob video (${video.duration.toFixed(1)}s < ${MIN_VIDEO_DURATION}s) — likely ad`,
          );
          continue;
        }
        if (video.duration > 30) {
          console.log(
            TAG,
            "Found blob video element, duration:",
            video.duration,
          );
          // Send duration update to popup (master playlist has no EXTINF durations)
          window.postMessage(
            {
              type: "SPECIALIST_DURATION_UPDATE",
              source: "SITE_SPECIALIST",
              data: { duration: video.duration },
            },
            window.location.origin,
          );
          found = scanPerformanceEntries() || found;
        }
      }
      // Bind video event listeners for playback-triggered detection
      bindVideoEvents(video);
    }
    return found;
  }

  function scanPerformanceEntries() {
    if (typeof performance === "undefined" || !performance.getEntriesByType)
      return false;
    const entries = performance.getEntriesByType("resource");
    let found = false;
    for (const entry of entries) {
      const url = entry.name;
      if (isAdUrl(url) || isAdCDN(url)) continue;
      if (isStreamUrl(url)) {
        notifyVideo({
          url: url,
          type: streamType(url),
          title: getCleanTitle(),
        });
        found = true;
        break;
      }
    }
    return found;
  }

  // ── Video element event listeners ─────────────────────────────────
  function bindVideoEvents(video) {
    if (videoEventsBound.has(video)) return;
    videoEventsBound.add(video);

    const handler = () => {
      // P1: Skip short videos (likely pre-roll ads)
      if (
        video.duration &&
        isFinite(video.duration) &&
        video.duration < MIN_VIDEO_DURATION
      ) {
        console.log(
          TAG,
          `Skipping short video (${video.duration.toFixed(1)}s) — likely ad`,
        );
        return;
      }

      const src = video.src || video.currentSrc;
      if (
        src &&
        !src.startsWith("blob:") &&
        isStreamUrl(src) &&
        !isAdUrl(src) &&
        !isAdCDN(src)
      ) {
        notifyVideo({
          url: src,
          type: streamType(src),
          title: getCleanTitle(),
          meta: {
            duration: video.duration || undefined,
          },
        });
      }
      // For blob sources, try Performance API
      if (
        src &&
        src.startsWith("blob:") &&
        video.duration >= MIN_VIDEO_DURATION
      ) {
        scanPerformanceEntries();
      }
    };

    video.addEventListener("loadedmetadata", handler);
    video.addEventListener("canplay", handler);
  }

  // ── Iframe / embedded player detection ────────────────────────────
  function isEmbedDomain(url) {
    try {
      const hostname = new URL(url).hostname;
      return EMBED_DOMAINS.some(
        (d) => hostname === d || hostname.endsWith("." + d),
      );
    } catch (_) {
      return false;
    }
  }

  function scanIframes() {
    const iframes = document.querySelectorAll("iframe[src]");
    for (const iframe of iframes) {
      const src = iframe.src;
      if (!src || processedUrls.has("iframe:" + src)) continue;
      if (isEmbedDomain(src)) {
        processedUrls.add("iframe:" + src);
        console.log(TAG, "Embed iframe detected:", src.substring(0, 100));
        window.postMessage(
          {
            type: "MAGIC_M3U8_DETECTION",
            source: "SITE_SPECIALIST",
            data: {
              url: src,
              type: "EMBED",
              options: {
                customTitle: getCleanTitle(),
                pageUrl: window.location.href,
                detectionSource: "flixtor-specialist",
                isEmbed: true,
                embedDomain: new URL(src).hostname,
              },
            },
          },
          window.location.origin,
        );
      }
    }
  }

  // ── Page scanning (HTML source) ───────────────────────────────────
  function scanPage() {
    const html = document.documentElement.outerHTML;

    // HLS patterns (prioritize master manifests)
    const hlsPatterns = [
      /(https?:\/\/[^"'\s<>]+master\.m3u8(?:\?[^"'\s<>]*)?)/gi,
      /(https?:\/\/[^"'\s<>]+\/\d+p\.m3u8(?:\?[^"'\s<>]*)?)/gi,
      /(https?:\/\/[^"'\s<>]+\.m3u8(?:\?[^"'\s<>]*)?)/gi,
    ];

    for (const pattern of hlsPatterns) {
      const matches = [...html.matchAll(pattern)];
      for (const match of matches) {
        const url = match[1];
        if (isAdUrl(url)) continue;
        notifyVideo({ url, type: "HLS", title: getCleanTitle() });
        return;
      }
    }

    // DASH patterns
    const dashPatterns = [/(https?:\/\/[^"'\s<>]+\.mpd(?:\?[^"'\s<>]*)?)/gi];
    for (const pattern of dashPatterns) {
      const matches = [...html.matchAll(pattern)];
      for (const match of matches) {
        const url = match[1];
        if (isAdUrl(url)) continue;
        notifyVideo({ url, type: "DASH", title: getCleanTitle() });
        return;
      }
    }

    // Fallback: check Performance API for stream resources
    scanPerformanceEntries();

    // Fallback: check video elements with blob sources
    scanForBlobVideo();

    // Scan for embedded player iframes
    scanIframes();
  }

  // ── SPA navigation detection ──────────────────────────────────────
  function onNavigate() {
    const currentUrl = window.location.href;
    if (currentUrl === lastPageUrl) return;
    console.log(TAG, "SPA navigation detected:", currentUrl.substring(0, 80));
    lastPageUrl = currentUrl;

    // Clear processed URLs so new streams aren't deduplicated against old ones.
    // Keep iframe: entries to avoid re-logging the same embeds within a session.
    for (const key of processedUrls) {
      if (!key.startsWith("iframe:")) processedUrls.delete(key);
    }

    // Reset candidate scoring system
    streamCandidates.length = 0;
    if (candidateTimer) {
      clearTimeout(candidateTimer);
      candidateTimer = null;
    }

    // Reset MSE retry state
    if (mseRetryTimer) {
      clearTimeout(mseRetryTimer);
      mseRetryTimer = null;
    }

    // Re-scan after navigation settles
    trackedTimeout(scanPage, 1500);
  }

  // Detect SPA navigation via multiple signals
  window.addEventListener("popstate", onNavigate);
  window.addEventListener("hashchange", onNavigate);

  // History API pushState/replaceState hooks
  try {
    const origPushState = history.pushState;
    const origReplaceState = history.replaceState;
    history.pushState = function () {
      const result = origPushState.apply(this, arguments);
      trackedTimeout(onNavigate, 100);
      return result;
    };
    history.replaceState = function () {
      const result = origReplaceState.apply(this, arguments);
      trackedTimeout(onNavigate, 100);
      return result;
    };
  } catch (e) {
    console.debug(TAG, "Could not hook history API:", e);
  }

  // ── Lifecycle / Cleanup ───────────────────────────────────────────
  function cleanup() {
    console.log(TAG, "Cleaning up...");
    if (domObserver) {
      domObserver.disconnect();
      domObserver = null;
    }
    if (detectionTimeout) {
      clearTimeout(detectionTimeout);
      detectionTimeout = null;
    }
    if (mseRetryTimer) {
      clearTimeout(mseRetryTimer);
      mseRetryTimer = null;
    }
    if (candidateTimer) {
      clearTimeout(candidateTimer);
      candidateTimer = null;
    }
    streamCandidates.length = 0;
    for (const id of trackedTimers) {
      clearTimeout(id);
    }
    trackedTimers.clear();
  }

  window.addEventListener("beforeunload", cleanup);

  // ── Bootstrap ─────────────────────────────────────────────────────
  if (document.readyState === "complete") {
    trackedTimeout(scanPage, 1000);
  } else {
    window.addEventListener("load", () => trackedTimeout(scanPage, 1000));
  }

  domObserver = new MutationObserver((mutations) => {
    if (detectionTimeout) clearTimeout(detectionTimeout);
    detectionTimeout = trackedTimeout(scanPage, 2000);

    // Also watch for newly added video elements and iframes
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.tagName === "VIDEO") bindVideoEvents(node);
        if (node.tagName === "IFRAME" && node.src) {
          if (isEmbedDomain(node.src)) scanIframes();
        }
        // Check children of added subtrees
        if (node.querySelectorAll) {
          const videos = node.querySelectorAll("video");
          videos.forEach((v) => bindVideoEvents(v));
          const iframes = node.querySelectorAll("iframe[src]");
          if (iframes.length > 0) scanIframes();
        }
      }
    }
  });

  const observeTarget = document.body || document.documentElement;
  if (observeTarget) {
    domObserver.observe(observeTarget, { childList: true, subtree: true });
  } else {
    // Body not ready yet — wait for it
    document.addEventListener("DOMContentLoaded", () => {
      domObserver.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true,
      });
    });
  }
})();
