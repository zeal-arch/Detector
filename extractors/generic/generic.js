class GenericExtractor extends BaseExtractor {
  constructor() {
    super("Generic");
    this._detectedUrls = new Set();
    this._xhrHook = null;
    this._fetchHook = null;
    this._scanDebounce = null;
    this._blobUrls = new Map();
    this._mseDetected = false;
    this._imageObserver = null;
    this._performanceScanned = false;

    // Advanced detection state
    this._subtitleUrls = new Set();
    this._formatScores = new Map();
    this._periodicScanId = null;
    this._canvasDetected = false;
    this._ssrDataScanned = false;
    this._dataAttrsScanned = false;
    this._lazyVideoObserver = null;
    this._lastHref = window.location.href;
    this._navGeneration = 0;
    this._scanRound = 0;
    this._detectedSubtitles = [];
    this._jsGlobalsScanned = false;
    this._customElementsScanned = false;
  }

  static get URL_PATTERNS() {
    return [
      {
        match: /^https?:\/\//,

        exclude:
          /^https?:\/\/(www\.|m\.|music\.)?(youtube\.com|youtu\.be|twitter\.com|x\.com|instagram\.com)\//,
      },
    ];
  }

  async init() {
    console.log(this.TAG, "Initializing generic video detector");

    if (this._shouldSkip()) {
      console.log(this.TAG, "Skipping — site in skip list");
      return;
    }

    this.timer(() => this._scanDOM(), 1000);

    this.observe(
      document.body || document.documentElement,
      {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: [
          "src",
          "data-src",
          "data-video-url",
          "data-stream-url",
          "href",
          "data-setup",
          "data-config",
        ],
      },
      (mutations) => this._onMutation(mutations),
    );

    this.timer(() => this._scanPageSource(), 2000);

    this.timer(() => this._scanMetaTags(), 1500);

    this._hookNetworkRequests();

    this.timer(() => this._scanPlayers(), 2500);

    this.timer(() => this._scanEmbeds(), 3000);

    this.timer(() => this._scanPerformanceResources(), 3500);

    this.timer(() => this._initImageDetection(), 2000);

    this.timer(() => this._scanBackgroundImages(), 4000);

    this.timer(() => this._scanResponsiveImages(), 2500);

    // ── Advanced detection phases ──
    this.timer(() => this._scanSSRFrameworkData(), 800);
    this.timer(() => this._scanDataAttributes(), 1500);
    this.timer(() => this._scanPreloadLinks(), 1000);
    this.timer(() => this._scanSubtitles(), 2000);
    this.timer(() => this._scanObjectEmbeds(), 2500);
    this.timer(() => this._scanCanvasElements(), 4000);
    this.timer(() => this._scanJSGlobals(), 2000);
    this.timer(() => this._scanCustomElements(), 3000);
    this.timer(() => this._initLazyVideoDetection(), 1500);
    this.timer(() => this._extractMediaSessionMetadata(), 5000);
    this.timer(() => this._scanObfuscatedUrls(), 3500);
    this.timer(() => this._scanCDNPatterns(), 3000);
    this.timer(() => this._scanWebComponents(), 3500);

    // GOD-mode extra scanners
    this.timer(() => this._scanMicrodata(), 1200);
    this.timer(() => this._scanNoscript(), 2000);
    this.timer(() => this._scanWebStorage(), 3000);
    this.timer(() => this._scanFeedLinks(), 2500);
    this.timer(() => this._scanDownloadLinks(), 1500);
    this.timer(() => this._scanHTMLComments(), 4000);
    this.timer(() => this._scanExternalScripts(), 5000);

    // Inter-frame postMessage sniffer for video URL delivery
    this._initPostMessageSniffer();

    // SPA navigation handling
    this._setupSPANavigation();

    // Periodic re-scan for dynamically loaded content
    this._periodicScanId = this.interval(() => this._periodicRescan(), 12000);

    console.log(this.TAG, "Initialized with GOD-mode detection");
  }

  async extract() {
    const formats = [];

    // DOM video elements
    for (const video of document.querySelectorAll("video")) {
      const videoFormats = this._extractFromVideoEl(video);
      formats.push(...videoFormats);
    }

    // DOM audio elements
    for (const audio of document.querySelectorAll("audio")) {
      const audioFormats = this._extractFromAudioEl(audio);
      formats.push(...audioFormats);
    }

    // Shadow DOM
    const shadowFormats = this._scanShadowDOM();
    formats.push(...shadowFormats);

    // Meta tags (OG, Twitter, JSON-LD)
    const metaFormats = this._extractFromMetaTags();
    formats.push(...metaFormats);

    // Direct links
    const linkFormats = this._extractFromLinks();
    formats.push(...linkFormats);

    // Player detection
    const playerFormats = this._extractFromPlayers();
    formats.push(...playerFormats);

    // Embeds
    const embedFormats = this._extractFromEmbeds();
    formats.push(...embedFormats);

    if (formats.length === 0) return null;

    return {
      videoId: this._generateId(),
      formats,
      formatSource: "generic",
      title: document.title,
      subtitles:
        this._detectedSubtitles.length > 0
          ? this._detectedSubtitles
          : undefined,
    };
  }

  _scanDOM() {
    const videos = document.querySelectorAll("video");
    const audios = document.querySelectorAll("audio");

    if (videos.length === 0 && audios.length === 0) {
      const shadowFormats = this._scanShadowDOM();
      if (shadowFormats.length > 0) {
        this.sendToBackground({
          videoId: this._generateId(),
          formats: shadowFormats,
          formatSource: "generic_shadow_dom",
          title: document.title,
        });
      }
      return;
    }

    const formats = [];
    for (const video of videos) {
      const vf = this._extractFromVideoEl(video);
      formats.push(...vf);
    }

    for (const audio of audios) {
      const af = this._extractFromAudioEl(audio);
      formats.push(...af);
    }

    const shadowFormats = this._scanShadowDOM();
    formats.push(...shadowFormats);

    if (formats.length > 0) {
      this.sendToBackground({
        videoId: this._generateId(),
        formats,
        formatSource: "generic_dom",
        title: document.title,
      });
    }
  }

  _extractFromVideoEl(video) {
    const formats = [];
    const urls = new Set();

    if (video.src && !video.src.startsWith("data:")) {
      urls.add(video.src);
    }

    if (video.currentSrc && !video.currentSrc.startsWith("data:")) {
      urls.add(video.currentSrc);
    }

    for (const source of video.querySelectorAll("source")) {
      if (source.src && !source.src.startsWith("data:")) {
        urls.add(source.src);
      }
    }

    // Check data-src and other lazy-load attributes on the video itself
    for (const attr of [
      "data-src",
      "data-video-url",
      "data-video-src",
      "data-stream-url",
      "data-hls",
      "data-dash-url",
    ]) {
      const val = video.getAttribute(attr);
      if (val && !val.startsWith("data:") && /^https?:\/\//.test(val)) {
        urls.add(val);
      }
    }

    for (const url of urls) {
      if (this._detectedUrls.has(url)) continue;
      this._detectedUrls.add(url);

      const mime = this._guessMimeFromUrl(url);
      const isM3u8 = /\.m3u8(\?|$)/i.test(url);
      const isMpd = /\.mpd(\?|$)/i.test(url);
      const isBlob = url.startsWith("blob:");

      // Try to detect quality from URL patterns (e.g. /1080p/, _720., -480p)
      let quality = this._guessQualityFromVideo(video);
      if (quality === "Unknown") {
        quality = this._guessQualityFromUrl(url) || "Unknown";
      }

      formats.push(
        this.buildFormat({
          url,
          mimeType: isBlob ? video.type || mime : mime,
          quality,
          qualityLabel: isBlob ? `Blob (${quality})` : quality,
          width: video.videoWidth || 0,
          height: video.videoHeight || 0,
          isVideo: true,
          isMuxed: true,
          ext: isM3u8
            ? "m3u8"
            : isMpd
              ? "mpd"
              : isBlob
                ? "blob"
                : this.guessExtension(mime),
          isBlob: isBlob,
          isMSE: this._mseDetected && isBlob,
        }),
      );
    }

    // Extract poster as thumbnail
    const poster = video.poster || video.getAttribute("poster");
    if (
      poster &&
      !poster.startsWith("data:") &&
      !this._detectedUrls.has(poster)
    ) {
      try {
        const posterUrl = new URL(poster, window.location.href).href;
        if (!this._detectedUrls.has(posterUrl)) {
          this._detectedUrls.add(posterUrl);
          formats.push(
            this.buildFormat({
              url: posterUrl,
              mimeType: "image/*",
              quality: "Poster",
              qualityLabel: "Video Poster/Thumbnail",
              isVideo: false,
              isImage: true,
              isMuxed: false,
              ext: this._guessImageExt(posterUrl),
            }),
          );
        }
      } catch {}
    }

    return formats;
  }

  _guessQualityFromUrl(url) {
    // Match common URL quality patterns
    const patterns = [
      { regex: /[_\-/.]4k[_\-/.]/i, quality: "4K" },
      { regex: /[_\-/.]2160[p_\-/.]/i, quality: "4K" },
      { regex: /[_\-/.]1440[p_\-/.]/i, quality: "1440p" },
      { regex: /[_\-/.]1080[p_\-/.]/i, quality: "1080p" },
      { regex: /[_\-/.]720[p_\-/.]/i, quality: "720p" },
      { regex: /[_\-/.]480[p_\-/.]/i, quality: "480p" },
      { regex: /[_\-/.]360[p_\-/.]/i, quality: "360p" },
      { regex: /[_\-/.]240[p_\-/.]/i, quality: "240p" },
      { regex: /[_\-/.]144[p_\-/.]/i, quality: "144p" },
      { regex: /[_\-/.](?:hd|high)[_\-/.]/i, quality: "HD" },
      { regex: /[_\-/.](?:sd|low)[_\-/.]/i, quality: "SD" },
      { regex: /[_\-/.](?:uhd|ultra)[_\-/.]/i, quality: "4K UHD" },
    ];
    for (const { regex, quality } of patterns) {
      if (regex.test(url)) return quality;
    }
    return null;
  }

  _guessQualityFromVideo(video) {
    const h = video.videoHeight;
    if (!h) return "Unknown";
    if (h >= 2160) return "4K";
    if (h >= 1440) return "1440p";
    if (h >= 1080) return "1080p";
    if (h >= 720) return "720p";
    if (h >= 480) return "480p";
    if (h >= 360) return "360p";
    if (h >= 240) return "240p";
    return h + "p";
  }

  _guessMimeFromUrl(url) {
    const lower = url.toLowerCase().split("?")[0];
    if (lower.endsWith(".mp4")) return "video/mp4";
    if (lower.endsWith(".webm")) return "video/webm";
    if (lower.endsWith(".m3u8")) return "application/x-mpegurl";
    if (lower.endsWith(".mpd")) return "application/dash+xml";
    if (lower.endsWith(".flv")) return "video/x-flv";
    if (lower.endsWith(".ts")) return "video/mp2t";
    if (lower.endsWith(".3gp")) return "video/3gpp";
    if (lower.endsWith(".mkv")) return "video/x-matroska";
    if (lower.endsWith(".m4v")) return "video/mp4";
    if (lower.endsWith(".mov")) return "video/quicktime";
    if (lower.endsWith(".f4v")) return "video/mp4";
    if (lower.endsWith(".ogv")) return "video/ogg";
    if (lower.endsWith(".m4s")) return "video/iso.segment";
    if (lower.endsWith(".avi")) return "video/x-msvideo";
    if (lower.endsWith(".wmv")) return "video/x-ms-wmv";
    if (lower.endsWith(".m4a")) return "audio/mp4";
    if (lower.endsWith(".mp3")) return "audio/mpeg";
    if (lower.endsWith(".aac")) return "audio/aac";
    if (lower.endsWith(".opus")) return "audio/opus";
    if (lower.endsWith(".ogg") || lower.endsWith(".oga")) return "audio/ogg";
    if (lower.endsWith(".wav")) return "audio/wav";
    if (lower.endsWith(".weba")) return "audio/webm";
    if (lower.endsWith(".flac")) return "audio/flac";
    if (lower.endsWith(".wma")) return "audio/x-ms-wma";
    return "video/mp4";
  }

  _onMutation(mutations) {
    let hasNewMedia = false;
    let hasNewIframes = false;
    let hasScriptInjection = false;

    for (const m of mutations) {
      // Attribute changes on existing elements
      if (m.type === "attributes" && m.target.nodeType === 1) {
        const tag = m.target.tagName;
        if (
          tag === "VIDEO" ||
          tag === "AUDIO" ||
          tag === "SOURCE" ||
          tag === "IFRAME" ||
          tag === "OBJECT" ||
          tag === "EMBED"
        ) {
          hasNewMedia = true;
        }
        continue;
      }

      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        const tag = node.tagName;

        if (
          tag === "VIDEO" ||
          tag === "AUDIO" ||
          tag === "SOURCE" ||
          tag === "OBJECT" ||
          tag === "EMBED" ||
          node.querySelector?.("video, audio, source, object, embed")
        ) {
          hasNewMedia = true;
        }

        if (tag === "IFRAME" || node.querySelector?.("iframe")) {
          hasNewIframes = true;
        }

        // Script tags with potential video config
        if (tag === "SCRIPT" && !node.src) {
          const text = node.textContent || "";
          if (
            text.length > 20 &&
            /m3u8|mpd|mp4|video_url|stream_url|player|videojs|jwplayer|file:\s*["']/i.test(
              text,
            )
          ) {
            hasScriptInjection = true;
          }
        }
      }
      if (hasNewMedia && hasNewIframes) break;
    }

    if (hasNewMedia || hasNewIframes || hasScriptInjection) {
      clearTimeout(this._scanDebounce);
      this._scanDebounce = setTimeout(() => {
        this._scanDOM();
        if (hasNewIframes) this._scanEmbeds();
        if (hasScriptInjection) {
          this._scanPageSource();
          this._scanPlayers();
        }
      }, 500);
    }
  }

  _scanPageSource() {
    const formats = [];

    for (const script of document.querySelectorAll("script:not([src])")) {
      const text = script.textContent;
      if (!text || text.length < 20) continue;

      const m3u8Matches = text.matchAll(
        /(https?:\/\/[^\s"'<>]+\.m3u8(?:\?[^\s"'<>]*)?)/gi,
      );
      for (const m of m3u8Matches) {
        const url = m[1];
        if (!this._detectedUrls.has(url)) {
          this._detectedUrls.add(url);
          formats.push(
            this.buildFormat({
              url,
              mimeType: "application/x-mpegurl",
              quality: "HLS Stream",
              qualityLabel: "HLS Stream (auto-converts to MP4 with audio)",
              isVideo: true,
              isMuxed: true,
              ext: "m3u8",
              hasAudio: true,
            }),
          );
        }
      }

      const mpdMatches = text.matchAll(
        /(https?:\/\/[^\s"'<>]+\.mpd(?:\?[^\s"'<>]*)?)/gi,
      );
      for (const m of mpdMatches) {
        const url = m[1];
        if (!this._detectedUrls.has(url)) {
          this._detectedUrls.add(url);
          formats.push(
            this.buildFormat({
              url,
              mimeType: "application/dash+xml",
              quality: "DASH Stream",
              qualityLabel: "DASH Stream",
              isVideo: true,
              isMuxed: true,
              ext: "mp4",
              isDASH: true,
            }),
          );
        }
      }

      const videoUrlMatches = text.matchAll(
        /(https?:\/\/[^\s"'<>]+\.(?:mp4|webm|mov|mkv|flv|f4v|m4v|avi)(?:\?[^\s"'<>]*)?)/gi,
      );
      for (const m of videoUrlMatches) {
        const url = m[1];

        if (url.length > 500) continue;
        if (
          /thumb|poster|preview|sprite|logo|icon|banner|placeholder/i.test(url)
        )
          continue;
        if (!this._detectedUrls.has(url)) {
          this._detectedUrls.add(url);
          const mime = this._guessMimeFromUrl(url);
          formats.push(
            this.buildFormat({
              url,
              mimeType: mime,
              quality: "Direct URL",
              qualityLabel: "Direct URL",
              isVideo: true,
              isMuxed: true,
              ext: this.guessExtension(mime),
            }),
          );
        }
      }

      // Audio file URLs in script tags
      const audioUrlMatches = text.matchAll(
        /(https?:\/\/[^\s"'<>]+\.(?:mp3|m4a|aac|ogg|opus|flac|wav)(?:\?[^\s"'<>]*)?)/gi,
      );
      for (const m of audioUrlMatches) {
        const url = m[1];
        if (url.length > 500) continue;
        if (/notification|alert|ui|click|button/i.test(url)) continue;
        if (!this._detectedUrls.has(url)) {
          this._detectedUrls.add(url);
          const mime = this._guessMimeFromUrl(url);
          formats.push(
            this.buildFormat({
              url,
              mimeType: mime,
              quality: "Audio URL",
              qualityLabel: "Audio — Direct URL",
              isVideo: false,
              isAudio: true,
              isMuxed: false,
              ext: this.guessExtension(mime),
            }),
          );
        }
      }

      // Video config object patterns: key: "value" or "key": "value"
      const configPatterns = [
        /["']?(?:video_?url|video_?src|stream_?url|hls_?url|dash_?url|manifest_?url|playback_?url|media_?url|file_?url|clip_?url|content_?url|download_?url|source_?url|asset_?url)["']?\s*[:=]\s*["'](https?:\/\/[^"']+)["']/gi,
      ];
      for (const pat of configPatterns) {
        const configMatches = text.matchAll(pat);
        for (const cm of configMatches) {
          const url = cm[1];
          if (url.length > 500 || this._detectedUrls.has(url)) continue;
          if (/thumb|poster|preview|sprite|logo|icon/i.test(url)) continue;
          this._detectedUrls.add(url);
          const mime = this._guessMimeFromUrl(url);
          formats.push(
            this.buildFormat({
              url,
              mimeType: mime,
              quality: "Config Value",
              qualityLabel: "Script Config URL",
              isVideo: true,
              isMuxed: true,
              ext: this.guessExtension(mime),
            }),
          );
        }
      }
    }

    if (formats.length > 0) {
      this.sendToBackground({
        videoId: this._generateId(),
        formats,
        formatSource: "generic_source",
        title: document.title,
      });
    }
  }

  _scanMetaTags() {
    const formats = this._extractFromMetaTags();
    if (formats.length > 0) {
      this.sendToBackground({
        videoId: this._generateId(),
        formats,
        formatSource: "generic_meta",
        title: document.title,
      });
    }
  }

  _extractFromMetaTags() {
    const formats = [];

    const ogVideo =
      document.querySelector('meta[property="og:video"]') ||
      document.querySelector('meta[property="og:video:url"]') ||
      document.querySelector('meta[property="og:video:secure_url"]');
    if (ogVideo?.content) {
      const url = ogVideo.content;
      if (!this._detectedUrls.has(url) && /^https?:\/\//.test(url)) {
        this._detectedUrls.add(url);
        const typeEl = document.querySelector('meta[property="og:video:type"]');
        const mime = typeEl?.content || this._guessMimeFromUrl(url);
        const widthEl = document.querySelector(
          'meta[property="og:video:width"]',
        );
        const heightEl = document.querySelector(
          'meta[property="og:video:height"]',
        );

        formats.push(
          this.buildFormat({
            url,
            mimeType: mime,
            quality: heightEl?.content ? `${heightEl.content}p` : "OG Video",
            qualityLabel: heightEl?.content
              ? `${heightEl.content}p`
              : "OG Video",
            width: parseInt(widthEl?.content) || 0,
            height: parseInt(heightEl?.content) || 0,
            isVideo: true,
            isMuxed: true,
            ext: this.guessExtension(mime),
          }),
        );
      }
    }

    const twVideo = document.querySelector(
      'meta[name="twitter:player:stream"]',
    );
    if (twVideo?.content) {
      const url = twVideo.content;
      if (!this._detectedUrls.has(url) && /^https?:\/\//.test(url)) {
        this._detectedUrls.add(url);
        const typeEl = document.querySelector(
          'meta[name="twitter:player:stream:content_type"]',
        );
        const mime = typeEl?.content || this._guessMimeFromUrl(url);

        formats.push(
          this.buildFormat({
            url,
            mimeType: mime,
            quality: "Twitter Card",
            qualityLabel: "Twitter Card",
            isVideo: true,
            isMuxed: true,
            ext: this.guessExtension(mime),
          }),
        );
      }
    }

    for (const script of document.querySelectorAll(
      'script[type="application/ld+json"]',
    )) {
      try {
        const data = JSON.parse(script.textContent);
        const videos = this._findJsonLdVideos(data);
        for (const v of videos) {
          if (v.contentUrl && !this._detectedUrls.has(v.contentUrl)) {
            this._detectedUrls.add(v.contentUrl);
            formats.push(
              this.buildFormat({
                url: v.contentUrl,
                mimeType:
                  v.encodingFormat || this._guessMimeFromUrl(v.contentUrl),
                quality: "JSON-LD Video",
                qualityLabel: v.name || "JSON-LD Video",
                isVideo: true,
                isMuxed: true,
                ext: this.guessExtension(v.encodingFormat || ""),
              }),
            );
          }

          if (
            v.embedUrl &&
            /\.m3u8/i.test(v.embedUrl) &&
            !this._detectedUrls.has(v.embedUrl)
          ) {
            this._detectedUrls.add(v.embedUrl);
            formats.push(
              this.buildFormat({
                url: v.embedUrl,
                mimeType: "application/x-mpegurl",
                quality: "HLS Stream",
                qualityLabel: "HLS (JSON-LD)",
                isVideo: true,
                isMuxed: true,
                ext: "m3u8",
              }),
            );
          }
        }
      } catch (e) {}
    }

    return formats;
  }

  _findJsonLdVideos(data) {
    const results = [];
    if (!data) return results;

    if (Array.isArray(data)) {
      for (const item of data) {
        results.push(...this._findJsonLdVideos(item));
      }
      return results;
    }

    if (typeof data === "object") {
      const type = data["@type"];
      if (type === "VideoObject" || type === "Movie" || type === "Episode") {
        results.push(data);
      }

      if (data["@graph"]) {
        results.push(...this._findJsonLdVideos(data["@graph"]));
      }
    }

    return results;
  }

  _extractFromLinks() {
    const formats = [];
    const videoExts = /\.(mp4|webm|mkv|flv|avi|m4v|mov|3gp|m3u8|mpd)(\?|$)/i;
    const audioExts = /\.(mp3|m4a|aac|ogg|opus|flac|wav|wma)(\?|$)/i;

    for (const a of document.querySelectorAll("a[href]")) {
      const href = a.href;
      if (!href) continue;
      if (this._detectedUrls.has(href)) continue;
      if (!/^https?:\/\//.test(href)) continue;

      const isVideo = videoExts.test(href);
      const isAudio = audioExts.test(href);

      if (!isVideo && !isAudio) continue;

      const text = (a.textContent || "").toLowerCase();
      if (/thumb|preview|poster|sprite|logo|icon/i.test(text)) continue;

      this._detectedUrls.add(href);
      const mime = this._guessMimeFromUrl(href);
      const qualityFromUrl = this._guessQualityFromUrl(href);

      formats.push(
        this.buildFormat({
          url: href,
          mimeType: mime,
          quality: qualityFromUrl || (isAudio ? "Audio Link" : "Direct Link"),
          qualityLabel:
            a.textContent?.trim()?.substring(0, 50) ||
            (isAudio ? "Audio Link" : "Direct Link"),
          isVideo: isVideo,
          isAudio: isAudio,
          isMuxed: isVideo,
          ext: this.guessExtension(mime),
        }),
      );
    }

    return formats;
  }

  _hookNetworkRequests() {
    this.listen(window, "message", (e) => {
      if (!e.data || e.data.type !== "__generic_extractor__") return;

      if (e.data.mseDetected) {
        this._mseDetected = true;
        console.log(this.TAG, "MSE detected:", e.data.mimeType);
        return;
      }

      // MSE Handle (Worker MediaSource) detected
      if (e.data.mseHandleDetected) {
        this._mseDetected = true;
        console.log(
          this.TAG,
          "MSE Worker Handle detected on",
          e.data.elementTag,
        );
        return;
      }

      // MediaStream (getUserMedia/canvas/tab capture) detected
      if (e.data.mediaStreamDetected) {
        console.log(
          this.TAG,
          "MediaStream detected:",
          e.data.trackCount,
          "tracks",
        );
        return;
      }

      // MSE appendBuffer activity
      if (e.data.mseAppend) {
        this._mseDetected = true;
        return;
      }

      // WebSocket detected — trigger deeper scan since WS-based players
      // often load video config dynamically
      if (e.data.webSocketDetected) {
        console.log(this.TAG, "WebSocket detected:", e.data.wsUrl);
        this.timer(() => {
          this._ssrDataScanned = false;
          this._scanSSRFrameworkData();
          this._jsGlobalsScanned = false;
          this._scanJSGlobals();
        }, 2000);
        return;
      }

      // EventSource detected
      if (e.data.eventSourceDetected) {
        console.log(this.TAG, "EventSource (SSE) detected:", e.data.sseUrl);
        return;
      }

      // WebRTC detected — flag this page as potentially using P2P video
      if (e.data.webrtcDetected) {
        console.log(
          this.TAG,
          "WebRTC connection detected, count:",
          e.data.connectionCount,
        );
        return;
      }

      // Embed iframe detected by network hook
      if (e.data.embedDetected && e.data.embedUrl) {
        const embedUrl = e.data.embedUrl;
        if (!this._detectedUrls.has(embedUrl)) {
          this._detectedUrls.add(embedUrl);
          const format = this.buildFormat({
            url: embedUrl,
            mimeType: "text/html",
            quality: "Embed Frame",
            qualityLabel: "Detected Embed Frame",
            isVideo: true,
            isMuxed: true,
            ext: "embed",
            embedType: "dynamic",
          });
          this.sendToBackground({
            videoId: this._generateId(),
            formats: [format],
            formatSource: "generic_dynamic_embed",
            title: document.title,
          });
        }
        return;
      }

      // Service Worker detected — log for diagnostics
      if (e.data.serviceWorkerDetected) {
        console.log(
          this.TAG,
          "Service Workers detected:",
          e.data.registrations?.length,
        );
        return;
      }
      if (e.data.serviceWorkerUnregistered) {
        console.log(this.TAG, "Service Worker unregistered:", e.data.scope);
        // Re-scan after SW unregistration since network requests now flow normally
        this.timer(() => {
          this._performanceScanned = false;
          this._scanPerformanceResources();
          this._scanDOM();
        }, 2000);
        return;
      }

      // DRM license server request detected
      if (e.data.drmLicenseServerUrl) {
        console.log(
          this.TAG,
          "DRM license request detected:",
          e.data.licenseUrl?.substring(0, 80),
        );
        return;
      }

      if (e.data.blobUrl) {
        this._blobUrls.set(e.data.blobUrl, {
          type: e.data.blobType,
          size: e.data.blobSize,
          timestamp: Date.now(),
        });

        if (e.data.isBlobVideo) {
          const format = this.buildFormat({
            url: e.data.blobUrl,
            mimeType: e.data.blobType,
            quality: "Blob Video",
            qualityLabel: `Blob (${this._formatBytes(e.data.blobSize)})`,
            isVideo: true,
            isMuxed: true,
            ext: "blob",
            isBlob: true,
            blobSize: e.data.blobSize,
          });

          this.sendToBackground({
            videoId: this._generateId(),
            formats: [format],
            formatSource: "generic_blob",
            title: document.title,
          });
        }
        return;
      }

      const url = e.data.url;
      if (!url || this._detectedUrls.has(url)) return;
      this._detectedUrls.add(url);

      const isM3u8 = /\.m3u8(\?|$)/i.test(url);
      const isMpd = /\.mpd(\?|$)/i.test(url);
      const isDirect = e.data.direct || false;
      const webAudio = e.data.webAudioDetected || false;
      const wsSource = e.data.wsSource || false;
      const sseSource = e.data.sseSource || false;
      const hlsContent = e.data.hlsContent || false;
      const dashContent = e.data.dashContent || false;
      const extractedFromResponse = e.data.extractedFromResponse || false;

      let mimeType, quality, qualityLabel, ext;
      if (isM3u8 || hlsContent) {
        mimeType = "application/x-mpegurl";
        quality = "HLS Stream";
        qualityLabel = wsSource
          ? "HLS (WebSocket)"
          : sseSource
            ? "HLS (SSE)"
            : extractedFromResponse
              ? "HLS (Response Body)"
              : webAudio
                ? "HLS (Web Audio) → MP4+audio"
                : "HLS (auto-converts to MP4 with audio)";
        ext = "m3u8";
      } else if (isMpd || dashContent) {
        mimeType = "application/dash+xml";
        quality = "DASH Stream";
        qualityLabel = wsSource
          ? "DASH (WebSocket)"
          : sseSource
            ? "DASH (SSE)"
            : extractedFromResponse
              ? "DASH (Response Body)"
              : webAudio
                ? "DASH (Web Audio) → MP4+audio"
                : "DASH (auto-converts to MP4 with audio)";
        ext = "mpd";
      } else {
        mimeType = this._guessMimeFromUrl(url);
        quality = "Direct URL";
        qualityLabel = wsSource
          ? "Intercepted (WebSocket)"
          : sseSource
            ? "Intercepted (SSE)"
            : webAudio
              ? "Intercepted (Web Audio)"
              : "Intercepted video";
        ext = this.guessExtension(mimeType);
      }

      const format = this.buildFormat({
        url,
        mimeType,
        quality,
        qualityLabel,
        isVideo: true,
        isMuxed: true,
        ext,
        webAudioDetected: webAudio,
        hasAudio: true,
      });

      const formatSource = wsSource
        ? "generic_websocket"
        : sseSource
          ? "generic_sse"
          : isDirect
            ? "generic_intercept_direct"
            : "generic_intercept";

      this.sendToBackground({
        videoId: this._generateId(),
        formats: [format],
        formatSource,
        title: document.title,
      });
    });
  }

  static get SKIP_HOSTS() {
    return new Set([
      "netflix.com",
      "www.netflix.com",
      "disneyplus.com",
      "www.disneyplus.com",
      "hulu.com",
      "www.hulu.com",
      "hbomax.com",
      "www.max.com",
      "max.com",
      "primevideo.com",
      "www.primevideo.com",
      "peacocktv.com",
      "www.peacocktv.com",
      "paramountplus.com",
      "www.paramountplus.com",
      "crunchyroll.com",
      "www.crunchyroll.com",
      "funimation.com",
      "www.funimation.com",
      "showtime.com",
      "www.showtime.com",
      "apple.com",
      "tv.apple.com",
      "play.google.com",

      "youtube.com",
      "www.youtube.com",
      "m.youtube.com",
      "music.youtube.com",
      "youtu.be",
      "twitter.com",
      "x.com",
      "mobile.twitter.com",
      "instagram.com",
      "www.instagram.com",

      "spotify.com",
      "open.spotify.com",
      "soundcloud.com",
      "tidal.com",
    ]);
  }

  _shouldSkip() {
    const hostname = window.location.hostname.toLowerCase();

    // Static skip list (DRM-only / dedicated sites)
    if (GenericExtractor.SKIP_HOSTS.has(hostname)) return true;

    const parts = hostname.split(".");
    if (parts.length > 2) {
      const parent = parts.slice(-2).join(".");
      if (GenericExtractor.SKIP_HOSTS.has(parent)) return true;
    }

    // Dynamic skip: any domain that has a site specialist
    if (typeof SITE_EXTRACTOR_MAP !== "undefined") {
      const noWww = hostname.replace(/^www\./, "");
      if (SITE_EXTRACTOR_MAP[hostname]) return true;
      if (SITE_EXTRACTOR_MAP[noWww]) return true;
      // Check parent domain (e.g. sub.flixtor.li → flixtor.li)
      for (let i = 1; i < parts.length - 1; i++) {
        const parent = parts.slice(i).join(".");
        if (SITE_EXTRACTOR_MAP[parent]) return true;
      }
    }

    return false;
  }

  _scanPlayers() {
    const formats = this._extractFromPlayers();
    if (formats.length > 0) {
      this.sendToBackground({
        videoId: this._generateId(),
        formats,
        formatSource: "generic_player",
        title: document.title,
      });
    }
  }

  _extractFromPlayers() {
    const formats = [];

    formats.push(...this._detectJWPlayer());

    formats.push(...this._detectBrightcove());

    formats.push(...this._detectVideoJS());

    formats.push(...this._detectFlowPlayer());

    formats.push(...this._detectPlyr());

    formats.push(...this._detectMediaElement());

    formats.push(...this._detectWistia());

    return formats;
  }

  _detectJWPlayer() {
    const formats = [];

    try {
      for (const script of document.querySelectorAll("script:not([src])")) {
        const text = script.textContent;
        if (!text) continue;

        const setupMatch = text.match(
          /jwplayer\s*\([^)]*\)\s*\.setup\s*\(\s*({[\s\S]*?})\s*\)/,
        );
        if (setupMatch) {
          this._extractJWConfig(setupMatch[1], formats);
        }

        const configMatch = text.match(
          /\.setup\s*\(\s*({[\s\S]*?"(?:file|sources|playlist)"[\s\S]*?})\s*\)/,
        );
        if (configMatch) {
          this._extractJWConfig(configMatch[1], formats);
        }

        const playlistMatch = text.match(
          /"playlist"\s*:\s*(\[[\s\S]*?\])\s*[,}]/,
        );
        if (playlistMatch) {
          try {
            const playlist = JSON.parse(playlistMatch[1]);
            for (const item of playlist) {
              if (item.file) {
                this._addPlayerUrl(item.file, "JWPlayer", formats);
              }
              if (item.sources) {
                for (const src of item.sources) {
                  if (src.file) {
                    this._addPlayerUrl(
                      src.file,
                      `JWPlayer ${src.label || ""}`.trim(),
                      formats,
                    );
                  }
                }
              }
            }
          } catch {}
        }
      }

      const jwContainers = document.querySelectorAll(
        "[data-jw-player-id], .jwplayer, #jwplayer, [id^=jwplayer]",
      );
      for (const el of jwContainers) {
        const dataSetup = el.getAttribute("data-setup");
        if (dataSetup) {
          this._extractJWConfig(dataSetup, formats);
        }
      }
    } catch (e) {
      console.debug(this.TAG, "JWPlayer scan error:", e.message);
    }

    return formats;
  }

  _extractJWConfig(configStr, formats) {
    try {
      const config = JSON.parse(
        configStr
          .replace(/'/g, '"')
          .replace(/(\w+)\s*:/g, '"$1":')
          .replace(/,\s*}/g, "}"),
      );

      if (config.file) {
        this._addPlayerUrl(config.file, "JWPlayer", formats);
      }
      if (config.sources) {
        for (const s of config.sources) {
          if (s.file) {
            this._addPlayerUrl(
              s.file,
              `JWPlayer ${s.label || ""}`.trim(),
              formats,
            );
          }
        }
      }
      if (config.playlist) {
        for (const item of config.playlist) {
          if (item.file) {
            this._addPlayerUrl(item.file, "JWPlayer", formats);
          }
          if (item.sources) {
            for (const s of item.sources) {
              if (s.file)
                this._addPlayerUrl(
                  s.file,
                  `JWPlayer ${s.label || ""}`.trim(),
                  formats,
                );
            }
          }
        }
      }
    } catch {
      const fileMatches = configStr.matchAll(
        /["']?file["']?\s*:\s*["']([^"']+)["']/gi,
      );
      for (const m of fileMatches) {
        this._addPlayerUrl(m[1], "JWPlayer", formats);
      }
    }
  }

  _detectBrightcove() {
    const formats = [];

    try {
      const bcPlayers = document.querySelectorAll(
        "video-js[data-video-id], .video-js[data-video-id]",
      );
      for (const player of bcPlayers) {
        const videoId = player.getAttribute("data-video-id");
        const account = player.getAttribute("data-account");
        if (videoId && account) {
          const apiUrl = `https://edge.api.brightcove.com/playback/v1/accounts/${account}/videos/${videoId}`;
          this._addPlayerUrl(apiUrl, "Brightcove API", formats);
        }

        for (const src of player.querySelectorAll("source")) {
          if (src.src) {
            this._addPlayerUrl(src.src, "Brightcove", formats);
          }
        }
      }

      for (const script of document.querySelectorAll("script:not([src])")) {
        const text = script.textContent;
        if (!text) continue;

        const bcConfigMatch = text.match(
          /data-video-id\s*[=:]\s*["']?(\d+)["']?/,
        );
        const bcAccMatch = text.match(/data-account\s*[=:]\s*["']?(\d+)["']?/);
        if (bcConfigMatch && bcAccMatch) {
          const apiUrl = `https://edge.api.brightcove.com/playback/v1/accounts/${bcAccMatch[1]}/videos/${bcConfigMatch[1]}`;
          this._addPlayerUrl(apiUrl, "Brightcove API", formats);
        }
      }
    } catch (e) {
      console.debug(this.TAG, "Brightcove scan error:", e.message);
    }

    return formats;
  }

  _detectVideoJS() {
    const formats = [];

    try {
      const vjsPlayers = document.querySelectorAll(
        ".video-js video, video-js video, video.video-js",
      );
      for (const video of vjsPlayers) {
        const vf = this._extractFromVideoEl(video);
        for (const f of vf) {
          f.qualityLabel = "Video.js: " + (f.qualityLabel || "");
          formats.push(f);
        }
      }

      for (const script of document.querySelectorAll("script:not([src])")) {
        const text = script.textContent;
        if (!text || !text.includes("videojs")) continue;

        const srcMatches = text.matchAll(
          /["']?src["']?\s*:\s*["'](https?:\/\/[^"']+)["']/gi,
        );
        for (const m of srcMatches) {
          this._addPlayerUrl(m[1], "Video.js", formats);
        }
      }
    } catch (e) {
      console.debug(this.TAG, "Video.js scan error:", e.message);
    }

    return formats;
  }

  _detectFlowPlayer() {
    const formats = [];

    try {
      const fpPlayers = document.querySelectorAll(
        ".flowplayer[data-clip], .flowplayer[data-src]",
      );
      for (const el of fpPlayers) {
        const dataSrc = el.getAttribute("data-src");
        if (dataSrc) {
          this._addPlayerUrl(dataSrc, "FlowPlayer", formats);
        }

        const dataClip = el.getAttribute("data-clip");
        if (dataClip) {
          try {
            const clip = JSON.parse(dataClip);
            if (clip.sources) {
              for (const src of clip.sources) {
                if (src.src) {
                  this._addPlayerUrl(
                    src.src,
                    `FlowPlayer ${src.type || ""}`.trim(),
                    formats,
                  );
                }
              }
            }
          } catch {}
        }
      }

      for (const script of document.querySelectorAll("script:not([src])")) {
        const text = script.textContent;
        if (!text || !text.includes("flowplayer")) continue;

        const clipMatch = text.match(/clip\s*:\s*({[\s\S]*?sources[\s\S]*?})/);
        if (clipMatch) {
          const srcMatches = clipMatch[1].matchAll(
            /["']?src["']?\s*:\s*["'](https?:\/\/[^"']+)["']/gi,
          );
          for (const m of srcMatches) {
            this._addPlayerUrl(m[1], "FlowPlayer", formats);
          }
        }
      }
    } catch (e) {
      console.debug(this.TAG, "FlowPlayer scan error:", e.message);
    }

    return formats;
  }

  _detectPlyr() {
    const formats = [];

    try {
      const plyrPlayers = document.querySelectorAll(
        ".plyr video, .plyr audio, [data-plyr-provider]",
      );
      for (const el of plyrPlayers) {
        if (el.tagName === "VIDEO" || el.tagName === "AUDIO") {
          const vf = this._extractFromVideoEl(el);
          for (const f of vf) {
            f.qualityLabel = "Plyr: " + (f.qualityLabel || "");
            formats.push(f);
          }
        }
      }
    } catch (e) {
      console.debug(this.TAG, "Plyr scan error:", e.message);
    }

    return formats;
  }

  _detectMediaElement() {
    const formats = [];

    try {
      const mejsPlayers = document.querySelectorAll(
        ".mejs__container video, .mejs__container audio, .mejs-container video",
      );
      for (const el of mejsPlayers) {
        const vf = this._extractFromVideoEl(el);
        for (const f of vf) {
          f.qualityLabel = "MediaElement: " + (f.qualityLabel || "");
          formats.push(f);
        }
      }
    } catch (e) {
      console.debug(this.TAG, "MediaElement scan error:", e.message);
    }

    return formats;
  }

  _detectWistia() {
    const formats = [];

    try {
      const wistiaEls = document.querySelectorAll(
        ".wistia_embed[data-video-id], [class*=wistia_async_]",
      );
      for (const el of wistiaEls) {
        let videoId = el.getAttribute("data-video-id");
        if (!videoId) {
          const classMatch = el.className.match(/wistia_async_(\w+)/);
          if (classMatch) videoId = classMatch[1];
        }
        if (videoId) {
          const apiUrl = `https://fast.wistia.net/embed/medias/${videoId}.json`;
          this._addPlayerUrl(apiUrl, "Wistia API", formats);
        }
      }

      for (const script of document.querySelectorAll(
        'script[src*="wistia.com"], script[src*="wistia.net"]',
      )) {
        const srcMatch = script.src.match(
          /(?:wistia\.com|wistia\.net)\/(?:embed\/)?medias\/(\w+)/,
        );
        if (srcMatch) {
          const apiUrl = `https://fast.wistia.net/embed/medias/${srcMatch[1]}.json`;
          this._addPlayerUrl(apiUrl, "Wistia API", formats);
        }
      }
    } catch (e) {
      console.debug(this.TAG, "Wistia scan error:", e.message);
    }

    return formats;
  }

  _addPlayerUrl(url, playerName, formats) {
    if (!url || this._detectedUrls.has(url)) return;
    if (!/^https?:\/\//.test(url)) {
      try {
        url = new URL(url, window.location.href).href;
      } catch {
        return;
      }
    }
    this._detectedUrls.add(url);

    const isM3u8 = /\.m3u8(\?|$)/i.test(url);
    const isMpd = /\.mpd(\?|$)/i.test(url);
    const isApi = /api|json/i.test(url);

    let mimeType, ext;
    if (isM3u8) {
      mimeType = "application/x-mpegurl";
      ext = "m3u8";
    } else if (isMpd) {
      mimeType = "application/dash+xml";
      ext = "mpd";
    } else {
      mimeType = this._guessMimeFromUrl(url);
      ext = isApi ? "json" : this.guessExtension(mimeType);
    }

    formats.push(
      this.buildFormat({
        url,
        mimeType,
        quality: playerName,
        qualityLabel: playerName,
        isVideo: !isApi,
        isMuxed: true,
        ext,
      }),
    );
  }

  _scanEmbeds() {
    const formats = this._extractFromEmbeds();
    if (formats.length > 0) {
      this.sendToBackground({
        videoId: this._generateId(),
        formats,
        formatSource: "generic_embed",
        title: document.title,
      });
    }
  }

  _extractFromEmbeds() {
    const formats = [];
    const embedPatterns = [
      {
        regex: /(?:youtube\.com|youtu\.be)\/embed\/([\w-]{11})/,
        name: "YouTube Embed",
        makeUrl: (id) => `https://www.youtube.com/watch?v=${id}`,
      },

      {
        regex: /player\.vimeo\.com\/video\/(\d+)/,
        name: "Vimeo Embed",
        makeUrl: (id) => `https://vimeo.com/${id}`,
      },

      {
        regex: /dailymotion\.com\/embed\/video\/(\w+)/,
        name: "Dailymotion Embed",
        makeUrl: (id) => `https://www.dailymotion.com/video/${id}`,
      },

      {
        regex: /facebook\.com\/plugins\/video\.php\?href=([^&"]+)/,
        name: "Facebook Embed",
        makeUrl: (encoded) => decodeURIComponent(encoded),
      },

      {
        regex: /streamable\.com\/(?:e\/|o\/)?(\w+)/,
        name: "Streamable",
        makeUrl: (id) => `https://streamable.com/${id}`,
      },

      {
        regex: /play\.vidyard\.com\/(\w+)/,
        name: "Vidyard",
        makeUrl: (id) => `https://play.vidyard.com/${id}`,
      },
    ];

    try {
      const iframes = document.querySelectorAll("iframe[src]");
      for (const iframe of iframes) {
        const src = iframe.src;
        if (!src) continue;

        for (const pattern of embedPatterns) {
          const match = src.match(pattern.regex);
          if (match) {
            const url = pattern.makeUrl(match[1]);
            if (this._detectedUrls.has(url)) continue;
            this._detectedUrls.add(url);

            formats.push(
              this.buildFormat({
                url,
                mimeType: "text/html",
                quality: pattern.name,
                qualityLabel: pattern.name,
                isVideo: true,
                isMuxed: true,
                ext: "embed",
                embedType: pattern.name,
              }),
            );
            break;
          }
        }

        if (/\.(m3u8|mpd|mp4|webm)(\?|$)/i.test(src)) {
          this._addPlayerUrl(src, "Embedded Video", formats);
        }
      }
    } catch (e) {
      console.debug(this.TAG, "Embed scan error:", e.message);
    }

    return formats;
  }

  _generateId() {
    const loc = window.location;
    return btoa(loc.hostname + loc.pathname)
      .replace(/[^a-zA-Z0-9]/g, "")
      .substring(0, 16);
  }

  _formatBytes(bytes) {
    if (!bytes || bytes <= 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.min(
      Math.floor(Math.log(bytes) / Math.log(k)),
      sizes.length - 1,
    );
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + " " + sizes[i];
  }

  _scanShadowDOM() {
    const formats = [];

    try {
      const allElements = document.querySelectorAll("*");
      for (const el of allElements) {
        if (el.shadowRoot) {
          const videos = el.shadowRoot.querySelectorAll("video");
          for (const video of videos) {
            const vf = this._extractFromVideoEl(video);
            for (const f of vf) {
              f.qualityLabel = "Shadow DOM: " + (f.qualityLabel || "");
              formats.push(f);
            }
          }

          const audios = el.shadowRoot.querySelectorAll("audio");
          for (const audio of audios) {
            const af = this._extractFromAudioEl(audio);
            for (const f of af) {
              f.qualityLabel = "Shadow DOM: " + (f.qualityLabel || "");
              formats.push(f);
            }
          }

          const nestedFormats = this._scanShadowDOMRecursive(el.shadowRoot);
          formats.push(...nestedFormats);
        }
      }
    } catch (e) {
      console.debug(this.TAG, "Shadow DOM scan error:", e.message);
    }

    return formats;
  }

  _scanShadowDOMRecursive(root) {
    const formats = [];

    try {
      const allElements = root.querySelectorAll("*");
      for (const el of allElements) {
        if (el.shadowRoot) {
          const videos = el.shadowRoot.querySelectorAll("video");
          for (const video of videos) {
            const vf = this._extractFromVideoEl(video);
            formats.push(...vf);
          }

          const audios = el.shadowRoot.querySelectorAll("audio");
          for (const audio of audios) {
            const af = this._extractFromAudioEl(audio);
            formats.push(...af);
          }

          formats.push(...this._scanShadowDOMRecursive(el.shadowRoot));
        }
      }
    } catch (e) {}

    return formats;
  }

  _extractFromAudioEl(audio) {
    const formats = [];
    const urls = new Set();

    if (audio.src && !audio.src.startsWith("data:")) {
      urls.add(audio.src);
    }

    if (audio.currentSrc && !audio.currentSrc.startsWith("data:")) {
      urls.add(audio.currentSrc);
    }

    for (const source of audio.querySelectorAll("source")) {
      if (source.src && !source.src.startsWith("data:")) {
        urls.add(source.src);
      }
    }

    for (const url of urls) {
      if (this._detectedUrls.has(url)) continue;
      this._detectedUrls.add(url);

      const mime = this._guessMimeFromUrl(url);
      const isBlob = url.startsWith("blob:");

      formats.push(
        this.buildFormat({
          url,
          mimeType: isBlob ? audio.type || mime : mime,
          quality: "Audio",
          qualityLabel: isBlob ? "Blob Audio" : "Audio",
          isVideo: false,
          isAudio: true,
          isMuxed: false,
          ext: isBlob ? "blob" : this.guessExtension(mime),
          isBlob: isBlob,
        }),
      );
    }

    return formats;
  }

  _scanPerformanceResources() {
    if (this._performanceScanned) return;
    if (this._destroyed) return;
    this._performanceScanned = true;

    try {
      if (!window.performance || !window.performance.getEntriesByType) return;

      const resources = window.performance.getEntriesByType("resource");
      const formats = [];

      for (const resource of resources) {
        const url = resource.name;
        if (!url || this._detectedUrls.has(url)) continue;

        const isMedia =
          /\.(m3u8|mpd|mp4|webm|flv|ts|m4s|mp3|aac|ogg|wav)(\?|$)/i.test(url);
        const isCDN = /cdn|media|stream|video|audio|content/i.test(url);
        const isLargeTransfer = resource.transferSize > 1024 * 100;

        if (isMedia || (isCDN && isLargeTransfer)) {
          this._detectedUrls.add(url);

          const mime = this._guessMimeFromUrl(url);
          const isM3u8 = /\.m3u8(\?|$)/i.test(url);
          const isMpd = /\.mpd(\?|$)/i.test(url);

          formats.push(
            this.buildFormat({
              url,
              mimeType: mime,
              quality: `Performance (${this._formatBytes(resource.transferSize)})`,
              qualityLabel: `Performance API: ${this._formatBytes(resource.transferSize)}`,
              isVideo: !url.match(/\.(mp3|aac|ogg|wav)(\?|$)/i),
              isMuxed: true,
              ext: isM3u8 ? "m3u8" : isMpd ? "mpd" : this.guessExtension(mime),
              transferSize: resource.transferSize,
              duration: resource.duration,
            }),
          );
        }
      }

      if (formats.length > 0) {
        this.sendToBackground({
          videoId: this._generateId(),
          formats,
          formatSource: "generic_performance",
          title: document.title,
        });
      }

      this.timer(() => {
        this._performanceScanned = false;
        this._scanPerformanceResources();
      }, 10000);
    } catch (e) {
      console.debug(this.TAG, "Performance API scan error:", e.message);
    }
  }

  _initImageDetection() {
    try {
      if (!window.IntersectionObserver) {
        console.debug(this.TAG, "IntersectionObserver not supported");
        return;
      }

      this._imageObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              this._detectImageResource(entry.target);
            }
          }
        },
        {
          root: null,
          rootMargin: "50px",
          threshold: 0.01,
        },
      );

      const images = document.querySelectorAll("img");
      for (const img of images) {
        this._imageObserver.observe(img);
      }

      this.observe(
        document.body || document.documentElement,
        {
          childList: true,
          subtree: true,
        },
        (mutations) => {
          for (const m of mutations) {
            for (const node of m.addedNodes) {
              if (node.nodeType !== 1) continue;
              if (node.tagName === "IMG") {
                this._imageObserver.observe(node);
              } else if (node.querySelectorAll) {
                const imgs = node.querySelectorAll("img");
                for (const img of imgs) {
                  this._imageObserver.observe(img);
                }
              }
            }
          }
        },
      );
    } catch (e) {
      console.debug(this.TAG, "Image detection init error:", e.message);
    }
  }

  _detectImageResource(img) {
    try {
      const src = img.src || img.dataset.src || img.currentSrc;
      if (!src || this._detectedUrls.has(src)) return;

      if (img.naturalWidth > 800 || img.naturalHeight > 800) {
        this._detectedUrls.add(src);

        let transferSize = 0;
        if (window.performance && window.performance.getEntriesByName) {
          const entries = window.performance.getEntriesByName(src);
          if (entries.length > 0) {
            transferSize = entries[0].transferSize || 0;
          }
        }

        const sizeLabel = transferSize
          ? ` (${this._formatBytes(transferSize)})`
          : "";

        this.sendToBackground({
          videoId: this._generateId(),
          formats: [
            this.buildFormat({
              url: src,
              mimeType: "image/*",
              quality: `${img.naturalWidth}x${img.naturalHeight}`,
              qualityLabel: `Image: ${img.naturalWidth}x${img.naturalHeight}${sizeLabel}`,
              isVideo: false,
              isImage: true,
              isMuxed: false,
              ext: this._guessImageExt(src),
              width: img.naturalWidth,
              height: img.naturalHeight,
              transferSize: transferSize,
            }),
          ],
          formatSource: "generic_hidden_image",
          title: document.title,
        });
      }
    } catch (e) {}
  }

  _guessImageExt(url) {
    const lower = url.toLowerCase().split("?")[0];
    if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "jpg";
    if (lower.endsWith(".png")) return "png";
    if (lower.endsWith(".webp")) return "webp";
    if (lower.endsWith(".gif")) return "gif";
    if (lower.endsWith(".svg")) return "svg";
    return "jpg";
  }

  _scanBackgroundImages() {
    try {
      const formats = [];

      const candidates = document.querySelectorAll(
        '[style*="background"], [class*="hero"], [class*="banner"], ' +
          '[class*="cover"], [class*="bg"], [class*="background"], ' +
          '[class*="slide"], [class*="image"], [class*="photo"], ' +
          '[role="img"], section, header, .wp-block-cover',
      );

      for (const el of candidates) {
        const style = window.getComputedStyle(el);
        const bgImage = style.backgroundImage;

        if (bgImage && bgImage !== "none") {
          const urlMatches = bgImage.matchAll(/url\(["']?([^"')]+)["']?\)/g);

          for (const match of urlMatches) {
            let url = match[1];

            if (url.startsWith("data:")) continue;

            try {
              url = new URL(url, window.location.href).href;
            } catch {
              continue;
            }

            if (this._detectedUrls.has(url)) continue;

            const img = new Image();
            img.onload = () => {
              if (img.naturalWidth > 500 || img.naturalHeight > 500) {
                if (this._detectedUrls.has(url)) return;
                this._detectedUrls.add(url);

                this.sendToBackground({
                  videoId: this._generateId(),
                  formats: [
                    this.buildFormat({
                      url,
                      mimeType: "image/*",
                      quality: `${img.naturalWidth}x${img.naturalHeight}`,
                      qualityLabel: `CSS Background: ${img.naturalWidth}x${img.naturalHeight}`,
                      isVideo: false,
                      isImage: true,
                      isMuxed: false,
                      ext: this._guessImageExt(url),
                      width: img.naturalWidth,
                      height: img.naturalHeight,
                    }),
                  ],
                  formatSource: "generic_css_background",
                  title: document.title,
                });
              }
            };
            img.src = url;
          }
        }
      }
    } catch (e) {
      console.debug(this.TAG, "CSS background scan error:", e.message);
    }
  }

  _scanResponsiveImages() {
    try {
      const formats = [];

      const pictures = document.querySelectorAll("picture");
      for (const picture of pictures) {
        const sources = picture.querySelectorAll("source");
        for (const source of sources) {
          const srcset = source.srcset;
          if (srcset) {
            this._extractFromSrcset(srcset, formats);
          }
        }

        const img = picture.querySelector("img");
        if (img) {
          if (img.srcset) {
            this._extractFromSrcset(img.srcset, formats);
          }
          if (img.src && !this._detectedUrls.has(img.src)) {
            this._extractSingleImage(img.src, formats);
          }
        }
      }

      const images = document.querySelectorAll("img[srcset]");
      for (const img of images) {
        this._extractFromSrcset(img.srcset, formats);
      }

      if (formats.length > 0) {
        this.sendToBackground({
          videoId: this._generateId(),
          formats,
          formatSource: "generic_responsive_images",
          title: document.title,
        });
      }
    } catch (e) {
      console.debug(this.TAG, "Responsive image scan error:", e.message);
    }
  }

  _extractFromSrcset(srcset, formats) {
    const entries = srcset.split(",");

    for (const entry of entries) {
      const parts = entry.trim().split(/\s+/);
      if (parts.length === 0) continue;

      let url = parts[0];
      const descriptor = parts[1] || "1x";

      try {
        url = new URL(url, window.location.href).href;
      } catch {
        continue;
      }

      if (this._detectedUrls.has(url)) continue;
      this._detectedUrls.add(url);

      formats.push(
        this.buildFormat({
          url,
          mimeType: "image/*",
          quality: descriptor,
          qualityLabel: `Responsive Image: ${descriptor}`,
          isVideo: false,
          isImage: true,
          isMuxed: false,
          ext: this._guessImageExt(url),
        }),
      );
    }
  }

  _extractSingleImage(url, formats) {
    try {
      url = new URL(url, window.location.href).href;
    } catch {
      return;
    }

    if (this._detectedUrls.has(url)) return;
    this._detectedUrls.add(url);

    formats.push(
      this.buildFormat({
        url,
        mimeType: "image/*",
        quality: "Image",
        qualityLabel: "Image",
        isVideo: false,
        isImage: true,
        isMuxed: false,
        ext: this._guessImageExt(url),
      }),
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SSR Framework Data Scanner — Next.js, Nuxt, Gatsby, Remix, etc.
  // ═══════════════════════════════════════════════════════════════════════
  _scanSSRFrameworkData() {
    if (this._ssrDataScanned) return;
    this._ssrDataScanned = true;

    const formats = [];

    // Map of global variable names to framework identifiers
    const SSR_GLOBALS = [
      { key: "__NEXT_DATA__", name: "Next.js" },
      { key: "__NUXT__", name: "Nuxt" },
      { key: "__INITIAL_STATE__", name: "SSR" },
      { key: "__DATA__", name: "SSR" },
      { key: "__UNIVERSAL_DATA__", name: "SSR" },
      { key: "__APOLLO_STATE__", name: "Apollo" },
      { key: "__RELAY_STORE__", name: "Relay" },
      { key: "__PRELOADED_STATE__", name: "Redux" },
      { key: "__APP_DATA__", name: "SSR" },
      { key: "__INITIAL_PROPS__", name: "SSR" },
      { key: "__SERVER_DATA__", name: "SSR" },
      { key: "__PAGE_DATA__", name: "Gatsby" },
      { key: "__remixContext", name: "Remix" },
      { key: "__SVELTE_DATA__", name: "Svelte" },
      { key: "SERVER_STATE", name: "SSR" },
    ];

    for (const { key, name } of SSR_GLOBALS) {
      try {
        const data = window[key];
        if (!data || typeof data !== "object") continue;

        const json = JSON.stringify(data);
        if (json.length > 5000000) continue; // Skip huge state trees

        // Extract video URLs from stringified JSON
        this._extractUrlsFromJSON(json, `${name} (${key})`, formats);
      } catch (e) {
        console.debug(this.TAG, `Error scanning ${key}:`, e.message);
      }
    }

    // Scan script[type="application/json"] blocks (hydration data)
    for (const script of document.querySelectorAll(
      'script[type="application/json"], script[id*="__NEXT_DATA__"], script[id*="__NUXT__"], script[id*="initial-state"], script[id*="server-data"]',
    )) {
      try {
        const text = script.textContent;
        if (!text || text.length < 30 || text.length > 5000000) continue;
        this._extractUrlsFromJSON(text, "Hydration JSON", formats);
      } catch (e) {}
    }

    // Scan script tags with type=application/ld+json (already done partially, but deeper)
    // Also scan for type=importmap, type=speculationrules that might reference media
    for (const script of document.querySelectorAll(
      'script[type="application/ld+json"]',
    )) {
      try {
        const data = JSON.parse(script.textContent);
        const urls = this._deepExtractVideoUrls(data);
        for (const urlInfo of urls) {
          if (!this._detectedUrls.has(urlInfo.url)) {
            this._detectedUrls.add(urlInfo.url);
            const mime = this._guessMimeFromUrl(urlInfo.url);
            formats.push(
              this.buildFormat({
                url: urlInfo.url,
                mimeType: mime,
                quality: `LD+JSON: ${urlInfo.context || "Video"}`,
                qualityLabel: `LD+JSON: ${urlInfo.context || "Video"}`,
                isVideo: true,
                isMuxed: true,
                ext: this.guessExtension(mime),
              }),
            );
          }
        }
      } catch (e) {}
    }

    if (formats.length > 0) {
      console.log(
        this.TAG,
        `SSR/framework scan found ${formats.length} formats`,
      );
      this.sendToBackground({
        videoId: this._generateId(),
        formats,
        formatSource: "generic_ssr_data",
        title: document.title,
      });
    }
  }

  _extractUrlsFromJSON(jsonStr, source, formats) {
    // HLS manifests
    const m3u8Matches = jsonStr.matchAll(
      /(https?:\/\/[^"'\s\\<>]+\.m3u8(?:\?[^"'\s\\<>]*)?)/gi,
    );
    for (const m of m3u8Matches) {
      const url = this._unescapeJsonUrl(m[1]);
      if (!this._detectedUrls.has(url)) {
        this._detectedUrls.add(url);
        formats.push(
          this.buildFormat({
            url,
            mimeType: "application/x-mpegurl",
            quality: `HLS (${source})`,
            qualityLabel: `HLS Stream from ${source}`,
            isVideo: true,
            isMuxed: true,
            ext: "m3u8",
            hasAudio: true,
          }),
        );
      }
    }

    // DASH manifests
    const mpdMatches = jsonStr.matchAll(
      /(https?:\/\/[^"'\s\\<>]+\.mpd(?:\?[^"'\s\\<>]*)?)/gi,
    );
    for (const m of mpdMatches) {
      const url = this._unescapeJsonUrl(m[1]);
      if (!this._detectedUrls.has(url)) {
        this._detectedUrls.add(url);
        formats.push(
          this.buildFormat({
            url,
            mimeType: "application/dash+xml",
            quality: `DASH (${source})`,
            qualityLabel: `DASH Stream from ${source}`,
            isVideo: true,
            isMuxed: true,
            ext: "mpd",
            isDASH: true,
          }),
        );
      }
    }

    // Direct video files
    const videoMatches = jsonStr.matchAll(
      /(https?:\/\/[^"'\s\\<>]+\.(?:mp4|webm|mov|mkv|flv|f4v|m4v|avi)(?:\?[^"'\s\\<>]*)?)/gi,
    );
    for (const m of videoMatches) {
      const url = this._unescapeJsonUrl(m[1]);
      if (url.length > 500) continue;
      if (/thumb|poster|preview|sprite|logo|icon|banner/i.test(url)) continue;
      if (!this._detectedUrls.has(url)) {
        this._detectedUrls.add(url);
        const mime = this._guessMimeFromUrl(url);
        formats.push(
          this.buildFormat({
            url,
            mimeType: mime,
            quality: `Video (${source})`,
            qualityLabel: `Video from ${source}`,
            isVideo: true,
            isMuxed: true,
            ext: this.guessExtension(mime),
          }),
        );
      }
    }

    // Audio files
    const audioMatches = jsonStr.matchAll(
      /(https?:\/\/[^"'\s\\<>]+\.(?:mp3|m4a|aac|ogg|opus|flac|wav|wma)(?:\?[^"'\s\\<>]*)?)/gi,
    );
    for (const m of audioMatches) {
      const url = this._unescapeJsonUrl(m[1]);
      if (url.length > 500) continue;
      if (!this._detectedUrls.has(url)) {
        this._detectedUrls.add(url);
        const mime = this._guessMimeFromUrl(url);
        formats.push(
          this.buildFormat({
            url,
            mimeType: mime,
            quality: `Audio (${source})`,
            qualityLabel: `Audio from ${source}`,
            isVideo: false,
            isAudio: true,
            isMuxed: false,
            ext: this.guessExtension(mime),
          }),
        );
      }
    }
  }

  _unescapeJsonUrl(url) {
    try {
      return url
        .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
          String.fromCharCode(parseInt(hex, 16)),
        )
        .replace(/\\\//g, "/")
        .replace(/\\&/g, "&");
    } catch {
      return url;
    }
  }

  _deepExtractVideoUrls(obj, context = "", depth = 0) {
    const results = [];
    if (!obj || depth > 10) return results;

    if (typeof obj === "string") {
      if (/^https?:\/\/.+\.(m3u8|mpd|mp4|webm|mov|flv)(\?|$)/i.test(obj)) {
        results.push({ url: obj, context });
      }
      return results;
    }

    if (Array.isArray(obj)) {
      for (const item of obj) {
        results.push(...this._deepExtractVideoUrls(item, context, depth + 1));
      }
      return results;
    }

    if (typeof obj === "object") {
      // Check known video-related property names
      const VIDEO_KEYS = [
        "videoUrl",
        "video_url",
        "videoURL",
        "streamUrl",
        "stream_url",
        "streamURL",
        "hlsUrl",
        "hls_url",
        "dashUrl",
        "dash_url",
        "manifestUrl",
        "manifest_url",
        "playbackUrl",
        "playback_url",
        "contentUrl",
        "content_url",
        "embedUrl",
        "embed_url",
        "fileUrl",
        "file_url",
        "file",
        "src",
        "source",
        "url",
        "mp4",
        "webm",
        "hls",
        "dash",
        "sources",
        "media_url",
        "media",
        "video_file",
        "clip_url",
        "download_url",
        "asset_url",
      ];

      for (const key of Object.keys(obj)) {
        const lowerKey = key.toLowerCase();
        const isVideoKey = VIDEO_KEYS.some(
          (vk) => lowerKey === vk.toLowerCase(),
        );
        const val = obj[key];

        if (isVideoKey && typeof val === "string" && /^https?:\/\//.test(val)) {
          results.push({ url: val, context: key });
        } else if (typeof val === "object" || Array.isArray(val)) {
          results.push(...this._deepExtractVideoUrls(val, key, depth + 1));
        }
      }
    }

    return results;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Data Attribute Scanner — data-video-url, data-src, data-stream, etc.
  // ═══════════════════════════════════════════════════════════════════════
  _scanDataAttributes() {
    if (this._dataAttrsScanned) return;
    this._dataAttrsScanned = true;

    const formats = [];

    const VIDEO_DATA_ATTRS = [
      "data-video-url",
      "data-video-src",
      "data-video",
      "data-src",
      "data-stream-url",
      "data-stream",
      "data-hls",
      "data-hls-url",
      "data-dash-url",
      "data-mpd",
      "data-m3u8",
      "data-mp4",
      "data-media-url",
      "data-media",
      "data-file",
      "data-file-url",
      "data-source",
      "data-source-url",
      "data-clip-url",
      "data-content-url",
      "data-playback-url",
      "data-embed-url",
      "data-player-url",
      "data-manifest-url",
      "data-manifest",
      "data-config-url",
    ];

    // Build a single CSS selector for efficiency
    const selector = VIDEO_DATA_ATTRS.map((attr) => `[${attr}]`).join(", ");

    try {
      const elements = document.querySelectorAll(selector);
      for (const el of elements) {
        for (const attr of VIDEO_DATA_ATTRS) {
          const val = el.getAttribute(attr);
          if (!val || val.startsWith("data:") || val.startsWith("#")) continue;

          let url;
          try {
            url = new URL(val, window.location.href).href;
          } catch {
            continue;
          }

          if (this._detectedUrls.has(url)) continue;
          if (
            !/\.(m3u8|mpd|mp4|webm|mov|mkv|flv|ts|mp3|aac|ogg|opus)(\?|$)/i.test(
              url,
            ) &&
            !/^https?:\/\//.test(val)
          )
            continue;

          this._detectedUrls.add(url);
          const mime = this._guessMimeFromUrl(url);
          const isM3u8 = /\.m3u8(\?|$)/i.test(url);
          const isMpd = /\.mpd(\?|$)/i.test(url);

          formats.push(
            this.buildFormat({
              url,
              mimeType: isM3u8
                ? "application/x-mpegurl"
                : isMpd
                  ? "application/dash+xml"
                  : mime,
              quality: `Data Attr (${attr})`,
              qualityLabel: `Data Attribute: ${attr}`,
              isVideo: !url.match(/\.(mp3|aac|ogg|opus|wav|flac)(\?|$)/i),
              isMuxed: true,
              ext: isM3u8 ? "m3u8" : isMpd ? "mpd" : this.guessExtension(mime),
              hasAudio: isM3u8 || isMpd,
            }),
          );
        }
      }

      // Also scan data-setup / data-config for JSON configs with video URLs
      for (const el of document.querySelectorAll(
        "[data-setup], [data-config], [data-options], [data-player-config]",
      )) {
        for (const attr of [
          "data-setup",
          "data-config",
          "data-options",
          "data-player-config",
        ]) {
          const val = el.getAttribute(attr);
          if (!val || val.length < 10) continue;
          try {
            const config = JSON.parse(val);
            const jsonStr = JSON.stringify(config);
            this._extractUrlsFromJSON(jsonStr, `DataAttr:${attr}`, formats);
          } catch {
            // Try extracting URLs from the raw string
            this._extractUrlsFromJSON(val, `DataAttr:${attr}`, formats);
          }
        }
      }
    } catch (e) {
      console.debug(this.TAG, "Data attribute scan error:", e.message);
    }

    if (formats.length > 0) {
      console.log(
        this.TAG,
        `Data attribute scan found ${formats.length} formats`,
      );
      this.sendToBackground({
        videoId: this._generateId(),
        formats,
        formatSource: "generic_data_attrs",
        title: document.title,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Preload/Prefetch Link Scanner
  // ═══════════════════════════════════════════════════════════════════════
  _scanPreloadLinks() {
    const formats = [];

    try {
      // <link rel="preload" as="video|audio|fetch" href="...">
      const preloadLinks = document.querySelectorAll(
        'link[rel="preload"][as="video"], link[rel="preload"][as="audio"], ' +
          'link[rel="preload"][as="fetch"], link[rel="prefetch"], ' +
          'link[rel="preload"][href*=".m3u8"], link[rel="preload"][href*=".mpd"], ' +
          'link[rel="preload"][href*=".mp4"], link[rel="preload"][href*=".webm"]',
      );

      for (const link of preloadLinks) {
        const url = link.href;
        if (!url || this._detectedUrls.has(url)) continue;
        if (
          !/\.(m3u8|mpd|mp4|webm|mov|mkv|flv|ts|mp3|aac|ogg|opus|wav)(\?|$)/i.test(
            url,
          )
        ) {
          // Check if `as` attribute suggests media
          const asType = link.getAttribute("as");
          if (asType !== "video" && asType !== "audio") continue;
        }

        this._detectedUrls.add(url);
        const mime = link.type || this._guessMimeFromUrl(url);
        formats.push(
          this.buildFormat({
            url,
            mimeType: mime,
            quality: "Preloaded",
            qualityLabel: `Preloaded Resource (${link.getAttribute("as") || "media"})`,
            isVideo: !/\.(mp3|aac|ogg|opus|wav|flac)(\?|$)/i.test(url),
            isMuxed: true,
            ext: this.guessExtension(mime),
          }),
        );
      }
    } catch (e) {
      console.debug(this.TAG, "Preload link scan error:", e.message);
    }

    if (formats.length > 0) {
      this.sendToBackground({
        videoId: this._generateId(),
        formats,
        formatSource: "generic_preload",
        title: document.title,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Subtitle/Track Scanner
  // ═══════════════════════════════════════════════════════════════════════
  _scanSubtitles() {
    try {
      const tracks = document.querySelectorAll("track[src]");
      const subtitles = [];

      for (const track of tracks) {
        const src = track.src;
        if (!src || this._subtitleUrls.has(src)) continue;
        this._subtitleUrls.add(src);

        let url;
        try {
          url = new URL(src, window.location.href).href;
        } catch {
          continue;
        }

        subtitles.push({
          url,
          language: track.srclang || track.getAttribute("lang") || "unknown",
          label: track.label || track.srclang || "Subtitle",
          kind: track.kind || "subtitles",
          isDefault: track.default || false,
        });
      }

      // Also look for subtitle URLs in script tags
      for (const script of document.querySelectorAll("script:not([src])")) {
        const text = script.textContent;
        if (!text || text.length < 20) continue;

        const srtMatches = text.matchAll(
          /(https?:\/\/[^\s"'<>]+\.(?:srt|vtt|ass|ssa|sub|ttml)(?:\?[^\s"'<>]*)?)/gi,
        );
        for (const m of srtMatches) {
          const url = m[1];
          if (this._subtitleUrls.has(url)) continue;
          this._subtitleUrls.add(url);
          subtitles.push({
            url,
            language: "unknown",
            label: "Subtitle",
            kind: "subtitles",
          });
        }
      }

      if (subtitles.length > 0) {
        this._detectedSubtitles = subtitles;
        console.log(this.TAG, `Found ${subtitles.length} subtitle tracks`);
      }
    } catch (e) {
      console.debug(this.TAG, "Subtitle scan error:", e.message);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Object/Embed Tag Scanner
  // ═══════════════════════════════════════════════════════════════════════
  _scanObjectEmbeds() {
    const formats = [];

    try {
      for (const el of document.querySelectorAll("object[data], embed[src]")) {
        const src = el.getAttribute("data") || el.getAttribute("src");
        if (!src || src.startsWith("data:")) continue;

        let url;
        try {
          url = new URL(src, window.location.href).href;
        } catch {
          continue;
        }

        if (this._detectedUrls.has(url)) continue;

        // Check if it's a video embed
        const type = el.getAttribute("type") || "";
        if (
          /video|flash|x-shockwave|mpegurl|dash/i.test(type) ||
          /\.(mp4|webm|flv|swf|m3u8|mpd)(\?|$)/i.test(url)
        ) {
          this._detectedUrls.add(url);
          const mime = type || this._guessMimeFromUrl(url);
          formats.push(
            this.buildFormat({
              url,
              mimeType: mime,
              quality: el.tagName === "OBJECT" ? "Object Embed" : "Embed",
              qualityLabel: `${el.tagName} Element`,
              isVideo: true,
              isMuxed: true,
              ext: this.guessExtension(mime),
            }),
          );
        }

        // Check flashvars for video URLs
        const flashvars = el.getAttribute("flashvars") || "";
        if (flashvars) {
          const videoParam = flashvars.match(/(?:file|video|src|url)=([^&]+)/i);
          if (videoParam) {
            const vidUrl = decodeURIComponent(videoParam[1]);
            if (
              /^https?:\/\//.test(vidUrl) &&
              !this._detectedUrls.has(vidUrl)
            ) {
              this._detectedUrls.add(vidUrl);
              formats.push(
                this.buildFormat({
                  url: vidUrl,
                  mimeType: this._guessMimeFromUrl(vidUrl),
                  quality: "FlashVars",
                  qualityLabel: "FlashVars Video URL",
                  isVideo: true,
                  isMuxed: true,
                  ext: this.guessExtension(this._guessMimeFromUrl(vidUrl)),
                }),
              );
            }
          }
        }
      }

      // Also scan <param> tags inside <object>
      for (const param of document.querySelectorAll("object param")) {
        const name = (param.getAttribute("name") || "").toLowerCase();
        const value = param.getAttribute("value") || "";
        if (
          (name === "src" ||
            name === "movie" ||
            name === "url" ||
            name === "file") &&
          /^https?:\/\//.test(value) &&
          !this._detectedUrls.has(value)
        ) {
          if (/\.(mp4|webm|flv|m3u8|mpd|mov|swf)(\?|$)/i.test(value)) {
            this._detectedUrls.add(value);
            formats.push(
              this.buildFormat({
                url: value,
                mimeType: this._guessMimeFromUrl(value),
                quality: "Object Param",
                qualityLabel: `Object Param: ${name}`,
                isVideo: true,
                isMuxed: true,
                ext: this.guessExtension(this._guessMimeFromUrl(value)),
              }),
            );
          }
        }
      }
    } catch (e) {
      console.debug(this.TAG, "Object/Embed scan error:", e.message);
    }

    if (formats.length > 0) {
      this.sendToBackground({
        videoId: this._generateId(),
        formats,
        formatSource: "generic_object_embed",
        title: document.title,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Canvas Video Detection — detects video being painted to canvas
  // ═══════════════════════════════════════════════════════════════════════
  _scanCanvasElements() {
    try {
      const canvases = document.querySelectorAll("canvas");
      for (const canvas of canvases) {
        // Large canvases in the viewport are likely video renderers
        if (canvas.width >= 320 && canvas.height >= 180) {
          const rect = canvas.getBoundingClientRect();
          if (rect.width > 200 && rect.height > 100) {
            // Check parent for associated video elements
            const parent = canvas.closest(
              "[class*=player], [class*=video], [id*=player], [id*=video]",
            );
            if (parent) {
              const video = parent.querySelector("video");
              if (video) {
                const vf = this._extractFromVideoEl(video);
                for (const f of vf) {
                  f.qualityLabel = "Canvas Renderer: " + (f.qualityLabel || "");
                }
                if (vf.length > 0 && !this._canvasDetected) {
                  this._canvasDetected = true;
                  this.sendToBackground({
                    videoId: this._generateId(),
                    formats: vf,
                    formatSource: "generic_canvas",
                    title: document.title,
                  });
                }
              }
            }
          }
        }
      }
    } catch (e) {
      console.debug(this.TAG, "Canvas scan error:", e.message);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // JavaScript Global Variable Probing
  // ═══════════════════════════════════════════════════════════════════════
  _scanJSGlobals() {
    if (this._jsGlobalsScanned) return;
    this._jsGlobalsScanned = true;

    const formats = [];

    // Common player/config global variable names
    const GLOBAL_VARS = [
      "player",
      "videoPlayer",
      "jwplayer",
      "flowplayer",
      "bitmovinPlayer",
      "shaka",
      "hlsPlayer",
      "dashPlayer",
      "plyr",
      "videojs",
      "videoConfig",
      "playerConfig",
      "mediaConfig",
      "streamConfig",
      "videoData",
      "mediaData",
      "streamData",
      "playbackData",
      "videoUrl",
      "videoSrc",
      "streamUrl",
      "mediaUrl",
      "VIDEO_URL",
      "VIDEO_SRC",
      "STREAM_URL",
      "MEDIA_URL",
      "manifest_url",
      "video_manifest",
      "hls_url",
      "dash_url",
      "embedData",
      "embedConfig",
      "playerData",
      "vidInfo",
      "movieData",
      "clipData",
      "episodeData",
      "_playerConfig",
      "_videoConfig",
      "_streamConfig",
    ];

    for (const varName of GLOBAL_VARS) {
      try {
        const val = window[varName];
        if (!val) continue;

        if (typeof val === "string" && /^https?:\/\//.test(val)) {
          if (
            /\.(m3u8|mpd|mp4|webm|mov|flv|mkv)(\?|$)/i.test(val) &&
            !this._detectedUrls.has(val)
          ) {
            this._detectedUrls.add(val);
            const mime = this._guessMimeFromUrl(val);
            formats.push(
              this.buildFormat({
                url: val,
                mimeType: mime,
                quality: `Global: ${varName}`,
                qualityLabel: `window.${varName}`,
                isVideo: true,
                isMuxed: true,
                ext: this.guessExtension(mime),
              }),
            );
          }
        } else if (typeof val === "object") {
          const json = JSON.stringify(val);
          if (json && json.length < 500000) {
            this._extractUrlsFromJSON(json, `window.${varName}`, formats);
          }
        }
      } catch (e) {
        // Cannot access — cross-origin or getter threw
      }
    }

    // Probe for dynamically-named player instances on window (pattern: window.*player*)
    try {
      const ownKeys = Object.getOwnPropertyNames(window);
      for (const key of ownKeys) {
        if (GLOBAL_VARS.includes(key)) continue; // Already checked
        const lk = key.toLowerCase();
        if (
          !(
            lk.includes("player") ||
            lk.includes("video") ||
            lk.includes("stream") ||
            lk.includes("media") ||
            lk.includes("hls") ||
            lk.includes("dash")
          )
        )
          continue;
        // Skip built-in / DOM properties
        if (/^(on|webkit|moz|ms|chrome|__)/i.test(key)) continue;

        try {
          const val = window[key];
          if (!val || typeof val !== "object") continue;

          // Check for .url, .src, .source, .sources, .config properties
          const url =
            val.url ||
            val.src ||
            val.source ||
            val.file ||
            val.config?.url ||
            val.config?.src ||
            val.config?.source ||
            val.sources?.[0]?.src ||
            val.sources?.[0]?.file;
          if (
            typeof url === "string" &&
            /^https?:\/\//.test(url) &&
            /\.(m3u8|mpd|mp4|webm|mov|flv)(\?|$)/i.test(url) &&
            !this._detectedUrls.has(url)
          ) {
            this._detectedUrls.add(url);
            const mime = this._guessMimeFromUrl(url);
            formats.push(
              this.buildFormat({
                url,
                mimeType: mime,
                quality: `Global: ${key}`,
                qualityLabel: `window.${key} player instance`,
                isVideo: true,
                isMuxed: true,
                ext: this.guessExtension(mime),
              }),
            );
          }
        } catch {}
      }
    } catch {}

    if (formats.length > 0) {
      console.log(this.TAG, `JS global scan found ${formats.length} formats`);
      this.sendToBackground({
        videoId: this._generateId(),
        formats,
        formatSource: "generic_js_globals",
        title: document.title,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Custom Web Component Scanner
  // ═══════════════════════════════════════════════════════════════════════
  _scanCustomElements() {
    if (this._customElementsScanned) return;
    this._customElementsScanned = true;

    const formats = [];

    try {
      // Look for custom elements with video-related tag names
      const customSelectors = [
        "video-player",
        "media-player",
        "hls-player",
        "dash-player",
        "amp-video",
        "amp-iframe",
        "mux-player",
        "mux-video",
        "vidstack-player",
        "lite-youtube",
        "lite-vimeo",
        "stream-player",
        "bitmovin-player",
        "theo-player",
        "shaka-player",
        "clappr-player",
        "media-chrome",
        "[is=video-player]",
        "[is=media-player]",
      ];

      for (const sel of customSelectors) {
        try {
          const elements = document.querySelectorAll(sel);
          for (const el of elements) {
            // Check shadowRoot
            if (el.shadowRoot) {
              const videos = el.shadowRoot.querySelectorAll("video, source");
              for (const v of videos) {
                const src = v.src || v.getAttribute("src");
                if (
                  src &&
                  !this._detectedUrls.has(src) &&
                  /^https?:\/\//.test(src)
                ) {
                  this._detectedUrls.add(src);
                  const mime = this._guessMimeFromUrl(src);
                  formats.push(
                    this.buildFormat({
                      url: src,
                      mimeType: mime,
                      quality: `WebComponent: ${el.tagName.toLowerCase()}`,
                      qualityLabel: `Web Component: ${el.tagName.toLowerCase()}`,
                      isVideo: true,
                      isMuxed: true,
                      ext: this.guessExtension(mime),
                    }),
                  );
                }
              }
            }

            // Check attributes
            const src =
              el.getAttribute("src") ||
              el.getAttribute("source") ||
              el.getAttribute("video-src") ||
              el.getAttribute("stream-url") ||
              el.getAttribute("playback-id") ||
              el.getAttribute("video-id");
            if (
              src &&
              /^https?:\/\//.test(src) &&
              !this._detectedUrls.has(src)
            ) {
              this._detectedUrls.add(src);
              const mime = this._guessMimeFromUrl(src);
              formats.push(
                this.buildFormat({
                  url: src,
                  mimeType: mime,
                  quality: `WebComponent: ${el.tagName.toLowerCase()}`,
                  qualityLabel: `Web Component: ${el.tagName.toLowerCase()}`,
                  isVideo: true,
                  isMuxed: true,
                  ext: this.guessExtension(mime),
                }),
              );
            }

            // Special handling for amp-video
            if (el.tagName === "AMP-VIDEO" || el.tagName === "AMP-IFRAME") {
              const ampSrc =
                el.getAttribute("src") || el.querySelector("source")?.src;
              if (ampSrc && !this._detectedUrls.has(ampSrc)) {
                this._detectedUrls.add(ampSrc);
                formats.push(
                  this.buildFormat({
                    url: ampSrc,
                    mimeType: this._guessMimeFromUrl(ampSrc),
                    quality: "AMP Video",
                    qualityLabel: `AMP Video Element`,
                    isVideo: true,
                    isMuxed: true,
                    ext: this.guessExtension(this._guessMimeFromUrl(ampSrc)),
                  }),
                );
              }
            }

            // Special handling for mux-player / mux-video
            if (el.tagName === "MUX-PLAYER" || el.tagName === "MUX-VIDEO") {
              const playbackId = el.getAttribute("playback-id");
              if (playbackId) {
                const muxUrl = `https://stream.mux.com/${playbackId}.m3u8`;
                if (!this._detectedUrls.has(muxUrl)) {
                  this._detectedUrls.add(muxUrl);
                  formats.push(
                    this.buildFormat({
                      url: muxUrl,
                      mimeType: "application/x-mpegurl",
                      quality: "MUX HLS",
                      qualityLabel: `MUX Player Stream`,
                      isVideo: true,
                      isMuxed: true,
                      ext: "m3u8",
                      hasAudio: true,
                    }),
                  );
                }
              }
            }

            // lite-youtube custom element
            if (el.tagName === "LITE-YOUTUBE") {
              const videoId = el.getAttribute("videoid");
              if (videoId) {
                const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;
                if (!this._detectedUrls.has(ytUrl)) {
                  this._detectedUrls.add(ytUrl);
                  formats.push(
                    this.buildFormat({
                      url: ytUrl,
                      mimeType: "text/html",
                      quality: "YouTube Embed",
                      qualityLabel: "Lite YouTube Embed",
                      isVideo: true,
                      isMuxed: true,
                      ext: "embed",
                      embedType: "youtube",
                    }),
                  );
                }
              }
            }
          }
        } catch {}
      }
    } catch (e) {
      console.debug(this.TAG, "Custom element scan error:", e.message);
    }

    if (formats.length > 0) {
      this.sendToBackground({
        videoId: this._generateId(),
        formats,
        formatSource: "generic_web_components",
        title: document.title,
      });
    }
  }

  _scanWebComponents() {
    // Deeper scan: iterate ALL custom elements in the DOM
    try {
      const formats = [];
      const allEls = document.querySelectorAll("*");
      for (const el of allEls) {
        // Custom elements have a hyphen in their tag name
        if (!el.tagName.includes("-")) continue;
        if (!el.shadowRoot) continue;

        const videos = el.shadowRoot.querySelectorAll("video");
        for (const video of videos) {
          const vf = this._extractFromVideoEl(video);
          for (const f of vf) {
            f.qualityLabel = `WC(${el.tagName.toLowerCase()}): ${f.qualityLabel || ""}`;
            formats.push(f);
          }
        }

        const audios = el.shadowRoot.querySelectorAll("audio");
        for (const audio of audios) {
          const af = this._extractFromAudioEl(audio);
          for (const f of af) {
            f.qualityLabel = `WC(${el.tagName.toLowerCase()}): ${f.qualityLabel || ""}`;
            formats.push(f);
          }
        }
      }

      if (formats.length > 0) {
        this.sendToBackground({
          videoId: this._generateId(),
          formats,
          formatSource: "generic_deep_web_components",
          title: document.title,
        });
      }
    } catch (e) {
      console.debug(this.TAG, "Deep web component scan error:", e.message);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Lazy Video Detection — IntersectionObserver for lazy-loaded videos
  // ═══════════════════════════════════════════════════════════════════════
  _initLazyVideoDetection() {
    try {
      if (!window.IntersectionObserver) return;

      this._lazyVideoObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const el = entry.target;

            if (el.tagName === "VIDEO" || el.tagName === "AUDIO") {
              // Element may now have a src set by lazy-loading scripts
              setTimeout(() => {
                const vf =
                  el.tagName === "VIDEO"
                    ? this._extractFromVideoEl(el)
                    : this._extractFromAudioEl(el);
                if (vf.length > 0) {
                  this.sendToBackground({
                    videoId: this._generateId(),
                    formats: vf,
                    formatSource: "generic_lazy_loaded",
                    title: document.title,
                  });
                }
              }, 500);
            }

            if (el.tagName === "IFRAME") {
              // Iframe came into view — it may now have loaded a player
              const src = el.src;
              if (src && /player|embed|video|stream|m3u8|mpd/i.test(src)) {
                this._addPlayerUrl(src, "Lazy Iframe", []);
              }
            }
          }
        },
        { rootMargin: "200px", threshold: 0.01 },
      );

      // Observe existing and future media elements
      const observe = (el) => {
        try {
          this._lazyVideoObserver.observe(el);
        } catch {}
      };
      document.querySelectorAll("video, audio, iframe").forEach(observe);

      this.observe(
        document.body || document.documentElement,
        { childList: true, subtree: true },
        (mutations) => {
          for (const m of mutations) {
            for (const node of m.addedNodes) {
              if (node.nodeType !== 1) continue;
              if (
                node.tagName === "VIDEO" ||
                node.tagName === "AUDIO" ||
                node.tagName === "IFRAME"
              ) {
                observe(node);
              }
              if (node.querySelectorAll) {
                node.querySelectorAll("video, audio, iframe").forEach(observe);
              }
            }
          }
        },
      );
    } catch (e) {
      console.debug(this.TAG, "Lazy video detection error:", e.message);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // navigator.mediaSession Metadata Extraction
  // ═══════════════════════════════════════════════════════════════════════
  _extractMediaSessionMetadata() {
    try {
      if (!("mediaSession" in navigator)) return;
      const meta = navigator.mediaSession.metadata;
      if (!meta) return;

      console.log(this.TAG, "MediaSession metadata:", {
        title: meta.title,
        artist: meta.artist,
        album: meta.album,
        artwork: meta.artwork?.length || 0,
      });

      // MediaSession doesn't directly expose URLs, but we can get the biggest artwork
      if (meta.artwork && meta.artwork.length > 0) {
        let biggest = meta.artwork[0];
        for (const art of meta.artwork) {
          const size = parseInt(art.sizes?.split("x")?.[0]) || 0;
          const biggestSize = parseInt(biggest.sizes?.split("x")?.[0]) || 0;
          if (size > biggestSize) biggest = art;
        }

        if (biggest.src && !this._detectedUrls.has(biggest.src)) {
          this._detectedUrls.add(biggest.src);
          this.sendToBackground({
            videoId: this._generateId(),
            formats: [
              this.buildFormat({
                url: biggest.src,
                mimeType: biggest.type || "image/*",
                quality: `Artwork ${biggest.sizes || ""}`,
                qualityLabel: `MediaSession Artwork: ${meta.title || ""}`,
                isVideo: false,
                isImage: true,
                isMuxed: false,
                ext: this._guessImageExt(biggest.src),
              }),
            ],
            formatSource: "generic_media_session",
            title: meta.title || document.title,
          });
        }
      }
    } catch (e) {
      console.debug(this.TAG, "MediaSession scan error:", e.message);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Obfuscated URL Detection — base64, hex, rot13, URL-encoded
  // ═══════════════════════════════════════════════════════════════════════
  _scanObfuscatedUrls() {
    const formats = [];

    try {
      for (const script of document.querySelectorAll("script:not([src])")) {
        const text = script.textContent;
        if (!text || text.length < 50 || text.length > 500000) continue;

        // Base64 encoded URLs (common obfuscation pattern)
        // Look for atob("...") or base64 decode patterns
        const base64Matches = text.matchAll(
          /atob\s*\(\s*["']([A-Za-z0-9+/=]+)["']\s*\)/g,
        );
        for (const m of base64Matches) {
          try {
            const decoded = atob(m[1]);
            if (
              /^https?:\/\//.test(decoded) &&
              /\.(m3u8|mpd|mp4|webm|mov|flv)(\?|$)/i.test(decoded) &&
              !this._detectedUrls.has(decoded)
            ) {
              this._detectedUrls.add(decoded);
              const mime = this._guessMimeFromUrl(decoded);
              formats.push(
                this.buildFormat({
                  url: decoded,
                  mimeType: mime,
                  quality: "Decoded (base64)",
                  qualityLabel: "Base64 Decoded Video",
                  isVideo: true,
                  isMuxed: true,
                  ext: this.guessExtension(mime),
                }),
              );
            }
          } catch {}
        }

        // Hex-encoded URLs (hex string → URL)
        const hexMatches = text.matchAll(
          /(?:fromCharCode|toString)\s*\([^)]*\)|["']((?:68747470|\\x68\\x74\\x74\\x70)[0-9a-fA-F\\x]+)["']/g,
        );
        for (const m of hexMatches) {
          try {
            if (m[1]) {
              const decoded = m[1].replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) =>
                String.fromCharCode(parseInt(hex, 16)),
              );
              if (
                /^https?:\/\//.test(decoded) &&
                /\.(m3u8|mpd|mp4|webm)(\?|$)/i.test(decoded)
              ) {
                if (!this._detectedUrls.has(decoded)) {
                  this._detectedUrls.add(decoded);
                  formats.push(
                    this.buildFormat({
                      url: decoded,
                      mimeType: this._guessMimeFromUrl(decoded),
                      quality: "Decoded (hex)",
                      qualityLabel: "Hex Decoded Video",
                      isVideo: true,
                      isMuxed: true,
                      ext: this.guessExtension(this._guessMimeFromUrl(decoded)),
                    }),
                  );
                }
              }
            }
          } catch {}
        }

        // URL-encoded video URLs
        const encodedMatches = text.matchAll(
          /(?:decodeURIComponent|unescape)\s*\(\s*["'](%(?:68|48)(?:74|54)(?:74|54)(?:70|50)[^"']+)["']\s*\)/g,
        );
        for (const m of encodedMatches) {
          try {
            const decoded = decodeURIComponent(m[1]);
            if (
              /^https?:\/\//.test(decoded) &&
              /\.(m3u8|mpd|mp4|webm)(\?|$)/i.test(decoded)
            ) {
              if (!this._detectedUrls.has(decoded)) {
                this._detectedUrls.add(decoded);
                formats.push(
                  this.buildFormat({
                    url: decoded,
                    mimeType: this._guessMimeFromUrl(decoded),
                    quality: "Decoded (URL-encoded)",
                    qualityLabel: "URL-Decoded Video",
                    isVideo: true,
                    isMuxed: true,
                    ext: this.guessExtension(this._guessMimeFromUrl(decoded)),
                  }),
                );
              }
            }
          } catch {}
        }

        // Reversed URLs (common obfuscation)
        const reverseMatches = text.matchAll(
          /\.reverse\(\)\.join\(\s*["']?\s*["']?\s*\)/g,
        );
        if (reverseMatches) {
          // Look for array patterns near .reverse()
          const arrayMatches = text.matchAll(
            /\[([^\]]{20,500})\]\.reverse\(\)\.join\(\s*["']?\s*["']?\s*\)/g,
          );
          for (const m of arrayMatches) {
            try {
              const arr = JSON.parse(`[${m[1]}]`);
              const joined = arr.reverse().join("");
              if (
                /^https?:\/\//.test(joined) &&
                /\.(m3u8|mpd|mp4|webm)(\?|$)/i.test(joined)
              ) {
                if (!this._detectedUrls.has(joined)) {
                  this._detectedUrls.add(joined);
                  formats.push(
                    this.buildFormat({
                      url: joined,
                      mimeType: this._guessMimeFromUrl(joined),
                      quality: "Decoded (reversed)",
                      qualityLabel: "Reversed URL Decoded Video",
                      isVideo: true,
                      isMuxed: true,
                      ext: this.guessExtension(this._guessMimeFromUrl(joined)),
                    }),
                  );
                }
              }
            } catch {}
          }
        }
      }
    } catch (e) {
      console.debug(this.TAG, "Obfuscated URL scan error:", e.message);
    }

    if (formats.length > 0) {
      console.log(this.TAG, `Obfuscation scan found ${formats.length} formats`);
      this.sendToBackground({
        videoId: this._generateId(),
        formats,
        formatSource: "generic_deobfuscated",
        title: document.title,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CDN Pattern Detection — Known video CDN URL patterns
  // ═══════════════════════════════════════════════════════════════════════
  _scanCDNPatterns() {
    const formats = [];

    try {
      const html = document.documentElement.outerHTML;
      if (html.length > 5000000) return; // Skip huge pages

      // CDN patterns that almost always serve video
      const CDN_PATTERNS = [
        // Cloudflare Stream
        {
          regex:
            /https?:\/\/(?:customer-[a-z0-9]+\.)?cloudflarestream\.com\/[a-zA-Z0-9]+\/manifest\/video\.m3u8[^"'\s<>]*/gi,
          name: "Cloudflare Stream",
        },
        {
          regex:
            /https?:\/\/videodelivery\.net\/[a-zA-Z0-9]+\/manifest\/video\.m3u8[^"'\s<>]*/gi,
          name: "CF Delivery",
        },
        // Bunny CDN
        {
          regex:
            /https?:\/\/[^"'\s<>]*\.b-cdn\.net\/[^"'\s<>]*(?:\.m3u8|\.mp4)[^"'\s<>]*/gi,
          name: "Bunny CDN",
        },
        // AWS CloudFront
        {
          regex:
            /https?:\/\/[a-z0-9]+\.cloudfront\.net\/[^"'\s<>]*(?:\.m3u8|\.mpd|\.mp4)[^"'\s<>]*/gi,
          name: "CloudFront",
        },
        // Fastly
        {
          regex:
            /https?:\/\/[^"'\s<>]*\.fastly(?:cdn)?\.(?:net|com)\/[^"'\s<>]*(?:\.m3u8|\.mp4)[^"'\s<>]*/gi,
          name: "Fastly",
        },
        // Azure Media Services
        {
          regex:
            /https?:\/\/[^"'\s<>]*\.streaming\.media\.azure\.net\/[^"'\s<>]*/gi,
          name: "Azure Media",
        },
        {
          regex:
            /https?:\/\/[^"'\s<>]*\.azureedge\.net\/[^"'\s<>]*(?:\.m3u8|\.mpd|\.mp4)[^"'\s<>]*/gi,
          name: "Azure CDN",
        },
        // Google Cloud CDN / YouTube CDN
        {
          regex: /https?:\/\/[^"'\s<>]*\.googlevideo\.com\/[^"'\s<>]*/gi,
          name: "Google Video",
        },
        // Akamai
        {
          regex:
            /https?:\/\/[^"'\s<>]*\.akamaihd\.net\/[^"'\s<>]*(?:\.m3u8|\.mpd|\.mp4)[^"'\s<>]*/gi,
          name: "Akamai",
        },
        {
          regex:
            /https?:\/\/[^"'\s<>]*\.akamaized\.net\/[^"'\s<>]*(?:\.m3u8|\.mpd|\.mp4)[^"'\s<>]*/gi,
          name: "Akamaized",
        },
        // JW Platform
        {
          regex: /https?:\/\/cdn\.jwplayer\.com\/manifests\/[^"'\s<>]*/gi,
          name: "JW Platform",
        },
        {
          regex:
            /https?:\/\/content\.jwplatform\.com\/[^"'\s<>]*(?:\.m3u8|\.mp4)[^"'\s<>]*/gi,
          name: "JW Content",
        },
        // Brightcove
        {
          regex: /https?:\/\/[^"'\s<>]*\.brightcovecdn\.com\/[^"'\s<>]*/gi,
          name: "Brightcove CDN",
        },
        // Wistia
        {
          regex:
            /https?:\/\/[^"'\s<>]*\.wistia\.(?:com|net)\/[^"'\s<>]*(?:\.m3u8|\.mp4|\.bin)[^"'\s<>]*/gi,
          name: "Wistia",
        },
        // Vimeo CDN
        {
          regex:
            /https?:\/\/[^"'\s<>]*vimeocdn\.com\/[^"'\s<>]*(?:\.m3u8|\.mp4)[^"'\s<>]*/gi,
          name: "Vimeo CDN",
        },
        // MUX
        {
          regex: /https?:\/\/stream\.mux\.com\/[a-zA-Z0-9]+\.m3u8[^"'\s<>]*/gi,
          name: "MUX",
        },
        // Generic CDN patterns
        {
          regex:
            /https?:\/\/[^"'\s<>]*(?:media|video|stream|content|cdn)[^"'\s<>]*\/[^"'\s<>]*(?:master|index|playlist)\.m3u8[^"'\s<>]*/gi,
          name: "HLS CDN",
        },
      ];

      for (const { regex, name } of CDN_PATTERNS) {
        const matches = html.matchAll(regex);
        for (const match of matches) {
          let url = match[0];
          // Clean trailing chars
          url = url.replace(/['"<>\s;,)}\]]+$/, "");
          if (!url || this._detectedUrls.has(url)) continue;
          if (/thumb|poster|preview|sprite|logo|icon/i.test(url)) continue;

          this._detectedUrls.add(url);
          const mime = this._guessMimeFromUrl(url);
          const isM3u8 = /\.m3u8(\?|$)/i.test(url);
          const isMpd = /\.mpd(\?|$)/i.test(url);

          formats.push(
            this.buildFormat({
              url,
              mimeType: isM3u8
                ? "application/x-mpegurl"
                : isMpd
                  ? "application/dash+xml"
                  : mime,
              quality: `CDN: ${name}`,
              qualityLabel: `${name} CDN`,
              isVideo: true,
              isMuxed: true,
              ext: isM3u8 ? "m3u8" : isMpd ? "mpd" : this.guessExtension(mime),
              hasAudio: isM3u8 || isMpd,
            }),
          );
        }
      }
    } catch (e) {
      console.debug(this.TAG, "CDN pattern scan error:", e.message);
    }

    if (formats.length > 0) {
      console.log(this.TAG, `CDN scan found ${formats.length} formats`);
      this.sendToBackground({
        videoId: this._generateId(),
        formats,
        formatSource: "generic_cdn",
        title: document.title,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SPA Navigation Handling
  // ═══════════════════════════════════════════════════════════════════════
  _setupSPANavigation() {
    const checkNavigation = () => {
      const currentHref = window.location.href;
      if (currentHref !== this._lastHref) {
        console.log(
          this.TAG,
          "SPA navigation detected:",
          currentHref.substring(0, 80),
        );
        this._lastHref = currentHref;
        this._navGeneration++;
        this._resetDetectionState();
      }
    };

    this.listen(window, "popstate", checkNavigation);
    this.listen(window, "hashchange", checkNavigation);

    // Also intercept pushState/replaceState
    this.listen(window, "message", (e) => {
      if (e.data?.type === "__generic_spa_navigation__") {
        checkNavigation();
      }
    });

    // Periodic URL check (catches all SPA frameworks)
    this.interval(checkNavigation, 2000);
  }

  _resetDetectionState() {
    // Keep _detectedUrls but allow re-scanning methods to run
    this._ssrDataScanned = false;
    this._dataAttrsScanned = false;
    this._performanceScanned = false;
    this._jsGlobalsScanned = false;
    this._customElementsScanned = false;
    this._canvasDetected = false;

    // Re-run key detection phases
    this.timer(() => this._scanDOM(), 500);
    this.timer(() => this._scanSSRFrameworkData(), 800);
    this.timer(() => this._scanPageSource(), 1000);
    this.timer(() => this._scanMetaTags(), 1000);
    this.timer(() => this._scanDataAttributes(), 1200);
    this.timer(() => this._scanMicrodata(), 1200);
    this.timer(() => this._scanDownloadLinks(), 1200);
    this.timer(() => this._scanJSGlobals(), 1500);
    this.timer(() => this._scanNoscript(), 1500);
    this.timer(() => this._scanWebStorage(), 2000);
    this.timer(() => this._scanPlayers(), 2000);
    this.timer(() => this._scanEmbeds(), 2500);
    this.timer(() => this._scanPerformanceResources(), 3000);
    this.timer(() => this._scanCDNPatterns(), 2000);
    this.timer(() => this._scanHTMLComments(), 3000);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Periodic Re-scan — catches dynamically loaded content
  // ═══════════════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════════
  // Schema.org Microdata Scanner (itemtype=VideoObject, itemprop=contentUrl)
  // ═══════════════════════════════════════════════════════════════════════
  _scanMicrodata() {
    const formats = [];

    try {
      // Schema.org VideoObject via microdata attributes
      const videoObjects = document.querySelectorAll(
        '[itemtype*="VideoObject"], [itemtype*="Movie"], [itemtype*="Episode"], [itemtype*="MediaObject"]',
      );

      for (const obj of videoObjects) {
        // contentUrl
        const contentUrl = obj.querySelector('[itemprop="contentUrl"]');
        if (contentUrl) {
          const url =
            contentUrl.getAttribute("content") ||
            contentUrl.getAttribute("href") ||
            contentUrl.getAttribute("src");
          if (url && /^https?:\/\//.test(url) && !this._detectedUrls.has(url)) {
            this._detectedUrls.add(url);
            const mime = this._guessMimeFromUrl(url);
            formats.push(
              this.buildFormat({
                url,
                mimeType: mime,
                quality: "Microdata",
                qualityLabel: "Schema.org VideoObject",
                isVideo: true,
                isMuxed: true,
                ext: this.guessExtension(mime),
              }),
            );
          }
        }

        // embedUrl
        const embedUrl = obj.querySelector('[itemprop="embedUrl"]');
        if (embedUrl) {
          const url =
            embedUrl.getAttribute("content") ||
            embedUrl.getAttribute("href") ||
            embedUrl.getAttribute("src");
          if (url && /^https?:\/\//.test(url) && !this._detectedUrls.has(url)) {
            this._detectedUrls.add(url);
            formats.push(
              this.buildFormat({
                url,
                mimeType: "text/html",
                quality: "Microdata Embed",
                qualityLabel: "Schema.org Embed URL",
                isVideo: true,
                isMuxed: true,
                ext: "embed",
              }),
            );
          }
        }

        // thumbnailUrl as image
        const thumbUrl = obj.querySelector('[itemprop="thumbnailUrl"]');
        if (thumbUrl) {
          const url =
            thumbUrl.getAttribute("content") ||
            thumbUrl.getAttribute("href") ||
            thumbUrl.getAttribute("src");
          if (url && /^https?:\/\//.test(url) && !this._detectedUrls.has(url)) {
            this._detectedUrls.add(url);
            formats.push(
              this.buildFormat({
                url,
                mimeType: "image/*",
                quality: "Thumbnail",
                qualityLabel: "Schema.org Thumbnail",
                isVideo: false,
                isImage: true,
                isMuxed: false,
                ext: this._guessImageExt(url),
              }),
            );
          }
        }
      }

      // Also check RDFa-style video objects
      const rdfaVideos = document.querySelectorAll(
        '[typeof*="VideoObject"], [typeof*="Movie"]',
      );
      for (const obj of rdfaVideos) {
        const propEl = obj.querySelector(
          '[property="contentUrl"], [property="embedUrl"]',
        );
        if (propEl) {
          const url =
            propEl.getAttribute("content") || propEl.getAttribute("href");
          if (url && /^https?:\/\//.test(url) && !this._detectedUrls.has(url)) {
            this._detectedUrls.add(url);
            const mime = this._guessMimeFromUrl(url);
            formats.push(
              this.buildFormat({
                url,
                mimeType: mime,
                quality: "RDFa Video",
                qualityLabel: "RDFa VideoObject",
                isVideo: true,
                isMuxed: true,
                ext: this.guessExtension(mime),
              }),
            );
          }
        }
      }
    } catch (e) {
      console.debug(this.TAG, "Microdata scan error:", e.message);
    }

    if (formats.length > 0) {
      console.log(this.TAG, `Microdata scan found ${formats.length} formats`);
      this.sendToBackground({
        videoId: this._generateId(),
        formats,
        formatSource: "generic_microdata",
        title: document.title,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // <noscript> Fallback Scanner
  // ═══════════════════════════════════════════════════════════════════════
  _scanNoscript() {
    const formats = [];

    try {
      for (const noscript of document.querySelectorAll("noscript")) {
        const html = noscript.innerHTML || noscript.textContent || "";
        if (html.length < 20) continue;

        // Parse video/audio/iframe/source tags in noscript content
        const videoMatches = html.matchAll(
          /<(?:video|audio|source|iframe)[^>]+(?:src|data-src)=["']?(https?:\/\/[^"'\s>]+)["']?/gi,
        );
        for (const m of videoMatches) {
          const url = m[1];
          if (this._detectedUrls.has(url)) continue;
          if (
            /\.(m3u8|mpd|mp4|webm|mov|flv|mkv|ts|mp3|aac|ogg)(\?|$)/i.test(url)
          ) {
            this._detectedUrls.add(url);
            const mime = this._guessMimeFromUrl(url);
            formats.push(
              this.buildFormat({
                url,
                mimeType: mime,
                quality: "Noscript Fallback",
                qualityLabel: "Noscript Fallback Video",
                isVideo: true,
                isMuxed: true,
                ext: this.guessExtension(mime),
              }),
            );
          }
        }

        // Also check for direct video URLs in noscript text
        const urlMatches = html.matchAll(
          /(https?:\/\/[^\s"'<>]+\.(?:m3u8|mpd|mp4|webm)(?:\?[^\s"'<>]*)?)/gi,
        );
        for (const m of urlMatches) {
          const url = m[1];
          if (!this._detectedUrls.has(url)) {
            this._detectedUrls.add(url);
            const mime = this._guessMimeFromUrl(url);
            formats.push(
              this.buildFormat({
                url,
                mimeType: mime,
                quality: "Noscript",
                qualityLabel: "Noscript URL",
                isVideo: true,
                isMuxed: true,
                ext: this.guessExtension(mime),
              }),
            );
          }
        }
      }
    } catch (e) {
      console.debug(this.TAG, "Noscript scan error:", e.message);
    }

    if (formats.length > 0) {
      this.sendToBackground({
        videoId: this._generateId(),
        formats,
        formatSource: "generic_noscript",
        title: document.title,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // localStorage / sessionStorage Scanner — cached video config/URLs
  // ═══════════════════════════════════════════════════════════════════════
  _scanWebStorage() {
    const formats = [];

    try {
      for (const storage of [window.localStorage, window.sessionStorage]) {
        if (!storage) continue;
        for (let i = 0; i < storage.length && i < 200; i++) {
          try {
            const key = storage.key(i);
            if (!key) continue;
            // Only check keys that look video/media-related
            const lk = key.toLowerCase();
            if (
              !(
                lk.includes("video") ||
                lk.includes("player") ||
                lk.includes("stream") ||
                lk.includes("media") ||
                lk.includes("hls") ||
                lk.includes("dash") ||
                lk.includes("source") ||
                lk.includes("manifest") ||
                lk.includes("playback") ||
                lk.includes("m3u8") ||
                lk.includes("mpd")
              )
            )
              continue;

            const val = storage.getItem(key);
            if (!val || val.length < 10 || val.length > 500000) continue;

            // Check if the value itself is a URL
            if (
              /^https?:\/\//.test(val) &&
              /\.(m3u8|mpd|mp4|webm|mov|flv)(\?|$)/i.test(val)
            ) {
              if (!this._detectedUrls.has(val)) {
                this._detectedUrls.add(val);
                const mime = this._guessMimeFromUrl(val);
                formats.push(
                  this.buildFormat({
                    url: val,
                    mimeType: mime,
                    quality: `Storage: ${key.substring(0, 30)}`,
                    qualityLabel: `Web Storage (${key.substring(0, 30)})`,
                    isVideo: true,
                    isMuxed: true,
                    ext: this.guessExtension(mime),
                  }),
                );
              }
            } else {
              // Try to parse as JSON and extract URLs
              this._extractUrlsFromJSON(
                val,
                `Storage:${key.substring(0, 20)}`,
                formats,
              );
            }
          } catch {}
        }
      }
    } catch (e) {
      console.debug(this.TAG, "Web storage scan error:", e.message);
    }

    if (formats.length > 0) {
      console.log(this.TAG, `Web storage scan found ${formats.length} formats`);
      this.sendToBackground({
        videoId: this._generateId(),
        formats,
        formatSource: "generic_web_storage",
        title: document.title,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // RSS/Atom/Podcast Feed Scanner — detect video/audio feeds
  // ═══════════════════════════════════════════════════════════════════════
  _scanFeedLinks() {
    const formats = [];

    try {
      // Check for RSS/Atom feed autodiscovery links
      const feedLinks = document.querySelectorAll(
        'link[type="application/rss+xml"], link[type="application/atom+xml"], ' +
          'link[type="application/podcast+xml"], link[type="application/rss+xml; charset=utf-8"]',
      );

      for (const link of feedLinks) {
        const href = link.href;
        if (!href || this._detectedUrls.has(href)) continue;

        // Check if the feed title suggests media content
        const title = link.title || "";
        if (
          /video|podcast|media|episode|stream/i.test(title) ||
          feedLinks.length === 1
        ) {
          this._detectedUrls.add(href);
          formats.push(
            this.buildFormat({
              url: href,
              mimeType: link.type || "application/rss+xml",
              quality: "Feed",
              qualityLabel: `RSS/Atom Feed: ${title || "Media Feed"}`,
              isVideo: false,
              isMuxed: false,
              ext: "xml",
              isFeed: true,
            }),
          );
        }
      }

      // Look for podcast/media enclosure URLs in inline RSS data
      for (const script of document.querySelectorAll("script:not([src])")) {
        const text = script.textContent;
        if (!text || text.length < 50) continue;

        const enclosureMatches = text.matchAll(
          /enclosure[^>]*url=["'](https?:\/\/[^"']+\.(?:mp3|mp4|m4a|aac|ogg|opus|webm|m3u8)(?:\?[^"']*)?)["']/gi,
        );
        for (const m of enclosureMatches) {
          const url = m[1];
          if (!this._detectedUrls.has(url)) {
            this._detectedUrls.add(url);
            const mime = this._guessMimeFromUrl(url);
            formats.push(
              this.buildFormat({
                url,
                mimeType: mime,
                quality: "Podcast Enclosure",
                qualityLabel: "Podcast/Feed Enclosure",
                isVideo: /\.(mp4|webm|m3u8)(\?|$)/i.test(url),
                isAudio: /\.(mp3|m4a|aac|ogg|opus)(\?|$)/i.test(url),
                isMuxed: true,
                ext: this.guessExtension(mime),
              }),
            );
          }
        }
      }
    } catch (e) {
      console.debug(this.TAG, "Feed scan error:", e.message);
    }

    if (formats.length > 0) {
      this.sendToBackground({
        videoId: this._generateId(),
        formats,
        formatSource: "generic_feeds",
        title: document.title,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Download Link Scanner — <a> with download attribute or download-like context
  // ═══════════════════════════════════════════════════════════════════════
  _scanDownloadLinks() {
    const formats = [];

    try {
      // Links with download attribute
      for (const a of document.querySelectorAll("a[download][href]")) {
        const href = a.href;
        if (!href || this._detectedUrls.has(href)) continue;
        if (!/^https?:\/\//.test(href)) continue;

        if (
          /\.(mp4|webm|mkv|flv|avi|m4v|mov|mp3|m4a|aac|ogg|opus|flac|wav|m3u8|mpd)(\?|$)/i.test(
            href,
          )
        ) {
          this._detectedUrls.add(href);
          const mime = this._guessMimeFromUrl(href);
          const downloadName = a.getAttribute("download") || "";
          formats.push(
            this.buildFormat({
              url: href,
              mimeType: mime,
              quality: "Download Link",
              qualityLabel: downloadName
                ? `Download: ${downloadName}`
                : "Download Link",
              isVideo: !/\.(mp3|m4a|aac|ogg|opus|flac|wav)(\?|$)/i.test(href),
              isAudio: /\.(mp3|m4a|aac|ogg|opus|flac|wav)(\?|$)/i.test(href),
              isMuxed: true,
              ext: this.guessExtension(mime),
            }),
          );
        }
      }

      // Links with download-like text/class context
      for (const a of document.querySelectorAll(
        'a[href*="/download"], a[href*="dl="], a[class*="download"], a[id*="download"]',
      )) {
        const href = a.href;
        if (!href || this._detectedUrls.has(href)) continue;
        if (!/^https?:\/\//.test(href)) continue;
        if (/\.(mp4|webm|mkv|flv|m3u8|mpd|mp3|m4a|aac|ogg)(\?|$)/i.test(href)) {
          this._detectedUrls.add(href);
          const mime = this._guessMimeFromUrl(href);
          formats.push(
            this.buildFormat({
              url: href,
              mimeType: mime,
              quality: "Download",
              qualityLabel:
                a.textContent?.trim()?.substring(0, 50) || "Download Link",
              isVideo: !/\.(mp3|m4a|aac|ogg)(\?|$)/i.test(href),
              isMuxed: true,
              ext: this.guessExtension(mime),
            }),
          );
        }
      }
    } catch (e) {
      console.debug(this.TAG, "Download link scan error:", e.message);
    }

    if (formats.length > 0) {
      this.sendToBackground({
        videoId: this._generateId(),
        formats,
        formatSource: "generic_download_links",
        title: document.title,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // External Script Content Scanner — fetch & scan external JS files
  // ═══════════════════════════════════════════════════════════════════════
  _scanExternalScripts() {
    const formats = [];

    try {
      // Only scan scripts from the same origin or known player CDNs
      const currentOrigin = window.location.origin;
      const PLAYER_SCRIPT_PATTERNS = [
        /player/i,
        /video/i,
        /stream/i,
        /embed/i,
        /media/i,
        /jwplayer/i,
        /videojs/i,
        /flowplayer/i,
        /plyr/i,
        /bitmovin/i,
        /shaka/i,
        /hls\.js/i,
        /dash\.js/i,
      ];

      const scripts = document.querySelectorAll("script[src]");
      const toFetch = [];

      for (const script of scripts) {
        const src = script.src;
        if (!src) continue;

        // Same-origin scripts: check all
        // Cross-origin: only if URL matches player patterns
        const isSameOrigin = src.startsWith(currentOrigin);
        const isPlayerScript = PLAYER_SCRIPT_PATTERNS.some((p) => p.test(src));

        if (isSameOrigin || isPlayerScript) {
          // Skip known libraries/frameworks
          if (
            /jquery|react|angular|vue|lodash|moment|bootstrap|tailwind|analytics|gtm|fbevents/i.test(
              src,
            )
          )
            continue;
          toFetch.push(src);
        }
      }

      // Limit to 10 scripts to avoid excessive fetching
      const toProcess = toFetch.slice(0, 10);

      for (const scriptUrl of toProcess) {
        try {
          // Use synchronous XHR to avoid complexity (we're already in a delayed timer)
          const xhr = new XMLHttpRequest();
          xhr.open("GET", scriptUrl, false); // synchronous
          xhr.timeout = 3000;
          xhr.send();

          if (xhr.status === 200 && xhr.responseText) {
            const text = xhr.responseText;
            if (text.length > 2000000) continue; // Skip huge files

            // Look for video URLs
            this._extractUrlsFromJSON(
              text,
              `ExtScript:${new URL(scriptUrl).pathname.split("/").pop()}`,
              formats,
            );
          }
        } catch {}
      }
    } catch (e) {
      console.debug(this.TAG, "External script scan error:", e.message);
    }

    if (formats.length > 0) {
      console.log(
        this.TAG,
        `External script scan found ${formats.length} formats`,
      );
      this.sendToBackground({
        videoId: this._generateId(),
        formats,
        formatSource: "generic_external_scripts",
        title: document.title,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Comment/HTML Comment Scanner — video URLs hidden in HTML comments
  // ═══════════════════════════════════════════════════════════════════════
  _scanHTMLComments() {
    const formats = [];

    try {
      const walker = document.createTreeWalker(
        document.documentElement,
        NodeFilter.SHOW_COMMENT,
        null,
        false,
      );

      let node;
      while ((node = walker.nextNode())) {
        const text = node.nodeValue;
        if (!text || text.length < 20 || text.length > 100000) continue;

        const urlMatches = text.matchAll(
          /(https?:\/\/[^\s"'<>]+\.(?:m3u8|mpd|mp4|webm|mov|flv|mkv)(?:\?[^\s"'<>]*)?)/gi,
        );
        for (const m of urlMatches) {
          const url = m[1];
          if (!this._detectedUrls.has(url)) {
            this._detectedUrls.add(url);
            const mime = this._guessMimeFromUrl(url);
            formats.push(
              this.buildFormat({
                url,
                mimeType: mime,
                quality: "HTML Comment",
                qualityLabel: "Hidden in HTML Comment",
                isVideo: true,
                isMuxed: true,
                ext: this.guessExtension(mime),
              }),
            );
          }
        }
      }
    } catch (e) {
      console.debug(this.TAG, "HTML comment scan error:", e.message);
    }

    if (formats.length > 0) {
      this.sendToBackground({
        videoId: this._generateId(),
        formats,
        formatSource: "generic_html_comments",
        title: document.title,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Window postMessage Sniffer — detect inter-frame video URL delivery
  // ═══════════════════════════════════════════════════════════════════════
  _initPostMessageSniffer() {
    this.listen(window, "message", (e) => {
      // Skip our own messages
      if (e.data?.type === "__generic_extractor__") return;
      if (e.data?.type === "__generic_spa_navigation__") return;
      if (e.data?.type === "MAGIC_M3U8_DETECTION") return;

      try {
        let dataStr;
        if (typeof e.data === "string") {
          dataStr = e.data;
        } else if (typeof e.data === "object" && e.data !== null) {
          dataStr = JSON.stringify(e.data);
        }

        if (!dataStr || dataStr.length < 20 || dataStr.length > 100000) return;

        // Only process if it looks like it might contain video URLs
        if (!/m3u8|mpd|mp4|webm|video|stream|hls|dash/i.test(dataStr)) return;

        const urlMatches = dataStr.matchAll(
          /(https?:\/\/[^\s"'<>\\]+\.(?:m3u8|mpd|mp4|webm)(?:\?[^\s"'<>\\]*)?)/gi,
        );
        for (const m of urlMatches) {
          const url = this._unescapeJsonUrl(m[1]);
          if (!this._detectedUrls.has(url)) {
            this._detectedUrls.add(url);
            const mime = this._guessMimeFromUrl(url);
            const isM3u8 = /\.m3u8(\?|$)/i.test(url);
            const isMpd = /\.mpd(\?|$)/i.test(url);

            this.sendToBackground({
              videoId: this._generateId(),
              formats: [
                this.buildFormat({
                  url,
                  mimeType: isM3u8
                    ? "application/x-mpegurl"
                    : isMpd
                      ? "application/dash+xml"
                      : mime,
                  quality: "postMessage",
                  qualityLabel: "Inter-frame postMessage",
                  isVideo: true,
                  isMuxed: true,
                  ext: isM3u8
                    ? "m3u8"
                    : isMpd
                      ? "mpd"
                      : this.guessExtension(mime),
                  hasAudio: isM3u8 || isMpd,
                }),
              ],
              formatSource: "generic_postmessage",
              title: document.title,
            });
          }
        }
      } catch {}
    });
  }

  _periodicRescan() {
    if (this._destroyed) return;
    this._scanRound++;

    // Light scan: DOM + performance + download links
    this._scanDOM();
    this._performanceScanned = false;
    this._scanPerformanceResources();
    this._scanDownloadLinks();

    // Every 3rd round, do deeper scans
    if (this._scanRound % 3 === 0) {
      this._ssrDataScanned = false;
      this._scanSSRFrameworkData();
      this._jsGlobalsScanned = false;
      this._scanJSGlobals();
      this._scanPageSource();
      this._scanWebStorage();
    }

    // Every 5th round, full re-scan
    if (this._scanRound % 5 === 0) {
      this._dataAttrsScanned = false;
      this._scanDataAttributes();
      this._scanPlayers();
      this._scanEmbeds();
      this._scanCDNPatterns();
      this._scanMicrodata();
      this._customElementsScanned = false;
      this._scanCustomElements();
      this._scanNoscript();
      this._scanHTMLComments();
    }
  }

  destroy() {
    clearTimeout(this._scanDebounce);
    if (this._periodicScanId) clearInterval(this._periodicScanId);
    this._detectedUrls.clear();
    this._blobUrls.clear();
    this._subtitleUrls.clear();
    this._formatScores.clear();
    if (this._imageObserver) {
      this._imageObserver.disconnect();
    }
    if (this._lazyVideoObserver) {
      this._lazyVideoObserver.disconnect();
    }
    super.destroy();
  }
}

if (typeof globalThis !== "undefined") {
  globalThis.GenericExtractor = GenericExtractor;
}
