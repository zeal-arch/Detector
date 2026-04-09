class LersiaPlayExtractor extends BaseExtractor {
  constructor() {
    super("LersiaPlay");
    this._scanInterval = null;
    this._sentUrls = new Set();
  }

  static get URL_PATTERNS() {
    return [
      { match: /^https?:\/\/(www\.)?lersia\.com\// },
      { match: /^https?:\/\/api\.lersia\.com\// },
      { match: /^https?:\/\/lersia\.lailendemo\.com\// },
    ];
  }

  async init() {
    console.log(this.TAG, "Initializing");

    this.listen(window, "message", (e) => this._onSpecialistMessage(e));

    this._injectSpecialistFile();

    this.listen(window, "popstate", () => {
      this._sentUrls.clear();
      this.timer(() => this.extract(), 1000);
    });

    this.observe(
      document.body || document.documentElement,
      {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["src", "data-src", "data-hls-url", "data-m3u8"],
      },
      () => this._onDomMutation(),
    );

    this._scanInterval = setInterval(() => this.extract(), 6000);

    this.timer(() => this.extract(), 2000);

    console.log(this.TAG, "Initialized");
  }

  async extract() {
    const videos = [];

    videos.push(...this._extractFromMeta());

    videos.push(...this._extractFromVideoElements());

    videos.push(...this._extractFromHlsDataAttrs());

    videos.push(...this._extractFromContainerAttrs());

    videos.push(...this._extractFromIframes());

    videos.push(...this._extractFromScripts());

    const fresh = this._dedup(videos).filter((v) => !this._sentUrls.has(v.url));
    if (fresh.length > 0) {
      fresh.forEach((v) => this._sentUrls.add(v.url));
      console.log(this.TAG, `Found ${fresh.length} videos`);
      this._sendFormats(fresh);
    }

    return fresh.length > 0 ? { videos: fresh } : null;
  }

  _extractFromMeta() {
    const videos = [];
    for (const meta of document.querySelectorAll(
      'meta[property="og:video"], meta[property="og:video:url"], meta[property="og:video:secure_url"]',
    )) {
      const url = meta.content;
      if (url && url.startsWith("http")) {
        const resolved = this._resolveEmbedUrl(url) || url;
        videos.push({
          url: resolved,
          quality: "embed",
          format: "embed",
          title: this._getTitle(),
        });
      }
    }
    return videos;
  }

  _extractFromVideoElements() {
    const videos = [];
    for (const video of document.querySelectorAll("video")) {
      const src = video.src || video.currentSrc;
      if (src && src !== window.location.href && !src.startsWith("blob:")) {
        videos.push({
          url: src,
          quality: this._getQuality(src),
          format: this._extFromUrl(src, "mp4"),
          title: this._getTitle(),
        });
      }
      for (const source of video.querySelectorAll("source")) {
        if (source.src && source.src !== window.location.href) {
          videos.push({
            url: source.src,
            quality: this._getQuality(source.src),
            format: source.type
              ? source.type.split("/")[1]
              : this._extFromUrl(source.src, "mp4"),
            title: this._getTitle(),
          });
        }
      }
    }
    return videos;
  }

  _extractFromHlsDataAttrs() {
    const videos = [];
    for (const el of document.querySelectorAll(
      "[data-hls-url], [data-m3u8], [data-stream-url], [data-dash-url], [data-mpd]",
    )) {
      const url =
        el.getAttribute("data-hls-url") ||
        el.getAttribute("data-m3u8") ||
        el.getAttribute("data-stream-url") ||
        el.getAttribute("data-dash-url") ||
        el.getAttribute("data-mpd");
      if (url) {
        const fmt = url.includes(".mpd") ? "mpd" : "m3u8";
        videos.push({
          url,
          quality: "auto",
          format: fmt,
          title: this._getTitle(),
        });
      }
    }
    return videos;
  }

  _extractFromContainerAttrs() {
    const videos = [];
    for (const container of document.querySelectorAll(
      ".video-container, .player-container, .media-player, .video-player, .video-js, [data-vjs-player]",
    )) {
      for (const attr of [
        "data-video-url",
        "data-src",
        "data-url",
        "data-file",
      ]) {
        const u = container.getAttribute(attr);
        if (u) {
          videos.push({
            url: u,
            quality: this._getQuality(u),
            format: this._extFromUrl(u, "mp4"),
            title: this._getTitle(),
          });
          break;
        }
      }
    }
    return videos;
  }

  _extractFromIframes() {
    const videos = [];
    for (const iframe of document.querySelectorAll(
      'iframe[src*="youtube"], iframe[src*="youtu.be"], iframe[src*="vimeo"], iframe[src*="dailymotion"]',
    )) {
      const embedUrl = this._resolveEmbedUrl(iframe.src);
      if (embedUrl)
        videos.push({
          url: embedUrl,
          quality: "embed",
          format: "embed",
          title: this._getTitle() + " (Trailer)",
        });
    }
    return videos;
  }

  _extractFromScripts() {
    const videos = [];
    for (const script of document.querySelectorAll("script")) {
      const c = script.textContent || "";
      if (c.length < 20 || c.length > 500000) continue;
      const matches = c.match(
        /["'](https?:\/\/[^"']+\.(?:mp4|m3u8|mpd|webm))["']/gi,
      );
      if (matches) {
        for (const m of matches) {
          const url = m.slice(1, -1);
          if (url.startsWith("http"))
            videos.push({
              url,
              quality: this._getQuality(url),
              format: this._extFromUrl(url, "mp4"),
              title: this._getTitle(),
            });
        }
      }
    }
    return videos;
  }

  _onDomMutation() {
    this.timer(() => this.extract(), 800);
  }

  _injectSpecialistFile() {
    try {
      const url = chrome.runtime.getURL("extractors/sites/lersiaplay.js");
      const script = document.createElement("script");
      script.src = url;
      script.dataset.extractor = "lersiaplay";
      (document.head || document.documentElement).appendChild(script);
      script.onload = () => script.remove();
      console.log(this.TAG, "Specialist file injected into MAIN world");
    } catch (e) {
      console.warn(this.TAG, "Failed to inject specialist file:", e.message);
    }
  }

  _onSpecialistMessage(e) {
    if (
      !e.data ||
      e.data.type !== "LALHLIMPUII_JAHAU_DETECTED" ||
      e.data.source !== "lersiaplay"
    )
      return;

    const videos = e.data.data?.videos || [];
    if (videos.length > 0) {
      console.log(this.TAG, `Received ${videos.length} videos from specialist`);
      this._sendFormats(videos);
    }
  }

  _sendFormats(videos) {
    this.sendToBackground({
      formats: videos.map((v) =>
        this.buildFormat({
          url: v.url,
          mimeType: this._guessMime(v.format),
          quality: v.quality || "auto",
          qualityLabel: v.quality || "auto",
          title: v.title || document.title,
          isVideo: true,
          ext: v.format || "mp4",
          platform: "lersiaplay",
        }),
      ),
      title: document.title,
    });
  }

  _getTitle() {
    const selectors = [
      ".video-title",
      ".movie-title",
      ".series-title",
      ".content-title",
      ".title",
      "h1",
      "h2",
      ".player-title",
      "[data-title]",
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim()) return el.textContent.trim();
    }
    return document.title;
  }

  _getQuality(url) {
    if (url.includes("1080")) return "1080p";
    if (url.includes("720")) return "720p";
    if (url.includes("480")) return "480p";
    if (url.includes("360")) return "360p";
    return "auto";
  }

  _extFromUrl(url, fallback) {
    try {
      return url.split(".").pop().split("?")[0] || fallback;
    } catch {
      return fallback;
    }
  }

  _resolveEmbedUrl(src) {
    if (!src) return null;
    if (src.includes("youtube.com/embed/")) {
      const id = src.match(/embed\/([^?/]+)/);
      return id ? `https://www.youtube.com/watch?v=${id[1]}` : null;
    }
    if (src.includes("youtube.com/watch")) return src;
    if (src.includes("youtu.be/")) {
      const id = src.match(/youtu\.be\/([^?/]+)/);
      return id ? `https://www.youtube.com/watch?v=${id[1]}` : null;
    }
    if (src.includes("vimeo.com/")) {
      const id = src.match(/vimeo\.com\/(?:video\/)?(\d+)/);
      return id ? `https://vimeo.com/${id[1]}` : null;
    }
    if (src.includes("dailymotion.com/embed/video/")) {
      const id = src.match(/embed\/video\/([^?/]+)/);
      return id ? `https://www.dailymotion.com/video/${id[1]}` : null;
    }
    return null;
  }

  _guessMime(format) {
    switch (format) {
      case "m3u8":
        return "application/x-mpegURL";
      case "mpd":
        return "application/dash+xml";
      case "webm":
        return "video/webm";
      case "mp4":
        return "video/mp4";
      case "embed":
        return "video/mp4";
      default:
        return "video/mp4";
    }
  }

  _dedup(videos) {
    const seen = new Set();
    return videos.filter((v) => {
      if (seen.has(v.url)) return false;
      seen.add(v.url);
      return true;
    });
  }

  destroy() {
    console.log(this.TAG, "Destroying");
    if (this._scanInterval) {
      clearInterval(this._scanInterval);
      this._scanInterval = null;
    }
    super.destroy();
  }
}

if (typeof globalThis !== "undefined") {
  globalThis.LersiaPlayExtractor = LersiaPlayExtractor;
}
