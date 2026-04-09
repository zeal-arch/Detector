class MXPlayerExtractor extends BaseExtractor {
  constructor() {
    super("MX Player");
  }

  static get URL_PATTERNS() {
    return [{ match: /^https?:\/\/(www\.)?mxplayer\.in\// }];
  }

  async init() {
    console.log(this.TAG, "Initializing");

    this.listen(window, "message", (e) => this._onSpecialistMessage(e));

    this._injectSpecialistFile();

    this.listen(window, "popstate", () =>
      this.timer(() => this.extract(), 500),
    );
    this._patchHistory();

    this.timer(() => this.extract(), 1500);

    console.log(this.TAG, "Initialized");
  }

  async extract() {
    const videoData = [];

    videoData.push(...this._extractFromNextData());

    videoData.push(...this._extractFromVideoElements());

    videoData.push(...this._extractFromScripts());

    const uniqueVideos = this._dedup(videoData);

    if (uniqueVideos.length > 0) {
      console.log(this.TAG, `Found ${uniqueVideos.length} unique videos`);
      this._sendFormats(uniqueVideos);
    }

    return uniqueVideos.length > 0 ? { videos: uniqueVideos } : null;
  }

  _injectSpecialistFile() {
    try {
      const url = chrome.runtime.getURL("extractors/sites/mxplayer.js");
      const script = document.createElement("script");
      script.src = url;
      script.dataset.extractor = "mxplayer";
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
      e.data.source !== "mxplayer"
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
          mimeType: this._getMimeType(v.type),
          quality: v.quality || "auto",
          qualityLabel: v.quality || "auto",
          title: v.title || document.title,
          isVideo: true,
          ext: this._getExtension(v.type),
          platform: "mxplayer",
          drm: v.drm || false,
        }),
      ),
      title: document.title,
    });
  }

  _extractFromNextData() {
    const videos = [];
    const el = document.querySelector("script#__NEXT_DATA__");
    if (!el) return videos;
    try {
      const d = JSON.parse(el.textContent);
      const pp = d?.props?.pageProps;
      if (!pp) return videos;

      const searchObj = (obj, depth) => {
        if (!obj || depth > 4) return;
        for (const [, val] of Object.entries(obj)) {
          if (typeof val === "string" && val.length > 10) {
            if (/\.m3u8(\?|$)/i.test(val))
              videos.push({
                url: val,
                type: "hls",
                quality: "auto",
                title: document.title,
                drm: false,
              });
            else if (/\.mpd(\?|$)/i.test(val))
              videos.push({
                url: val,
                type: "dash",
                quality: "auto",
                title: document.title,
                drm: false,
              });
            else if (/\.mp4(\?|$)/i.test(val) && /^https?:\/\//.test(val))
              videos.push({
                url: val,
                type: "mp4",
                quality: "auto",
                title: document.title,
                drm: false,
              });
          } else if (typeof val === "object" && val !== null) {
            searchObj(val, depth + 1);
          }
        }
      };
      searchObj(pp, 0);
    } catch {

    }
    return videos;
  }

  _extractFromVideoElements() {
    const videos = [];
    for (const video of document.querySelectorAll("video")) {
      if (video.src && video.src.startsWith("http"))
        videos.push({
          url: video.src,
          type: "auto",
          quality: "auto",
          title: document.title,
          drm: false,
        });
      for (const src of video.querySelectorAll("source")) {
        if (src.src && src.src.startsWith("http"))
          videos.push({
            url: src.src,
            type: src.type || "auto",
            quality: "auto",
            title: document.title,
            drm: false,
          });
      }
    }
    return videos;
  }

  _extractFromScripts() {
    const videos = [];
    for (const script of document.querySelectorAll(
      "script:not(#__NEXT_DATA__)",
    )) {
      const c = script.textContent || "";
      if (c.length < 20 || c.length > 500000) continue;

      const m3u8 = c.match(/["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/g);
      if (m3u8)
        for (const m of m3u8)
          videos.push({
            url: m.slice(1, -1),
            type: "hls",
            quality: "auto",
            title: document.title,
            drm: false,
          });

      const mpd = c.match(/["'](https?:\/\/[^"']+\.mpd[^"']*)["']/g);
      if (mpd)
        for (const m of mpd)
          videos.push({
            url: m.slice(1, -1),
            type: "dash",
            quality: "auto",
            title: document.title,
            drm: false,
          });

      const mp4 = c.match(/["'](https?:\/\/[^"']+\.mp4[^"']*)["']/g);
      if (mp4)
        for (const m of mp4)
          videos.push({
            url: m.slice(1, -1),
            type: "mp4",
            quality: "auto",
            title: document.title,
            drm: false,
          });
    }
    return videos;
  }

  _dedup(videos) {
    const seen = new Set();
    return videos.filter((v) => {
      if (seen.has(v.url)) return false;
      seen.add(v.url);
      return true;
    });
  }

  _getMimeType(type) {
    switch (type) {
      case "hls":
        return "application/x-mpegURL";
      case "mp4":
        return "video/mp4";
      case "dash":
        return "application/dash+xml";
      default:
        return "video/mp4";
    }
  }

  _getExtension(type) {
    switch (type) {
      case "hls":
        return "m3u8";
      case "mp4":
        return "mp4";
      case "dash":
        return "mpd";
      default:
        return "mp4";
    }
  }

  _patchHistory() {
    const self = this;
    const origPush = history.pushState;
    history.pushState = function () {
      origPush.apply(this, arguments);
      setTimeout(() => self.extract(), 500);
    };
    const origReplace = history.replaceState;
    history.replaceState = function () {
      origReplace.apply(this, arguments);
      setTimeout(() => self.extract(), 500);
    };
  }

  destroy() {
    console.log(this.TAG, "Destroying");
    super.destroy();
  }
}

if (typeof globalThis !== "undefined") {
  globalThis.MXPlayerExtractor = MXPlayerExtractor;
}
