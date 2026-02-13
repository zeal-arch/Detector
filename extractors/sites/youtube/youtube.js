class YouTubeExtractor extends BaseExtractor {
  constructor() {
    super("YouTube");
    this._injected = false;
    this._lastVideoId = null;
    this._debounceTimer = null;
    this._messageHandler = null;
  }

  static get URL_PATTERNS() {
    return [
      {
        match:
          /^https?:\/\/(www\.|m\.|music\.)?youtube\.com\/(watch|shorts|embed|live|v)\b/,
      },
      {
        match: /^https?:\/\/youtu\.be\//,
      },
      {
        match: /^https?:\/\/(www\.|m\.)?youtube\.com\/$/,
        exclude: /^https?:\/\/accounts\.youtube\.com/,
      },
    ];
  }

  async init() {
    console.log(this.TAG, "Initializing");

    this._injectMainWorldScript();

    this._messageHandler = (e) => this._onInjectMessage(e);
    this.listen(window, "message", this._messageHandler);

    this.listen(window, "yt-navigate-finish", () =>
      this.timer(() => this._onNavigate(), 100),
    );
    this.listen(window, "popstate", () =>
      this.timer(() => this._onNavigate(), 200),
    );

    this._patchHistory();

    if (
      document.readyState === "complete" ||
      document.readyState === "interactive"
    ) {
      this.timer(() => this._onNavigate(), 500);
    } else {
      this.listen(document, "DOMContentLoaded", () =>
        this.timer(() => this._onNavigate(), 500),
      );
    }

    console.log(this.TAG, "Initialized");
  }

  async extract() {
    const videoId = this._getVideoId();
    if (!videoId) return null;

    const scriptData = this._scanScriptTags();
    if (scriptData.playerResponse || scriptData.playerUrl) {
      return {
        videoId,
        formats: [],
        formatSource: "script_tags",
        extra: scriptData,
      };
    }

    return null;
  }

  _injectMainWorldScript() {
    if (this._injected) return;
    this._injected = true;

    const s = document.createElement("script");
    s.src = chrome.runtime.getURL("extractors/sites/youtube/inject.js");
    s.onload = () => s.remove();
    (document.head || document.documentElement).appendChild(s);
    console.log(this.TAG, "inject.js injected into MAIN world");
  }

  _onInjectMessage(e) {
    const MAGIC = "__ytdl_ext__";
    if (!e.data || e.data.type !== MAGIC) return;

    const videoId = this._getVideoId();
    if (!videoId) return;

    const payload = e.data.payload || {};
    const scriptData = this._scanScriptTags();

    const merged = {
      videoId: payload.videoId || videoId,
      playerUrl: payload.playerUrl || scriptData.playerUrl || null,
      visitorData: payload.visitorData || scriptData.visitorData || null,
      sts: payload.sts || scriptData.sts || null,
      apiKey: payload.apiKey || null,
      clientVersion: payload.clientVersion || scriptData.clientVersion || null,
      playerResponse:
        payload.playerResponse || scriptData.playerResponse || null,
      resolvedFormats: payload.resolvedFormats || null,
      formatSource: payload.formatSource || null,
      nSigCode: payload.nSigCode || null,
      cipherCode: payload.cipherCode || null,
      cipherArgName: payload.cipherArgName || null,
      resolveError: payload.resolveError || null,
      loggedIn: payload.loggedIn ?? scriptData.loggedIn ?? null,
      // 2025+ direct cipher/N-sig data from inject.js
      cipherActions: payload.cipherActions || null,
      directCipher: payload.directCipher || false,
      directNSig: payload.directNSig || false,
      extractionErrors: payload.extractionErrors || null,
    };

    console.log(this.TAG, "Received from inject.js:", {
      videoId: merged.videoId,
      resolvedFormats: merged.resolvedFormats
        ? merged.resolvedFormats.length
        : 0,
      formatSource: merged.formatSource,
      hasPlayerResponse: !!merged.playerResponse,
    });

    chrome.runtime.sendMessage({
      action: "VIDEO_DETECTED",
      videoId: merged.videoId,
      url: window.location.href,
      pageData: merged,
    });
  }

  _onNavigate() {
    const videoId = this._getVideoId();
    if (!videoId) return;
    if (videoId === this._lastVideoId) return;
    this._lastVideoId = videoId;

    clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => {
      window.postMessage({ type: "__ytdl_ext__" + "_request" }, "*");

      this.timer(() => {
        const scriptData = this._scanScriptTags();
        if (scriptData.playerResponse || scriptData.playerUrl) {
          chrome.runtime.sendMessage({
            action: "VIDEO_DETECTED",
            videoId: videoId,
            url: window.location.href,
            pageData: scriptData,
          });
        }
      }, 2500);
    }, 500);
  }

  _patchHistory() {
    const self = this;
    const origPush = history.pushState;
    history.pushState = function () {
      origPush.apply(this, arguments);
      setTimeout(() => self._onNavigate(), 200);
    };
    const origReplace = history.replaceState;
    history.replaceState = function () {
      origReplace.apply(this, arguments);
      setTimeout(() => self._onNavigate(), 200);
    };
  }

  _getVideoId() {
    const url = window.location.href;
    let m;
    if ((m = url.match(/[?&]v=([a-zA-Z0-9_-]{11})/))) return m[1];
    if ((m = url.match(/\/shorts\/([a-zA-Z0-9_-]{11})/))) return m[1];
    if ((m = url.match(/\/embed\/([a-zA-Z0-9_-]{11})/))) return m[1];
    if ((m = url.match(/\/live\/([a-zA-Z0-9_-]{11})/))) return m[1];
    if ((m = url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/))) return m[1];
    return null;
  }

  _scanScriptTags() {
    const data = {};

    for (const script of document.querySelectorAll("script:not([src])")) {
      const text = script.textContent;
      if (!text || text.length < 100) continue;

      if (text.includes("ytcfg.set")) {
        let m = text.match(/"STS":(\d{5,})/);
        if (m) data.sts = parseInt(m[1]);

        m = text.match(/"VISITOR_DATA":"([^"]+)"/);
        if (m) data.visitorData = m[1];

        m = text.match(/"PLAYER_JS_URL":"([^"]+)"/);
        if (m) {
          data.playerUrl = m[1];
          if (data.playerUrl && !data.playerUrl.startsWith("http")) {
            data.playerUrl = "https://www.youtube.com" + data.playerUrl;
          }
        }

        m = text.match(/"LOGGED_IN":(true|false)/);
        if (m) data.loggedIn = m[1] === "true";

        m = text.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/);
        if (m) data.clientVersion = m[1];
      }

      if (text.includes("ytInitialPlayerResponse")) {
        const pr = this._extractPlayerResponseFromScript(text);
        if (pr) data.playerResponse = pr;
      }
    }

    return data;
  }

  _extractPlayerResponseFromScript(text) {
    const marker = "ytInitialPlayerResponse";
    const idx = text.indexOf(marker);
    if (idx === -1) return null;

    let eqIdx = text.indexOf("=", idx + marker.length);
    if (eqIdx === -1) return null;

    let startIdx = -1;
    for (let i = eqIdx + 1; i < text.length; i++) {
      if (text[i] === "{") {
        startIdx = i;
        break;
      }
      if (!" \n\r\t".includes(text[i])) break;
    }
    if (startIdx === -1) return null;

    let depth = 0,
      inStr = false,
      strCh = "",
      escaped = false;
    for (let i = startIdx; i < text.length; i++) {
      const c = text[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (c === "\\") {
        escaped = true;
        continue;
      }
      if (inStr) {
        if (c === strCh) inStr = false;
        continue;
      }
      if (c === '"' || c === "'") {
        inStr = true;
        strCh = c;
        continue;
      }
      if (c === "{") depth++;
      if (c === "}") {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(text.substring(startIdx, i + 1));
          } catch (e) {
            return null;
          }
        }
      }
    }
    return null;
  }

  destroy() {
    this._lastVideoId = null;
    clearTimeout(this._debounceTimer);
    super.destroy();
  }
}

if (typeof globalThis !== "undefined") {
  globalThis.YouTubeExtractor = YouTubeExtractor;
}
