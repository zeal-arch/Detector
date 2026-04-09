class BaahiExtractor extends BaseExtractor {
  constructor() {
    super("Baahi Music");
  }

  static get URL_PATTERNS() {
    return [{ match: /^https?:\/\/(www\.)?baahi\.xomoy\.com\// }];
  }

  async init() {
    console.log(this.TAG, "Initializing");

    this.listen(window, "message", (e) => this._onSpecialistMessage(e));

    this._injectSpecialistFile();

    this.observe(
      document.documentElement,
      { childList: true, subtree: true },
      (mutations) => this._onDomMutation(mutations),
    );

    this.timer(() => this.extract(), 3000);

    this._scanInterval = setInterval(() => this.extract(), 8000);

    console.log(this.TAG, "Initialized");
  }

  async extract() {
    const videos = [];
    const audioRe = /\.(mp3|m4a|aac|ogg|wav|flac|opus|weba)(\?|$)/i;

    for (const el of document.querySelectorAll("audio, video")) {
      if (el.src && audioRe.test(el.src)) {
        videos.push(this._makeTrack(el.src));
      }
      if (el.currentSrc && audioRe.test(el.currentSrc)) {
        videos.push(this._makeTrack(el.currentSrc));
      }
      for (const src of el.querySelectorAll("source")) {
        if (src.src && audioRe.test(src.src)) {
          videos.push(this._makeTrack(src.src));
        }
      }
    }

    for (const script of document.querySelectorAll("script")) {
      const c = script.textContent || "";
      if (c.length < 20 || c.length > 300000) continue;
      const matches = c.match(
        /["'](https?:\/\/[^"']+\.(?:mp3|m4a|aac|ogg|wav|flac|opus|weba))["']/gi,
      );
      if (matches) {
        for (const m of matches) {
          videos.push(this._makeTrack(m.slice(1, -1)));
        }
      }
    }

    const unique = this._dedup(videos);
    if (unique.length > 0) {
      console.log(this.TAG, `Found ${unique.length} audio tracks`);
      this._sendFormats(unique);
    }

    return unique.length > 0 ? { videos: unique } : null;
  }

  _onDomMutation(mutations) {
    for (const mut of mutations) {
      for (const node of mut.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.tagName === "AUDIO" || node.tagName === "VIDEO") {
          if (node.src) this._sendSingleTrack(node.src);
        }
        const mediaEls = node.querySelectorAll?.("audio, video");
        if (mediaEls) {
          for (const el of mediaEls) {
            if (el.src) this._sendSingleTrack(el.src);
          }
        }
      }
    }
  }

  _sendSingleTrack(url) {
    if (!/\.(mp3|m4a|aac|ogg|wav|flac|opus|weba)(\?|$)/i.test(url)) return;
    this._sendFormats([this._makeTrack(url)]);
  }

  _injectSpecialistFile() {
    try {
      const url = chrome.runtime.getURL("extractors/sites/baahi.js");
      const script = document.createElement("script");
      script.src = url;
      script.dataset.extractor = "baahi";
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
      e.data.source !== "baahi"
    )
      return;

    const videos = e.data.data?.videos || [];
    if (videos.length > 0) {
      console.log(this.TAG, `Received ${videos.length} tracks from specialist`);
      this._sendFormats(videos);
    }
  }

  _sendFormats(videos) {
    this.sendToBackground({
      formats: videos.map((v) =>
        this.buildFormat({
          url: v.url,
          mimeType: this._guessMime(v.format),
          quality: v.quality || "audio",
          qualityLabel: v.quality || "audio",
          title: v.title || document.title,
          isAudio: true,
          ext: v.format || "mp3",
          platform: "baahi",
        }),
      ),
      title: document.title,
    });
  }

  _makeTrack(url) {
    return {
      url,
      quality: "audio",
      format: url.match(/\.(\w+)(?:\?|$)/)?.[1] || "mp3",
      title: this._getSongTitle(),
      extractor: "baahi",
    };
  }

  _getSongTitle() {
    const selectors = [
      "h1",
      ".song-title",
      ".track-title",
      ".player-title",
      ".now-playing-title",
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim()) return el.textContent.trim();
    }
    return (
      document.title.replace(/\s*[-|]\s*Baahi.*$/i, "").trim() || document.title
    );
  }

  _guessMime(format) {
    switch (format) {
      case "mp3":
        return "audio/mpeg";
      case "m4a":
      case "aac":
        return "audio/aac";
      case "ogg":
      case "opus":
        return "audio/ogg";
      case "wav":
        return "audio/wav";
      case "flac":
        return "audio/flac";
      case "weba":
        return "audio/webm";
      case "m3u8":
        return "application/x-mpegURL";
      default:
        return "audio/mpeg";
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
    if (this._scanInterval) clearInterval(this._scanInterval);
    super.destroy();
  }
}

if (typeof globalThis !== "undefined") {
  globalThis.BaahiExtractor = BaahiExtractor;
}
