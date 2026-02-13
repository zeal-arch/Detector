class NortheastNewsExtractor extends BaseExtractor {
  constructor() {
    super("Northeast News");
  }

  static get URL_PATTERNS() {
    return [
      { match: /^https?:\/\/(www\.)?nenow\.in\// },
      { match: /^https?:\/\/(www\.)?nenews\.in\// },
    ];
  }

  async init() {
    console.log(this.TAG, "Initializing");

    this.listen(window, "message", (e) => this._onSpecialistMessage(e));

    this._injectSpecialistFile();

    this.listen(window, "popstate", () =>
      this.timer(() => this.extract(), 1000),
    );

    this.timer(() => this.extract(), 3000);

    console.log(this.TAG, "Initialized");
  }

  async extract() {
    const videos = [];

    videos.push(...this._extractFromMeta());

    videos.push(...this._extractFromWpBlocks());

    videos.push(...this._extractFromMediaElements());

    videos.push(...this._extractFromIframes());

    videos.push(...this._extractFromArticleLinks());

    videos.push(...this._extractFromScripts());

    const unique = this._dedup(videos);
    if (unique.length > 0) {
      console.log(this.TAG, `Found ${unique.length} media items`);
      this._sendFormats(unique);
    }

    return unique.length > 0 ? { videos: unique } : null;
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

    for (const meta of document.querySelectorAll(
      'meta[property="og:audio"], meta[property="og:audio:url"]',
    )) {
      const url = meta.content;
      if (url && url.startsWith("http")) {
        videos.push({
          url,
          quality: "audio",
          format: this._extFromUrl(url, "mp3"),
          title: this._getTitle() + " (Audio)",
        });
      }
    }
    return videos;
  }

  _extractFromWpBlocks() {
    const videos = [];

    for (const block of document.querySelectorAll(
      ".wp-block-video video, figure.wp-block-video video",
    )) {
      if (block.src) {
        videos.push({
          url: block.src,
          quality: "auto",
          format: this._extFromUrl(block.src, "mp4"),
          title: this._getTitle(),
        });
      }
    }

    for (const block of document.querySelectorAll(
      ".wp-block-audio audio, figure.wp-block-audio audio",
    )) {
      if (block.src) {
        videos.push({
          url: block.src,
          quality: "audio",
          format: this._extFromUrl(block.src, "mp3"),
          title: this._getTitle() + " (Audio)",
        });
      }
    }

    for (const iframe of document.querySelectorAll(
      "figure.wp-block-embed iframe, .wp-block-embed__wrapper iframe",
    )) {
      const embedUrl = this._resolveEmbedUrl(iframe.src);
      if (embedUrl) {
        videos.push({
          url: embedUrl,
          quality: "embed",
          format: "embed",
          title: this._getTitle() + " (Embed)",
        });
      }
    }
    return videos;
  }

  _extractFromMediaElements() {
    const videos = [];
    for (const video of document.querySelectorAll("video")) {
      if (video.src)
        videos.push({
          url: video.src,
          quality: "auto",
          format: this._extFromUrl(video.src, "mp4"),
          title: this._getTitle(),
        });
      for (const src of video.querySelectorAll("source")) {
        if (src.src)
          videos.push({
            url: src.src,
            quality: "auto",
            format: this._extFromUrl(src.src, "mp4"),
            title: this._getTitle(),
          });
      }
    }
    for (const audio of document.querySelectorAll("audio")) {
      if (audio.src)
        videos.push({
          url: audio.src,
          quality: "audio",
          format: this._extFromUrl(audio.src, "mp3"),
          title: this._getTitle() + " (Audio)",
        });
      for (const src of audio.querySelectorAll("source")) {
        if (src.src)
          videos.push({
            url: src.src,
            quality: "audio",
            format: this._extFromUrl(src.src, "mp3"),
            title: this._getTitle() + " (Audio)",
          });
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
          title: this._getTitle() + " (Embed)",
        });
    }
    return videos;
  }

  _extractFromArticleLinks() {
    const videos = [];
    const article = document.querySelector(
      "article, .entry-content, .post-content, .content, .story-content",
    );
    if (!article) return videos;

    for (const link of article.querySelectorAll("a[href]")) {
      const href = link.href;
      const ytMatch = href.match(
        /(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]+)/,
      );
      if (ytMatch) {
        videos.push({
          url: `https://www.youtube.com/watch?v=${ytMatch[1]}`,
          quality: "embed",
          format: "embed",
          title: this._getTitle() + " (YouTube)",
        });
        continue;
      }
      const vimeoMatch = href.match(/vimeo\.com\/(\d+)/);
      if (vimeoMatch) {
        videos.push({
          url: `https://vimeo.com/${vimeoMatch[1]}`,
          quality: "embed",
          format: "embed",
          title: this._getTitle() + " (Vimeo)",
        });
        continue;
      }

      if (/\.(?:mp4|m3u8|mp3|m4a|webm|ogg)(\?|$)/i.test(href)) {
        const isAudio = /\.(?:mp3|m4a|ogg)(\?|$)/i.test(href);
        videos.push({
          url: href,
          quality: isAudio ? "audio" : "auto",
          format: this._extFromUrl(href, "mp4"),
          title: link.textContent.trim() || this._getTitle(),
        });
      }
    }

    return videos;
  }

  _extractFromScripts() {
    const videos = [];
    for (const script of document.querySelectorAll("script")) {
      const c = script.textContent || "";
      if (c.length < 20 || c.length > 300000) continue;
      const matches = c.match(
        /["'](https?:\/\/[^"']+\.(?:mp4|m3u8|mp3|m4a|webm))["']/gi,
      );
      if (matches) {
        for (const m of matches) {
          const url = m.slice(1, -1);
          videos.push({
            url,
            quality: "auto",
            format: this._extFromUrl(url, "mp4"),
            title: this._getTitle(),
          });
        }
      }
    }
    return videos;
  }

  _injectSpecialistFile() {
    try {
      const url = chrome.runtime.getURL("extractors/sites/northeast-news.js");
      const script = document.createElement("script");
      script.src = url;
      script.dataset.extractor = "northeast-news";
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
      e.data.source !== "northeast-news"
    )
      return;

    const videos = e.data.data?.videos || [];
    if (videos.length > 0) {
      console.log(this.TAG, `Received ${videos.length} items from specialist`);
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
          isVideo: v.quality !== "audio",
          isAudio: v.quality === "audio",
          ext: v.format || "mp4",
          platform: "northeast-news",
        }),
      ),
      title: document.title,
    });
  }

  _getTitle() {
    const el = document.querySelector("h1, .entry-title, .post-title, .title");
    return (el && el.textContent.trim()) || document.title;
  }

  _extFromUrl(url, fallback) {
    try {
      const ext = url.split(".").pop().split("?")[0];
      return ext || fallback;
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
      case "mp3":
      case "m4a":
      case "wav":
      case "flac":
        return "audio/mpeg";
      case "m3u8":
        return "application/x-mpegURL";
      case "webm":
        return "video/webm";
      case "mp4":
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
    super.destroy();
  }
}

if (typeof globalThis !== "undefined") {
  globalThis.NortheastNewsExtractor = NortheastNewsExtractor;
}
