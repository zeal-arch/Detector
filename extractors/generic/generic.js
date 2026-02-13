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

    console.log(this.TAG, "Initialized with enhanced detection");
  }

  async extract() {
    const formats = [];

    for (const video of document.querySelectorAll("video")) {
      const videoFormats = this._extractFromVideoEl(video);
      formats.push(...videoFormats);
    }

    const metaFormats = this._extractFromMetaTags();
    formats.push(...metaFormats);

    const linkFormats = this._extractFromLinks();
    formats.push(...linkFormats);

    const playerFormats = this._extractFromPlayers();
    formats.push(...playerFormats);

    const embedFormats = this._extractFromEmbeds();
    formats.push(...embedFormats);

    if (formats.length === 0) return null;

    return {
      videoId: this._generateId(),
      formats,
      formatSource: "generic",
      title: document.title,
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

    for (const url of urls) {
      if (this._detectedUrls.has(url)) continue;
      this._detectedUrls.add(url);

      const mime = this._guessMimeFromUrl(url);
      const isM3u8 = /\.m3u8(\?|$)/i.test(url);
      const isMpd = /\.mpd(\?|$)/i.test(url);
      const isBlob = url.startsWith("blob:");

      formats.push(
        this.buildFormat({
          url,
          mimeType: isBlob ? video.type || mime : mime,
          quality: this._guessQualityFromVideo(video),
          qualityLabel: isBlob
            ? `Blob (${this._guessQualityFromVideo(video)})`
            : this._guessQualityFromVideo(video),
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

    return formats;
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
    return "video/mp4";
  }

  _onMutation(mutations) {
    let hasNewVideos = false;
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.tagName === "VIDEO" || node.querySelector?.("video")) {
          hasNewVideos = true;
          break;
        }
      }
      if (hasNewVideos) break;
    }

    if (hasNewVideos) {

      clearTimeout(this._scanDebounce);
      this._scanDebounce = setTimeout(() => this._scanDOM(), 500);
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
        /(https?:\/\/[^\s"'<>]+\.(?:mp4|webm)(?:\?[^\s"'<>]*)?)/gi,
      );
      for (const m of videoUrlMatches) {
        const url = m[1];

        if (url.length > 300) continue;
        if (/thumb|poster|preview|sprite/i.test(url)) continue;
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
      } catch (e) {

      }
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
    const videoExts = /\.(mp4|webm|mkv|flv|avi|m4v|mov|3gp)(\?|$)/i;

    for (const a of document.querySelectorAll("a[href]")) {
      const href = a.href;
      if (!href || !videoExts.test(href)) continue;
      if (this._detectedUrls.has(href)) continue;
      if (!/^https?:\/\//.test(href)) continue;

      const text = (a.textContent || "").toLowerCase();
      if (/thumb|preview|poster/i.test(text)) continue;

      this._detectedUrls.add(href);
      const mime = this._guessMimeFromUrl(href);
      formats.push(
        this.buildFormat({
          url: href,
          mimeType: mime,
          quality: "Direct Link",
          qualityLabel:
            a.textContent?.trim()?.substring(0, 50) || "Direct Link",
          isVideo: true,
          isMuxed: true,
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

      let mimeType, quality, qualityLabel, ext;
      if (isM3u8) {
        mimeType = "application/x-mpegurl";
        quality = "HLS Stream";
        qualityLabel = webAudio
          ? "HLS (Web Audio) → MP4+audio"
          : "HLS (auto-converts to MP4 with audio)";
        ext = "m3u8";
      } else if (isMpd) {
        mimeType = "application/dash+xml";
        quality = "DASH Stream";
        qualityLabel = webAudio
          ? "DASH (Web Audio) → MP4+audio"
          : "DASH (auto-converts to MP4 with audio)";
        ext = "mpd";
      } else {
        mimeType = this._guessMimeFromUrl(url);
        quality = "Direct URL";
        qualityLabel = webAudio
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

      this.sendToBackground({
        videoId: this._generateId(),
        formats: [format],
        formatSource: isDirect
          ? "generic_intercept_direct"
          : "generic_intercept",
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

    if (GenericExtractor.SKIP_HOSTS.has(hostname)) return true;

    const parts = hostname.split(".");
    if (parts.length > 2) {
      const parent = parts.slice(-2).join(".");
      if (GenericExtractor.SKIP_HOSTS.has(parent)) return true;
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
    } catch (e) {

    }

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
    } catch (e) {

    }
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

  destroy() {
    clearTimeout(this._scanDebounce);
    this._detectedUrls.clear();
    this._blobUrls.clear();
    if (this._imageObserver) {
      this._imageObserver.disconnect();
    }
    super.destroy();
  }
}

if (typeof globalThis !== "undefined") {
  globalThis.GenericExtractor = GenericExtractor;
}
