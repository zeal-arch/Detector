class TwitterExtractor extends BaseExtractor {
  constructor() {
    super("Twitter");
    this._processedTweets = new Set();
    this._processedPhotos = new Set();
  }

  static get URL_PATTERNS() {
    return [
      { match: /^https?:\/\/(www\.)?twitter\.com\// },
      { match: /^https?:\/\/(www\.)?x\.com\// },
      { match: /^https?:\/\/mobile\.(twitter|x)\.com\// },
    ];
  }

  async init() {
    console.log(this.TAG, "Initializing");

    this._injectNetworkHook();

    this.observe(
      document.body || document.documentElement,
      {
        childList: true,
        subtree: true,
      },
      () => this._debouncedScan(),
    );

    this.timer(() => this._scanTweets(), 2000);

    this.listen(window, "message", (e) => this._onInterceptedData(e));

    console.log(this.TAG, "Initialized");
  }

  async extract() {

    const formats = [];
    const nextData = this._extractFromNextData();
    formats.push(...nextData);
    return formats.length > 0
      ? {
          videoId: this._getTweetId(),
          formats,
          formatSource: "twitter",
          title: document.title,
        }
      : null;
  }

  _injectNetworkHook() {

    console.log(this.TAG, "Network hook loaded via manifest MAIN world script");
  }

  _onInterceptedData(e) {
    if (!e.data || e.data.type !== "__twitter_extractor__") return;

    if (e.data.action === "API_VIDEOS") {
      this._onInterceptedVideos(e.data.videos || []);
    } else if (e.data.action === "API_PHOTOS") {
      this._onInterceptedPhotos(e.data.photos || []);
    }
  }

  _onInterceptedVideos(videos) {
    for (const video of videos) {
      if (this._processedTweets.has(video.id)) continue;
      this._processedTweets.add(video.id);

      const formats = this._convertVariantsToFormats(video);
      if (formats.length > 0) {
        this.sendToBackground({
          videoId: video.id,
          formats,
          formatSource: "twitter_api",
          title: document.title,
          duration: video.duration ? video.duration / 1000 : null,
        });
      }
    }
  }

  _onInterceptedPhotos(photos) {

    const newPhotos = photos.filter((p) => !this._processedPhotos.has(p.id));
    if (newPhotos.length === 0) return;

    const allFormats = [];
    for (const photo of newPhotos) {
      this._processedPhotos.add(photo.id);
      allFormats.push(...this._convertPhotoToFormats(photo));
    }

    if (allFormats.length > 0) {
      const tweetId = this._getTweetId() || `photos_${Date.now()}`;
      this.sendToBackground({
        videoId: `photo_${tweetId}`,
        formats: allFormats,
        formatSource: "twitter_photo",
        title: document.title,
        thumbnail: newPhotos[0]?.urlLarge || newPhotos[0]?.url,
      });
    }
  }

  _convertPhotoToFormats(photo) {
    const formats = [];
    const dimLabel =
      photo.width && photo.height ? ` (${photo.width}×${photo.height})` : "";

    if (photo.urlOrig) {
      formats.push(
        this.buildFormat({
          url: photo.urlOrig,
          mimeType: "image/jpeg",
          quality: "Original",
          qualityLabel: `Original${dimLabel}`,
          width: photo.width || 0,
          height: photo.height || 0,
          isVideo: false,
          isMuxed: true,
          ext: "jpg",
        }),
      );
    }

    if (photo.url4k) {
      formats.push(
        this.buildFormat({
          url: photo.url4k,
          mimeType: "image/jpeg",
          quality: "4K",
          qualityLabel: "4K (max resolution)",
          isVideo: false,
          isMuxed: true,
          ext: "jpg",
        }),
      );
    }

    if (photo.urlLarge) {
      formats.push(
        this.buildFormat({
          url: photo.urlLarge,
          mimeType: "image/jpeg",
          quality: "Large",
          qualityLabel: "Large",
          isVideo: false,
          isMuxed: true,
          ext: "jpg",
        }),
      );
    }

    return formats;
  }

  _convertVariantsToFormats(video) {
    const formats = [];
    for (const v of video.variants) {

      let width = 0,
        height = 0;
      const resMatch = v.url.match(/\/(\d{3,4})x(\d{3,4})\//);
      if (resMatch) {
        width = parseInt(resMatch[1]);
        height = parseInt(resMatch[2]);

        if (width > height) {

        } else {

        }
      }

      const qualityLabel =
        height >= 1080
          ? "1080p"
          : height >= 720
            ? "720p"
            : height >= 480
              ? "480p"
              : height >= 360
                ? "360p"
                : height >= 270
                  ? "270p"
                  : `${v.bitrate ? Math.round(v.bitrate / 1000) + "kbps" : "Unknown"}`;

      formats.push(
        this.buildFormat({
          url: v.url,
          mimeType: v.contentType || "video/mp4",
          quality: qualityLabel,
          qualityLabel: qualityLabel,
          width,
          height,
          bitrate: v.bitrate || 0,
          isVideo: true,
          isMuxed: true,
          ext: "mp4",
        }),
      );
    }
    return formats;
  }

  _debouncedScan = this.debounce(() => this._scanTweets(), 1000);

  _scanTweets() {

    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    for (const article of articles) {
      const video = article.querySelector("video");
      if (video) {

        const permalink = article.querySelector('a[href*="/status/"]');
        if (!permalink) continue;

        const tweetIdMatch = permalink.href.match(/\/status\/(\d+)/);
        if (!tweetIdMatch) continue;

        const tweetId = tweetIdMatch[1];
        if (this._processedTweets.has(tweetId)) continue;

        console.log(this.TAG, "Video found in tweet:", tweetId);
      }

      this._scanTweetPhotos(article);
    }
  }

  _scanTweetPhotos(article) {

    const images = article.querySelectorAll('img[src*="pbs.twimg.com/media/"]');
    for (const img of images) {
      const src = img.src;
      if (!src || this._processedPhotos.has(src)) continue;

      const baseUrl = src.split("?")[0];
      if (!baseUrl.includes("pbs.twimg.com/media/")) continue;

      this._processedPhotos.add(src);

      const permalink = article.querySelector('a[href*="/status/"]');
      const tweetId =
        permalink?.href?.match(/\/status\/(\d+)/)?.[1] || "unknown";

      const formats = [
        this.buildFormat({
          url: baseUrl + "?format=jpg&name=orig",
          mimeType: "image/jpeg",
          quality: "Original",
          qualityLabel: "Original",
          isVideo: false,
          isMuxed: true,
          ext: "jpg",
        }),
        this.buildFormat({
          url: baseUrl + "?format=jpg&name=4096x4096",
          mimeType: "image/jpeg",
          quality: "4K",
          qualityLabel: "4K (max resolution)",
          isVideo: false,
          isMuxed: true,
          ext: "jpg",
        }),
        this.buildFormat({
          url: baseUrl + "?format=jpg&name=large",
          mimeType: "image/jpeg",
          quality: "Large",
          qualityLabel: "Large",
          isVideo: false,
          isMuxed: true,
          ext: "jpg",
        }),
      ];

      this.sendToBackground({
        videoId: `photo_${tweetId}_${Date.now()}`,
        formats,
        formatSource: "twitter_photo",
        title: img.alt || document.title,
        thumbnail: baseUrl + "?format=jpg&name=small",
      });
    }
  }

  _extractFromNextData() {
    const formats = [];
    const nextScript = document.getElementById("__NEXT_DATA__");
    if (!nextScript) return formats;

    try {
      const data = JSON.parse(nextScript.textContent);
      const videos = [];
      this._findVideoInObject(data, videos);

      for (const video of videos) {
        const converted = this._convertVariantsToFormats(video);
        formats.push(...converted);
      }
    } catch (e) {
      console.warn(this.TAG, "Failed to parse __NEXT_DATA__:", e.message);
    }

    return formats;
  }

  _findVideoInObject(obj, results, depth = 0) {
    if (!obj || typeof obj !== "object" || depth > 15) return;

    if (obj.video_info?.variants) {
      const mp4s = obj.video_info.variants
        .filter((v) => v.content_type === "video/mp4")
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

      if (mp4s.length > 0) {
        results.push({
          id: obj.id_str || "unknown",
          variants: mp4s.map((v) => ({
            url: v.url,
            bitrate: v.bitrate || 0,
            contentType: v.content_type,
          })),
          duration: obj.video_info.duration_millis || 0,
        });
      }
    }

    if (Array.isArray(obj)) {
      for (const item of obj) this._findVideoInObject(item, results, depth + 1);
    } else {
      for (const key of Object.keys(obj)) {
        this._findVideoInObject(obj[key], results, depth + 1);
      }
    }
  }

  _getTweetId() {
    const m = window.location.href.match(/\/status\/(\d+)/);
    return m ? m[1] : null;
  }

  destroy() {
    this._processedTweets.clear();
    this._processedPhotos.clear();
    super.destroy();
  }
}

if (typeof globalThis !== "undefined") {
  globalThis.TwitterExtractor = TwitterExtractor;
}
