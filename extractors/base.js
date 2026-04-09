class BaseExtractor {

  constructor(name) {
    this.name = name;
    this.TAG = `[Extractor:${name}]`;
    this._destroyed = false;
    this._observers = [];
    this._listeners = [];
    this._timers = [];
  }

  static get URL_PATTERNS() {
    throw new Error("URL_PATTERNS must be defined by subclass");
  }

  static canHandle(url) {
    for (const pattern of this.URL_PATTERNS) {
      if (pattern.match.test(url)) {
        if (pattern.exclude && pattern.exclude.test(url)) continue;
        return true;
      }
    }
    return false;
  }

  async init() {
    throw new Error("init() must be implemented by subclass");
  }

  async extract() {
    throw new Error("extract() must be implemented by subclass");
  }

  sendToBackground(data) {
    if (this._destroyed) return;

    const msg = {
      action: "VIDEO_DETECTED",
      extractor: this.name,
      url: window.location.href,
      videoId: data.videoId || null,
      pageData: {
        resolvedFormats: data.formats || [],
        formatSource: data.formatSource || this.name.toLowerCase(),
        title: data.title || document.title,
        duration: data.duration || null,
        thumbnail: data.thumbnail || null,
        ...data.extra,
      },
    };

    console.log(this.TAG, "Sending VIDEO_DETECTED:", {
      videoId: msg.videoId,
      formats: (data.formats || []).length,
      source: msg.pageData.formatSource,
    });

    chrome.runtime.sendMessage(msg);
  }

  observe(target, options, callback) {
    const obs = new MutationObserver(callback);
    obs.observe(target, options);
    this._observers.push(obs);
    return obs;
  }

  listen(target, event, handler, options) {
    target.addEventListener(event, handler, options);
    this._listeners.push({ target, event, handler, options });
    return handler;
  }

  timer(fn, ms) {
    const id = setTimeout(fn, ms);
    this._timers.push({ type: "timeout", id });
    return id;
  }

  interval(fn, ms) {
    const id = setInterval(fn, ms);
    this._timers.push({ type: "interval", id });
    return id;
  }

  debounce(fn, ms) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  async fetchViaBackground(url, options = {}) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { action: "FETCH_URL", url, options },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else if (response?.error) {
            reject(new Error(response.error));
          } else {
            resolve(response);
          }
        },
      );
    });
  }

  matchVideoId(url, regex) {
    const m = url.match(regex);
    return m ? m[1] : null;
  }

  waitForElement(selector, timeout = 10000) {
    return new Promise((resolve) => {
      const existing = document.querySelector(selector);
      if (existing) return resolve(existing);

      const timer = setTimeout(() => {
        obs.disconnect();
        resolve(null);
      }, timeout);

      const obs = new MutationObserver(() => {
        const el = document.querySelector(selector);
        if (el) {
          clearTimeout(timer);
          obs.disconnect();
          resolve(el);
        }
      });

      obs.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true,
      });
    });
  }

  buildFormat({
    url,
    itag = 0,
    mimeType = "",
    quality = "",
    qualityLabel = "",
    width = 0,
    height = 0,
    fps = 0,
    bitrate = 0,
    audioBitrate = 0,
    audioQuality = "",
    contentLength = null,
    codecs = "",
    isVideo = false,
    isAudio = false,
    isMuxed = false,
    ext = "",
    ...extra
  }) {
    return {
      url,
      itag,
      mimeType,
      quality,
      qualityLabel: qualityLabel || quality,
      width,
      height,
      fps,
      bitrate,
      audioBitrate,
      audioQuality,
      contentLength,
      codecs,
      isVideo,
      isAudio,
      isMuxed,
      ext: ext || this.guessExtension(mimeType),
      ...extra,
    };
  }

  guessExtension(mimeType) {
    if (!mimeType) return "mp4";
    if (mimeType.includes("mp4")) return "mp4";
    if (mimeType.includes("webm")) return "webm";
    if (mimeType.includes("3gpp")) return "3gp";
    if (mimeType.includes("x-flv")) return "flv";
    if (mimeType.includes("mp2t")) return "ts";
    if (mimeType.includes("mpeg")) return "mp3";
    if (mimeType.includes("ogg")) return "ogg";
    if (mimeType.includes("m3u8") || mimeType.includes("mpegurl"))
      return "m3u8";
    return "mp4";
  }

  formatSize(bytes) {
    if (!bytes) return "";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + " MB";
    return (bytes / 1073741824).toFixed(2) + " GB";
  }

  destroy() {
    this._destroyed = true;

    for (const obs of this._observers) {
      try {
        obs.disconnect();
      } catch (e) {}
    }
    this._observers = [];

    for (const { target, event, handler, options } of this._listeners) {
      try {
        target.removeEventListener(event, handler, options);
      } catch (e) {}
    }
    this._listeners = [];

    for (const t of this._timers) {
      try {
        if (t.type === "timeout") clearTimeout(t.id);
        else clearInterval(t.id);
      } catch (e) {}
    }
    this._timers = [];

    console.log(this.TAG, "Destroyed");
  }
}

if (typeof globalThis !== "undefined") {
  globalThis.BaseExtractor = BaseExtractor;
}
