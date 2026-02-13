(function () {
  "use strict";

  const MAGIC = "__generic_extractor__";
  const seen = new Set();
  const blobMap = new Map();

  function checkUrl(url, extraData = {}) {
    if (!url || typeof url !== "string") return;
    if (seen.has(url)) return;
    if (/\.(m3u8|mpd)(\?|$)/i.test(url)) {
      seen.add(url);
      window.postMessage({ type: MAGIC, url: url, ...extraData }, "*");
    }

    if (/\/video\/|\.(mp4|webm)(\?|$)/i.test(url) && url.length < 500) {
      if (/cdn|media|stream|video|content/i.test(url)) {
        seen.add(url);
        window.postMessage(
          { type: MAGIC, url: url, direct: true, ...extraData },
          "*",
        );
      }
    }
  }

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    checkUrl(url?.toString());
    return origOpen.apply(this, arguments);
  };

  const origFetch = window.fetch;
  window.fetch = function (input) {
    const url = typeof input === "string" ? input : input?.url;
    checkUrl(url);
    return origFetch.apply(this, arguments);
  };

  const origSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    if ((name === "src" || name === "data-src") && typeof value === "string") {
      checkUrl(value);
    }
    return origSetAttribute.call(this, name, value);
  };

  if (typeof MediaSource !== "undefined") {
    const mseDetectedMimeTypes = new Set();

    const origAddSourceBuffer = MediaSource.prototype.addSourceBuffer;
    MediaSource.prototype.addSourceBuffer = function (mimeType) {
      const sb = origAddSourceBuffer.call(this, mimeType);

      if (!mseDetectedMimeTypes.has(mimeType)) {
        mseDetectedMimeTypes.add(mimeType);
        window.postMessage(
          {
            type: MAGIC,
            mseDetected: true,
            mimeType: mimeType,
          },
          "*",
        );
      }

      return sb;
    };
  }

  if (typeof URL !== "undefined" && URL.createObjectURL) {
    const origCreateObjectURL = URL.createObjectURL;
    URL.createObjectURL = function (obj) {
      const blobUrl = origCreateObjectURL.call(this, obj);

      if (obj instanceof Blob || obj instanceof MediaSource) {
        blobMap.set(blobUrl, {
          type: obj.type || "unknown",
          size: obj.size || 0,
          timestamp: Date.now(),
        });

        if (obj instanceof Blob && obj.type && obj.type.startsWith("video")) {
          window.postMessage(
            {
              type: MAGIC,
              blobUrl: blobUrl,
              blobType: obj.type,
              blobSize: obj.size,
              isBlobVideo: true,
            },
            "*",
          );
        }
      }

      return blobUrl;
    };

    const origRevokeObjectURL = URL.revokeObjectURL;
    URL.revokeObjectURL = function (url) {
      blobMap.delete(url);
      return origRevokeObjectURL.call(this, url);
    };
  }

  if (
    typeof AudioContext !== "undefined" ||
    typeof webkitAudioContext !== "undefined"
  ) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const origCreateMediaElementSource =
      AudioCtx.prototype.createMediaElementSource;

    AudioCtx.prototype.createMediaElementSource = function (mediaElement) {

      if (mediaElement && mediaElement.src) {
        checkUrl(mediaElement.src, { webAudioDetected: true });
      }
      return origCreateMediaElementSource.call(this, mediaElement);
    };
  }

  ["HTMLVideoElement", "HTMLAudioElement"].forEach(function (elemType) {
    if (typeof window[elemType] === "undefined") return;

    const proto = window[elemType].prototype;
    const srcDescriptor = Object.getOwnPropertyDescriptor(proto, "src");

    if (srcDescriptor && srcDescriptor.set) {
      const origSet = srcDescriptor.set;
      srcDescriptor.set = function (value) {
        checkUrl(value, { mediaElement: elemType });
        return origSet.call(this, value);
      };
      Object.defineProperty(proto, "src", srcDescriptor);
    }
  });

  console.log(
    "[M3U8 Detector] Enhanced generic network hook initialized (MSE + Blob + WebAudio)",
  );
})();
