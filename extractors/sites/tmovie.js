(function () {
  "use strict";

  const TAG = "[Tmovie]";
  console.log(TAG, "Specialist loaded");

  window.__SPECIALIST_DETECTED = true;
  window.__TMOVIE_SPECIALIST_ACTIVE = true;

  // ══════════════════════════════════════════════════════════════════
  // ── ANTI-DEBUGGING ── Must execute BEFORE any site scripts run ──
  // ══════════════════════════════════════════════════════════════════
  //
  // tmovie.tv uses several anti-debugging techniques:
  //   1. debugger statements in setInterval loops
  //   2. Console-based DevTools detection (toString traps, timing)
  //   3. Window size heuristics (outerWidth − innerWidth)
  //   4. Function constructor-based debugger injection
  //
  // We neutralise each vector without breaking normal site functionality.

  // ── 1. Block debugger statements injected via setInterval/setTimeout ──
  const _origSetInterval = window.setInterval;
  const _origSetTimeout = window.setTimeout;
  const _origRequestAnimationFrame = window.requestAnimationFrame;

  function containsDebugger(fn) {
    if (typeof fn === "string") return /\bdebugger\b/i.test(fn);
    if (typeof fn === "function") {
      try {
        return /\bdebugger\b/.test(fn.toString());
      } catch (_) {
        return false;
      }
    }
    return false;
  }

  window.setInterval = function (fn, delay) {
    if (containsDebugger(fn)) {
      console.log(TAG, "Blocked debugger setInterval trap");
      return 0;
    }
    return _origSetInterval.apply(this, arguments);
  };

  window.setTimeout = function (fn, delay) {
    if (containsDebugger(fn)) {
      console.log(TAG, "Blocked debugger setTimeout trap");
      return 0;
    }
    return _origSetTimeout.apply(this, arguments);
  };

  // ── 2. Neutralise Function constructor debugger injection ──
  // Some anti-debug minifiers do  new Function("debugger")()  or similar
  const _OrigFunction = Function;
  try {
    const handler = {
      construct(target, args) {
        if (
          args.length > 0 &&
          typeof args[args.length - 1] === "string" &&
          /\bdebugger\b/.test(args[args.length - 1])
        ) {
          // Strip debugger keyword from body
          args[args.length - 1] = args[args.length - 1].replace(
            /\bdebugger\b;?/g,
            "",
          );
          console.log(TAG, "Stripped debugger from Function constructor");
        }
        return Reflect.construct(target, args);
      },
      apply(target, thisArg, args) {
        if (
          args.length > 0 &&
          typeof args[args.length - 1] === "string" &&
          /\bdebugger\b/.test(args[args.length - 1])
        ) {
          args[args.length - 1] = args[args.length - 1].replace(
            /\bdebugger\b;?/g,
            "",
          );
        }
        return Reflect.apply(target, thisArg, args);
      },
    };
    // Use a Proxy so that  typeof Function === "function"  and
    // Function.prototype remain valid.
    window.Function = new Proxy(_OrigFunction, handler);
    Object.defineProperty(window.Function, "prototype", {
      value: _OrigFunction.prototype,
      writable: false,
      configurable: false,
    });
    _OrigFunction.prototype.constructor = window.Function;
  } catch (_) {
    console.log(TAG, "Could not proxy Function constructor");
  }

  // ── 3. Neutralise eval-based debugger injection ──
  const _origEval = window.eval;
  window.eval = function (code) {
    if (typeof code === "string" && /\bdebugger\b/.test(code)) {
      code = code.replace(/\bdebugger\b;?/g, "");
      console.log(TAG, "Stripped debugger from eval");
    }
    return _origEval.call(this, code);
  };
  // Preserve toString identity
  try {
    Object.defineProperty(window.eval, "toString", {
      value: function () {
        return "function eval() { [native code] }";
      },
    });
  } catch (_) {}

  // ── 4. Prevent DevTools detection via window dimensions ──
  // Many sites check  outerWidth - innerWidth > threshold
  try {
    Object.defineProperty(window, "outerWidth", {
      get: () => window.innerWidth,
      configurable: true,
    });
    Object.defineProperty(window, "outerHeight", {
      get: () => window.innerHeight,
      configurable: true,
    });
  } catch (_) {}

  // ── 5. Prevent console-based DevTools detection ──
  // Some sites use  console.log(obj)  where obj has a toString/valueOf
  // getter that flips a flag — they then check the flag to see if
  // DevTools formatted the object (only happens when DevTools is open).
  // We wrap the relevant console methods to silently swallow such traps.
  try {
    const _origConsole = {};
    ["log", "warn", "error", "info", "debug", "table", "dir", "trace"].forEach(
      (method) => {
        _origConsole[method] = console[method];
      },
    );

    function isTrapObject(arg) {
      if (arg === null || arg === undefined) return false;
      if (typeof arg === "object" || typeof arg === "function") {
        try {
          const desc =
            Object.getOwnPropertyDescriptor(arg, "id") ||
            Object.getOwnPropertyDescriptor(arg, "toString");
          if (desc && typeof desc.get === "function") return true;
        } catch (_) {}
      }
      return false;
    }

    ["log", "warn", "error", "info", "debug", "table", "dir"].forEach(
      (method) => {
        console[method] = function () {
          // Filter out trap objects but let normal logging pass through
          const safeArgs = [];
          let hasTrap = false;
          for (let i = 0; i < arguments.length; i++) {
            if (isTrapObject(arguments[i])) {
              hasTrap = true;
            } else {
              safeArgs.push(arguments[i]);
            }
          }
          if (safeArgs.length > 0 || !hasTrap) {
            _origConsole[method].apply(console, safeArgs);
          }
        };
      },
    );
  } catch (_) {}

  // ── 6. Neutralise Firebug/devtools string detection ──
  // Some scripts check  window.Firebug  or inject a <div>  and check offsetHeight
  try {
    Object.defineProperty(window, "Firebug", {
      get: () => undefined,
      set: () => {},
      configurable: true,
    });
    Object.defineProperty(window, "__REACT_DEVTOOLS_GLOBAL_HOOK__", {
      get: () => undefined,
      set: () => {},
      configurable: true,
    });
  } catch (_) {}

  console.log(TAG, "Anti-debug bypass active");

  // ══════════════════════════════════════════════════════════════════
  // ── STATE ─────────────────────────────────────────────────────────
  // ══════════════════════════════════════════════════════════════════
  const processedUrls = new Set();
  let detectionTimeout = null;
  let lastPageUrl = window.location.href;
  let mseRetryTimer = null;
  const trackedTimers = new Set();
  let domObserver = null;
  let videoEventsBound = new WeakSet();
  let candidateTimer = null;
  const streamCandidates = [];

  // Flags for videasy.net iframe message deduplication
  // (reset on server switch and SPA navigation)
  let _playerDurationReported = false;
  let _playerThumbnailReported = false;
  let _videasySourcesReported = false;

  // ── AD / TRACKER URL PATTERNS ────────────────────────────────────
  const AD_URL_PATTERNS = [
    /doubleclick\.net/i,
    /googlesyndication\.com/i,
    /googletagmanager\.com/i,
    /googleads\./i,
    /google-analytics\.com/i,
    /securepubads\.g\.doubleclick\.net/i,
    /imasdk\.googleapis\.com/i,
    /pagead2\.googlesyndication\.com/i,
    /facebook\.net\/.*\/sdk/i,
    /adnxs\.com/i,
    /amazon-adsystem\.com/i,
    /outbrain\.com/i,
    /taboola\.com/i,
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
    /vidazoo\.com/i,
    /springserve\.com/i,
    /spotx\.tv/i,
    /spotxchange\.com/i,
    /connatix\.com/i,
    /teads\.tv/i,
    /tremorhub\.com/i,
    /ad\.71i\.de/i,
    /served-by\.pixfuture\.com/i,
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
    /ad\.atdmt\.com/i,
    /cdn\.adsafeprotected\.com/i,
    /static\.adsafeprotected\.com/i,
    /cdn\.districtm\.io/i,
    /cdn\.pubfuture\.com/i,
    /lo\.synodavtit\.com/i,
  ];

  // Known embed / CDN domains used by pirate streaming sites
  const EMBED_DOMAINS = [
    "rabbitstream.net",
    "megacloud.tv",
    "vidcloud.co",
    "mycloud.to",
    "rapid-cloud.co",
    "vidplay.site",
    "vidplay.online",
    "vidplay.lol",
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
    "vidsrc.to",
    "vidsrc.xyz",
    "vidsrc.in",
    "vidsrc.net",
    "vidsrc.cc",
    "autoembed.cc",
    "xcdn.to",
    "videasy.net",
    "vidlink.pro",
    "vidfast.pro",
    "viper.press",
    "vid2faf.site",
    "warezcdn.link",
    "embed.su",
    "nontondrama.click",
    "flixhq.to",
    "sflix.to",
    "gomovies.sx",
    "watchseries.id",
    "fmovies.to",
    "moviesapi.club",
    "superembed.stream",
    "yourupload.com",
    "upstream.to",
    "streamlare.com",
    "fembed.com",
    "streamhub.to",
    "streamsb.net",
    "mp4upload.com",
    "streamz.ws",
    "vidoza.net",
    "netu.tv",
    "supervideo.tv",
    "jetload.net",
    "vido.gg",
    // Vars/specific providers potentially used by tmovie.tv
    "hlswish.com",
    "playerwish.com",
    "swiftplayer.net",
    "vixcloud.co",
  ];

  // Known ad CDN domains
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

  // Candidate scoring constants
  const MIN_VIDEO_DURATION = 45;
  const CANDIDATE_DEBOUNCE_MS = 2500;

  // ── HELPERS ──────────────────────────────────────────────────────

  function trackedTimeout(fn, ms) {
    const id = setTimeout(() => {
      trackedTimers.delete(id);
      fn();
    }, ms);
    trackedTimers.add(id);
    return id;
  }

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

  // ── AD MANIFEST DETECTION ────────────────────────────────────────

  function isAdManifest(text) {
    if (!text || typeof text !== "string") return false;
    const trimmed = text.trimStart();

    if (trimmed.startsWith("#EXTM3U") || trimmed.startsWith("#EXT-X-")) {
      const segmentCount = (text.match(/#EXTINF:/g) || []).length;
      let totalDuration = 0;
      const durationMatches = text.matchAll(/#EXTINF:\s*([\d.]+)/g);
      for (const m of durationMatches) totalDuration += parseFloat(m[1]);

      if (segmentCount > 0 && segmentCount <= 5 && totalDuration < 35) {
        console.log(
          TAG,
          `Ad manifest: ${segmentCount} segments, ${totalDuration.toFixed(1)}s`,
        );
        return true;
      }
      if (
        /#EXT-X-CUE-OUT/i.test(text) ||
        /#EXT-X-DATERANGE:.*SCTE35/i.test(text) ||
        (/#EXT-X-DISCONTINUITY/i.test(text) &&
          segmentCount <= 8 &&
          totalDuration < 45)
      ) {
        return true;
      }
    }

    if (trimmed.includes("<MPD") || trimmed.includes("<Period")) {
      const dMatch = text.match(
        /mediaPresentationDuration="PT(?:(\d+)H)?(?:(\d+)M)?([\d.]+)S"/i,
      );
      if (dMatch) {
        const totalSec =
          parseInt(dMatch[1] || "0", 10) * 3600 +
          parseInt(dMatch[2] || "0", 10) * 60 +
          parseFloat(dMatch[3] || "0");
        if (totalSec < 35) return true;
      }
      if (/<Period[^>]*id="[^"]*ad[^"]*"/i.test(text)) return true;
    }

    return false;
  }

  // ── DRM CHECK ────────────────────────────────────────────────────

  function checkManifestDRM(text) {
    if (!text || typeof text !== "string") return null;
    const trimmed = text.trimStart();

    if (trimmed.startsWith("#EXTM3U") || trimmed.startsWith("#EXT-X-")) {
      const drmPatterns = [
        { re: /#EXT-X-(?:SESSION-)?KEY:.*?URI="skd:\/\//, type: "FairPlay" },
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
      ];
      for (const p of drmPatterns) {
        if (p.re.test(text)) return { hasDRM: true, drmType: p.type };
      }
    }

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

  // ── TITLE & METADATA EXTRACTION ──────────────────────────────────

  function getCleanTitle() {
    const path = window.location.pathname;
    const params = new URLSearchParams(window.location.search);

    // TV Show: /tv/{slug}-{id}?watch=1&season={s}&episode={e}
    const tvMatch = path.match(/\/tv\/(.+?)(?:-\d+)?$/);
    if (tvMatch) {
      const rawSlug = tvMatch[1].replace(/-\d+$/, "");
      const showName = rawSlug
        .replace(/-/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
      const season = params.get("season");
      const episode = params.get("episode");

      let label = showName;
      if (season && episode) {
        const s = season.padStart(2, "0");
        const e = episode.padStart(2, "0");
        label = `${showName} S${s}E${e}`;
      } else if (season) {
        label = `${showName} Season ${season}`;
      }

      // Try to extract episode title from the player header
      const epHeader = document.querySelector(
        ".player-header, .episode-title, .player-title, " +
          '[class*="episode"][class*="title"], .film-title',
      );
      if (epHeader) {
        const epText = epHeader.textContent
          .replace(/^S\d+E\d+\s*[-–—]\s*/i, "")
          .replace(/^(Chapter|Episode)\s*\d+\s*[-–—]?\s*/i, "")
          .trim();
        if (epText && epText.length > 1 && epText.length < 80) {
          label += " - " + epText;
        }
      }

      return label;
    }

    // Movie: /movie/{slug}-{id}
    const movieMatch = path.match(/\/movie\/(.+?)(?:-\d+)?$/);
    if (movieMatch) {
      const rawSlug = movieMatch[1].replace(/-\d+$/, "");
      const movieName = rawSlug
        .replace(/-/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
      const yearMatch = document.title.match(/\((\d{4})\)/);
      return yearMatch ? `${movieName} (${yearMatch[1]})` : movieName;
    }

    // Fallback: clean page title
    return (
      document.title
        .replace(/\s*[-|–—]\s*(?:Watch|on|Tmovie|Tmovie\.tv).*$/i, "")
        .replace(/^Watch\s+/i, "")
        .trim() || document.title
    );
  }

  // Cached TMDB poster URL — set by fetchTMDBPoster() API call
  let _cachedTMDBPoster = null;

  function getThumbnail() {
    // ── Priority 1: Cached TMDB poster (from API call — always correct) ──
    if (_cachedTMDBPoster) return _cachedTMDBPoster;

    // ── Priority 2: TMDB poster images in rendered background-image styles ──
    // tmovie.tv renders poster/backdrop as CSS background-image on divs,
    // not as <img> elements.  Prefer portrait-aspect elements (poster)
    // over landscape (backdrop).
    try {
      const tmdbBgEls = [];
      const allEls = document.querySelectorAll('[style*="image.tmdb.org"]');
      for (const el of allEls) {
        const bg = el.style.backgroundImage || "";
        const urlMatch = bg.match(
          /url\(["']?(https?:\/\/image\.tmdb\.org\/t\/p\/[^"')]+)["']?\)/,
        );
        if (urlMatch) {
          const rect = el.getBoundingClientRect();
          tmdbBgEls.push({
            url: urlMatch[1],
            isPortrait: rect.height > rect.width && rect.width > 0,
            area: rect.width * rect.height,
          });
        }
      }
      // Prefer portrait (poster) images over landscape (backdrop)
      const portrait = tmdbBgEls.filter((e) => e.isPortrait);
      if (portrait.length > 0) {
        return portrait.sort((a, b) => b.area - a.area)[0].url;
      }
    } catch (_) {}

    // ── Priority 3: TMDB <img> elements (srcset, src, data-src) ──
    const allImgs = document.querySelectorAll("img");
    for (const img of allImgs) {
      const srcset = img.getAttribute("srcset") || "";
      const tmdbInSrcset = srcset.match(
        /https?:\/\/image\.tmdb\.org\/t\/p\/[^\s,]+/,
      );
      if (tmdbInSrcset) return tmdbInSrcset[0];

      const src = img.src || img.getAttribute("data-src") || "";
      if (src.includes("image.tmdb.org")) return src;
    }

    // ── Priority 4: TMDB URLs in innerHTML (inline JSON, data attrs) ──
    try {
      const html = document.documentElement.innerHTML;
      const posterMatch = html.match(
        /https?:\/\/image\.tmdb\.org\/t\/p\/(?:original|w\d+)\/[A-Za-z0-9]+\.jpg/,
      );
      if (posterMatch) return posterMatch[0];
      const anyTmdb = html.match(
        /https?:\/\/image\.tmdb\.org\/t\/p\/(?:original|w\d+)\/[A-Za-z0-9]+\.[a-z]+/,
      );
      if (anyTmdb) return anyTmdb[0];
    } catch (_) {}

    // ── Priority 5: Meta tags (filtered — skip generic site images) ──
    const metaSelectors = [
      'meta[property="og:image:secure_url"]',
      'meta[property="og:image"]',
      'meta[property="twitter:image"]',
      'meta[name="twitter:image"]',
    ];
    for (const sel of metaSelectors) {
      const el = document.querySelector(sel);
      if (el && el.content) {
        const url = el.content;
        if (/postimg\.cc|logo\.png|favicon|assets\/logo|screenshot/i.test(url))
          continue;
        return url;
      }
    }

    return null;
  }

  // ── TMDB POSTER API FETCH ─────────────────────────────────────────
  // tmovie.tv proxies TMDB at /api/tmdb/{type}/{id}. We extract the TMDB
  // ID from the URL (last numeric segment of the slug) and fetch the
  // exact poster_path — guaranteeing the correct portrait poster image
  // instead of a backdrop.

  async function fetchTMDBPoster() {
    try {
      const path = window.location.pathname;
      // Match /tv/{slug}-{id} or /movie/{slug}-{id} or /anime/{slug}-{id}
      const typeMatch = path.match(/^\/(tv|movie|anime)\//);
      if (!typeMatch) return null;
      const mediaType = typeMatch[1] === "anime" ? "tv" : typeMatch[1];

      // Extract TMDB ID (last numeric segment after the last dash)
      const slugMatch = path.match(/\/(tv|movie|anime)\/[\w-]+?-(\d+)/);
      if (!slugMatch) return null;
      const tmdbId = slugMatch[2];

      console.log(TAG, `Fetching TMDB poster for ${mediaType}/${tmdbId}...`);
      const resp = await fetch(`/api/tmdb/${mediaType}/${tmdbId}`, {
        headers: { "Content-Type": "application/json" },
      });
      if (!resp.ok) return null;

      const data = await resp.json();
      const posterPath = data.poster_path;
      if (!posterPath) return null;

      const posterUrl = `https://image.tmdb.org/t/p/w500${posterPath}`;
      console.log(TAG, "TMDB poster:", posterUrl);
      return posterUrl;
    } catch (err) {
      console.warn(TAG, "fetchTMDBPoster failed:", err.message);
      return null;
    }
  }

  // ── MASTER PLAYLIST VARIANT PARSING ──────────────────────────────

  function parseMasterVariants(masterText, masterUrl) {
    const variants = [];
    const lines = masterText.split(/\r?\n/);
    let baseUrl = masterUrl;
    try {
      const u = new URL(masterUrl);
      baseUrl = u.href.substring(0, u.href.lastIndexOf("/") + 1);
    } catch (_) {}

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line.startsWith("#EXT-X-STREAM-INF:")) continue;

      const bwMatch = line.match(/BANDWIDTH=(\d+)/);
      const resMatch = line.match(/RESOLUTION=(\d+)x(\d+)/);
      const nameMatch = line.match(/NAME="([^"]+)"/);

      let variantUri = null;
      for (let j = i + 1; j < lines.length; j++) {
        const nextLine = lines[j].trim();
        if (nextLine && !nextLine.startsWith("#")) {
          variantUri = nextLine;
          break;
        }
      }
      if (!variantUri) continue;

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

    variants.sort((a, b) => (b.height || 0) - (a.height || 0));
    return variants;
  }

  // ── CANDIDATE SCORING ────────────────────────────────────────────

  function scoreCandidate(candidate) {
    let score = 0;
    const url = candidate.url;

    if (isAdUrl(url)) score -= 200;
    if (isAdCDN(url)) score -= 150;
    if (candidate.meta?.isAdManifest) score -= 80;

    if (candidate.meta?.duration > 0) {
      if (candidate.meta.duration >= MIN_VIDEO_DURATION) {
        score += 100;
      } else {
        score -= 100;
      }
    }

    if (candidate.meta?.isMaster) score += 20;

    if (streamCandidates.length > 1) score += 10;

    // Bonus for known embed domain (likely the real video source)
    if (isEmbedDomain(url)) score += 15;

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
          score -= 30;
        }
      } catch (_) {}
    }

    return score;
  }

  // ── NOTIFICATION (candidate-based) ───────────────────────────────

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
      thumbnail: videoData.thumbnail || getThumbnail(),
      quality: videoData.quality || null,
      headers: videoData.headers || null,
      isDRM: videoData.isDRM || false,
      drmType: videoData.drmType || null,
      meta: videoData.meta || {},
      timestamp: Date.now(),
    };

    candidate.score = scoreCandidate(candidate);

    if (candidate.score <= -100) {
      console.log(
        TAG,
        `Rejected (score ${candidate.score}):`,
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

    if (candidate.score >= 10) {
      dispatchBestCandidate();
      return;
    }

    if (candidateTimer) clearTimeout(candidateTimer);
    candidateTimer = trackedTimeout(
      dispatchBestCandidate,
      CANDIDATE_DEBOUNCE_MS,
    );
  }

  function dispatchBestCandidate() {
    if (candidateTimer) {
      clearTimeout(candidateTimer);
      candidateTimer = null;
    }
    if (streamCandidates.length === 0) return;

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

    streamCandidates.length = 0;

    const payload = {
      url: best.url,
      type: best.type,
      options: {
        customTitle: best.title,
        thumbnail: best.thumbnail,
        quality: best.quality,
        pageUrl: window.location.href,
        detectionSource: "tmovie-specialist",
        headers: best.headers || undefined,
      },
    };

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
        `Sending ${payload.options.formats.length} quality variants`,
      );
    }

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

  // ── DEEP JSON SEARCH ─────────────────────────────────────────────

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
    "link",
    "sources",
    "tracks",
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

  // ── RESPONSE BODY INSPECTION ─────────────────────────────────────

  function inspectResponseBody(text, requestUrl) {
    if (!text || typeof text !== "string") return;
    const trimmed = text.trimStart();

    // HLS manifest
    if (trimmed.startsWith("#EXTM3U") || trimmed.startsWith("#EXT-X-")) {
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

      let totalDuration = 0;
      const durMatches = text.matchAll(/#EXTINF:\s*([\d.]+)/g);
      for (const m of durMatches) totalDuration += parseFloat(m[1]);

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

    // DASH manifest
    if (
      (trimmed.startsWith("<?xml") || trimmed.startsWith("<MPD")) &&
      trimmed.includes("<MPD")
    ) {
      if (isAdManifest(text)) return;

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
        /(https?:\/\/[^"'\s<>\\]+\.m3u8(?:\?[^"'\s<>\\]*)?)/i,
      );
      if (m3u8Match && !isAdUrl(m3u8Match[1]) && !isAdCDN(m3u8Match[1])) {
        notifyVideo({
          url: m3u8Match[1],
          type: "HLS",
          title: getCleanTitle(),
        });
      }
      const mpdMatch = text.match(
        /(https?:\/\/[^"'\s<>\\]+\.mpd(?:\?[^"'\s<>\\]*)?)/i,
      );
      if (mpdMatch && !isAdUrl(mpdMatch[1]) && !isAdCDN(mpdMatch[1])) {
        notifyVideo({
          url: mpdMatch[1],
          type: "DASH",
          title: getCleanTitle(),
        });
      }
    }

    // Deep JSON search for stream URLs
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
      } catch (_) {}
    }
  }

  // Domains to skip interception for (third-party, irrelevant)
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

  // ── XHR INTERCEPTION ─────────────────────────────────────────────

  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this._requestUrl = typeof url === "string" ? url : url?.toString?.() || "";
    return originalXHROpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const reqUrl = this._requestUrl || "";

    if (shouldSkipIntercept(reqUrl)) {
      return originalXHRSend.call(this, body);
    }

    this.addEventListener("load", function () {
      try {
        const _url = this._requestUrl || "";
        if (isAdUrl(_url)) return;

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
        if (!(e instanceof DOMException)) {
          console.log(TAG, "XHR intercept error:", e.message || e);
        }
      }
    });
    return originalXHRSend.call(this, body);
  };

  // ── FETCH INTERCEPTION ───────────────────────────────────────────

  const originalFetch = window.fetch;
  window.fetch = async function (input, init) {
    const inputUrl = typeof input === "string" ? input : input?.url || "";

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
      console.log(TAG, "Fetch intercept error:", e.message || e);
    }

    return response;
  };

  // ── HTMLMediaElement.src SETTER HOOK ──────────────────────────────

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
    console.log(TAG, "Could not hook HTMLMediaElement.src setter:", e.message);
  }

  // ── MSE / BLOB URL HOOKS ─────────────────────────────────────────

  const originalCreateObjectURL = URL.createObjectURL;
  URL.createObjectURL = function (obj) {
    const blobUrl = originalCreateObjectURL.call(this, obj);
    if (obj instanceof MediaSource) {
      console.log(TAG, "MSE blob URL created:", blobUrl.substring(0, 60));
      scheduleMSERetry();
    }
    return blobUrl;
  };

  try {
    const origAddSB = MediaSource.prototype.addSourceBuffer;
    MediaSource.prototype.addSourceBuffer = function (mimeCodec) {
      console.log(TAG, "MSE addSourceBuffer:", mimeCodec);
      return origAddSB.call(this, mimeCodec);
    };
  } catch (e) {}

  function scheduleMSERetry() {
    if (mseRetryTimer) return;
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
        if (video.duration && video.duration < MIN_VIDEO_DURATION) {
          console.log(
            TAG,
            `Skipping short blob (${video.duration.toFixed(1)}s) — likely ad`,
          );
          continue;
        }
        if (video.duration > 30) {
          console.log(
            TAG,
            "Found blob video, duration:",
            video.duration.toFixed(1) + "s",
          );
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

  // ── VIDEO ELEMENT EVENTS ─────────────────────────────────────────

  function bindVideoEvents(video) {
    if (videoEventsBound.has(video)) return;
    videoEventsBound.add(video);

    const handler = () => {
      if (
        video.duration &&
        isFinite(video.duration) &&
        video.duration < MIN_VIDEO_DURATION
      ) {
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
          meta: { duration: video.duration || undefined },
        });
      }
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

  // ── IFRAME / EMBED DETECTION ─────────────────────────────────────

  function scanIframes() {
    const iframes = document.querySelectorAll("iframe[src]");
    for (const iframe of iframes) {
      const src = iframe.src;
      if (!src || processedUrls.has("iframe:" + src)) continue;

      // Check all iframes — the server embed might be from any domain
      processedUrls.add("iframe:" + src);

      // Skip obviously irrelevant iframes (ads, recaptcha, etc.)
      if (
        isAdUrl(src) ||
        /recaptcha|captcha|google\.com\/recaptcha/i.test(src)
      ) {
        continue;
      }

      console.log(TAG, "Embed iframe detected:", src.substring(0, 120));

      window.postMessage(
        {
          type: "MAGIC_M3U8_DETECTION",
          source: "SITE_SPECIALIST",
          data: {
            url: src,
            type: "EMBED",
            options: {
              customTitle: getCleanTitle(),
              thumbnail: getThumbnail(),
              pageUrl: window.location.href,
              detectionSource: "tmovie-specialist",
              isEmbed: true,
              embedDomain: (() => {
                try {
                  return new URL(src).hostname;
                } catch (_) {
                  return "";
                }
              })(),
            },
          },
        },
        window.location.origin,
      );
    }
  }

  // ── PAGE SCANNING (HTML source) ──────────────────────────────────

  function scanPage() {
    const html = document.documentElement.outerHTML;

    // HLS patterns
    const hlsPatterns = [
      /(https?:\/\/[^"'\s<>\\]+master\.m3u8(?:\?[^"'\s<>\\]*)?)/gi,
      /(https?:\/\/[^"'\s<>\\]+\/\d+p\.m3u8(?:\?[^"'\s<>\\]*)?)/gi,
      /(https?:\/\/[^"'\s<>\\]+\.m3u8(?:\?[^"'\s<>\\]*)?)/gi,
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
    const dashPatterns = [
      /(https?:\/\/[^"'\s<>\\]+\.mpd(?:\?[^"'\s<>\\]*)?)/gi,
    ];
    for (const pattern of dashPatterns) {
      const matches = [...html.matchAll(pattern)];
      for (const match of matches) {
        const url = match[1];
        if (isAdUrl(url)) continue;
        notifyVideo({ url, type: "DASH", title: getCleanTitle() });
        return;
      }
    }

    // MP4 direct URLs in scripts/data attributes (sometimes servers serve direct links)
    const mp4Match = html.match(
      /(https?:\/\/[^"'\s<>\\]+\.mp4(?:\?[^"'\s<>\\]*)?)/i,
    );
    if (mp4Match && !isAdUrl(mp4Match[1]) && !isAdCDN(mp4Match[1])) {
      // Only notify if the mp4 URL looks like a video (not a thumbnail/icon)
      const mp4Url = mp4Match[1];
      if (!/thumb|icon|poster|preview|sprite/i.test(mp4Url)) {
        console.log(TAG, "Direct MP4 found in page:", mp4Url.substring(0, 100));
        window.postMessage(
          {
            type: "MAGIC_M3U8_DETECTION",
            source: "SITE_SPECIALIST",
            data: {
              url: mp4Url,
              type: "DIRECT",
              options: {
                customTitle: getCleanTitle(),
                thumbnail: getThumbnail(),
                pageUrl: window.location.href,
                detectionSource: "tmovie-specialist",
              },
            },
          },
          window.location.origin,
        );
      }
    }

    // Scan Performance API for stream resources
    scanPerformanceEntries();

    // Scan for video elements with blob sources
    scanForBlobVideo();

    // Scan for embedded player iframes
    scanIframes();
  }

  // ── SERVER SELECTOR OBSERVATION ──────────────────────────────────
  // tmovie.tv has a server dropdown. When the user switches servers,
  // a new iframe embed loads. We watch for this and re-scan.

  function watchServerSwitch() {
    // Look for server dropdown or server buttons
    const serverSelectors = [
      ".server-select",
      ".server-list",
      '[class*="server"]',
      '[class*="Server"]',
      ".dropdown-menu",
      "[data-server]",
      "[data-id]",
    ];

    for (const sel of serverSelectors) {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        el.addEventListener("click", () => {
          console.log(TAG, "Server switch detected, re-scanning in 2s...");
          // Clear processed URLs so new streams are detected
          for (const key of processedUrls) {
            if (!key.startsWith("iframe:")) processedUrls.delete(key);
          }
          // Reset videasy/player flags so the new server's sources are accepted
          _videasySourcesReported = false;
          _playerDurationReported = false;
          _playerThumbnailReported = false;
          streamCandidates.length = 0;
          if (candidateTimer) {
            clearTimeout(candidateTimer);
            candidateTimer = null;
          }
          if (mseRetryTimer) {
            clearTimeout(mseRetryTimer);
            mseRetryTimer = null;
          }
          trackedTimeout(scanPage, 2000);
          trackedTimeout(scanPage, 5000);
        });
      }
    }
  }

  // ── SPA NAVIGATION DETECTION ─────────────────────────────────────

  function onNavigate() {
    const currentUrl = window.location.href;
    if (currentUrl === lastPageUrl) return;
    console.log(TAG, "SPA navigation:", currentUrl.substring(0, 80));
    lastPageUrl = currentUrl;

    // Reset videasy/player flags for the new page
    _videasySourcesReported = false;
    _playerDurationReported = false;
    _playerThumbnailReported = false;

    for (const key of processedUrls) {
      if (!key.startsWith("iframe:")) processedUrls.delete(key);
    }

    streamCandidates.length = 0;
    if (candidateTimer) {
      clearTimeout(candidateTimer);
      candidateTimer = null;
    }
    if (mseRetryTimer) {
      clearTimeout(mseRetryTimer);
      mseRetryTimer = null;
    }

    trackedTimeout(scanPage, 1500);
    trackedTimeout(() => watchServerSwitch(), 2000);
  }

  window.addEventListener("popstate", onNavigate);
  window.addEventListener("hashchange", onNavigate);

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
  } catch (e) {}

  // ── CLEANUP ──────────────────────────────────────────────────────

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

  // ── BOOTSTRAP ────────────────────────────────────────────────────

  function bootstrap() {
    console.log(TAG, "Bootstrapping on", window.location.href.substring(0, 80));

    // Fetch the TMDB poster via API immediately — this fires before
    // scanPage and ensures the correct poster is used for all detections.
    fetchTMDBPoster().then((posterUrl) => {
      if (posterUrl) {
        _cachedTMDBPoster = posterUrl;
        // Push thumbnail update to background.js in case detection already fired
        window.postMessage(
          {
            type: "SPECIALIST_THUMBNAIL_UPDATE",
            source: "SITE_SPECIALIST",
            data: { thumbnail: posterUrl },
          },
          window.location.origin,
        );
      }
    });

    trackedTimeout(scanPage, 1000);
    trackedTimeout(scanPage, 4000); // second scan catches late-loading embeds
    trackedTimeout(() => watchServerSwitch(), 1500);
  }

  if (document.readyState === "complete") {
    bootstrap();
  } else {
    window.addEventListener("load", bootstrap);
  }

  // ── PLAYER_EVENT LISTENER (videasy.net iframe) ───────────────────
  // The videasy.net player sends PLAYER_EVENT via window.parent.postMessage
  // with JSON-stringified data containing duration, currentTime, etc.
  // Since our specialist runs on the parent page (tmovie.tv), we receive
  // these messages directly as 'message' events.

  window.addEventListener("message", (event) => {
    // Accept messages from any origin (iframes are cross-origin)
    if (!event.data) return;

    let parsed = event.data;
    // videasy.net stringifies the payload
    if (typeof parsed === "string") {
      try {
        parsed = JSON.parse(parsed);
      } catch (_) {
        return;
      }
    }

    if (!parsed || !parsed.type) return;

    const sourceOrigin = (() => {
      try {
        if (event.origin && /^https?:\/\//i.test(event.origin)) {
          return event.origin;
        }
        const fromPlayerUrl = parsed?.data?.playerUrl;
        if (fromPlayerUrl) {
          return new URL(fromPlayerUrl).origin;
        }
      } catch (_) {}
      return "https://player.videasy.net";
    })();

    const embedHeaders = {
      Referer: sourceOrigin + "/",
      Origin: sourceOrigin,
    };

    // ── Handle VIDEASY_SOURCES from our videasy-source-hook.js ──────
    // This captures the fully decrypted source list from the videasy.net
    // player (after WASM + AES decryption), giving us structured data
    // with quality labels and subtitle URLs.
    if (parsed.type === "VIDEASY_SOURCES" && parsed.source === "VIDEASY_HOOK") {
      const { sources, subtitles, mediaInfo } = parsed.data || {};
      if (!sources || sources.length === 0) return;

      console.log(
        TAG,
        "VIDEASY_SOURCES received:",
        sources.length,
        "sources,",
        (subtitles || []).length,
        "subtitles",
      );

      // ── Classify sources by type (HLS / DASH / MP4-DIRECT) ────────
      // The hook now tags each source with sourceType and isAudio flags.
      // We classify properly so background.js can handle each type correctly.
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

      // Separate sources by stream type
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

      // Check if we have split audio/video among MP4 sources
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

      // Use the first streaming source as primary
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

      // If only PROXY/UNKNOWN sources exist, add them as best-guess HLS
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

      // Dispatch via the specialist's candidate system
      const title = getCleanTitle();
      const thumbnail = getThumbnail();

      // Determine primary stream type for the dispatch
      const dispatchType =
        primaryType === "MP4" || primaryType === "PROXY"
          ? "DIRECT"
          : primaryType === "DASH"
            ? "DASH"
            : "HLS";

      const payload = {
        url: primary.url,
        type: dispatchType,
        options: {
          customTitle: title,
          thumbnail: thumbnail,
          quality: primary.quality || null,
          pageUrl: window.location.href,
          detectionSource: "videasy-hook",
          formats: formats.length > 1 ? formats : undefined,
          subtitles: subs.length > 0 ? subs : undefined,
          videasyServer: mediaInfo
            ? `${mediaInfo.mediaType}/${mediaInfo.tmdbId}`
            : undefined,
          // Flag 4K availability for popup UI
          has4K: formats.some((f) => f.is4K),
          // CDN headers should mirror the actual embed origin (vidsrc/videasy).
          headers: embedHeaders,
        },
      };

      window.postMessage(
        {
          type: "MAGIC_M3U8_DETECTION",
          source: "SITE_SPECIALIST",
          data: payload,
        },
        window.location.origin,
      );

      _videasySourcesReported = true;
      console.log(
        TAG,
        "Dispatched videasy source:",
        primary.url.substring(0, 100),
        primary.quality || "",
      );
      return;
    }

    // ── Handle VIDEASY_STREAM_URL from our videasy-source-hook.js ───
    // Fallback: if the full JSON.parse hook didn't fire, the hook also
    // monitors fetch/XHR for direct m3u8/mpd URLs.
    if (
      parsed.type === "VIDEASY_STREAM_URL" &&
      parsed.source === "VIDEASY_HOOK"
    ) {
      const { url: streamUrl, streamType: sType } = parsed.data || {};
      if (!streamUrl || _videasySourcesReported) return;

      console.log(TAG, "VIDEASY_STREAM_URL:", streamUrl.substring(0, 120));
      notifyVideo({
        url: streamUrl,
        type: sType || "HLS",
        title: getCleanTitle(),
        thumbnail: getThumbnail(),
        headers: embedHeaders,
      });
      return;
    }

    // ── Handle PLAYER_EVENT (native videasy.net player events) ──────
    if (parsed.type !== "PLAYER_EVENT" || !parsed.data) return;

    const { duration, currentTime, event: playerEvent } = parsed.data;

    // Report duration once
    if (
      !_playerDurationReported &&
      typeof duration === "number" &&
      isFinite(duration) &&
      duration > 30
    ) {
      _playerDurationReported = true;
      console.log(TAG, "PLAYER_EVENT duration from iframe:", duration + "s");
      window.postMessage(
        {
          type: "SPECIALIST_DURATION_UPDATE",
          source: "SITE_SPECIALIST",
          data: { duration: duration },
        },
        window.location.origin,
      );
    }

    // When the player starts playing, the SPA is definitely rendered.
    // Push a thumbnail update in case the initial detection got a generic image.
    if (!_playerThumbnailReported) {
      _playerThumbnailReported = true;
      const thumb = getThumbnail();
      if (thumb && /image\.tmdb\.org/i.test(thumb)) {
        console.log(
          TAG,
          "Pushing TMDB thumbnail update:",
          thumb.substring(0, 80),
        );
        window.postMessage(
          {
            type: "SPECIALIST_THUMBNAIL_UPDATE",
            source: "SITE_SPECIALIST",
            data: { thumbnail: thumb },
          },
          window.location.origin,
        );
      }
    }
  });

  // (Deferred thumbnail handled by fetchTMDBPoster in bootstrap)

  // ── DOM MUTATION OBSERVER ────────────────────────────────────────

  domObserver = new MutationObserver((mutations) => {
    if (detectionTimeout) clearTimeout(detectionTimeout);
    detectionTimeout = trackedTimeout(scanPage, 2000);

    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== 1) continue;

        // Watch for newly added video elements
        if (node.tagName === "VIDEO") bindVideoEvents(node);

        // Watch for newly added iframes (server switch loads new embed)
        if (node.tagName === "IFRAME" && node.src) {
          console.log(TAG, "New iframe added:", node.src.substring(0, 120));
          trackedTimeout(scanIframes, 500);
        }

        // Check children of added subtrees
        if (node.querySelectorAll) {
          const videos = node.querySelectorAll("video");
          videos.forEach((v) => bindVideoEvents(v));
          const iframes = node.querySelectorAll("iframe[src]");
          if (iframes.length > 0) {
            trackedTimeout(scanIframes, 500);
          }
        }
      }
    }
  });

  const observeTarget = document.body || document.documentElement;
  if (observeTarget) {
    domObserver.observe(observeTarget, { childList: true, subtree: true });
  } else {
    document.addEventListener("DOMContentLoaded", () => {
      const target = document.body || document.documentElement;
      if (target) {
        domObserver.observe(target, { childList: true, subtree: true });
      }
    });
  }

  console.log(
    TAG,
    "Specialist initialised — anti-debug + stream detection active",
  );
})();
