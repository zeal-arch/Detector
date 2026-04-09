(function () {
  "use strict";

  const TAG = "[SoundCloud]";
  const processedIds = new Set();
  let cachedClientId = null;
  let detectedCount = 0;

  function notifyBackground(videoData) {
    window.postMessage(
      {
        type: "MAGIC_M3U8_DETECTION",
        source: "SITE_SPECIALIST",
        data: videoData,
      },
      "*",
    );
  }

  async function getClientId() {
    if (cachedClientId) return cachedClientId;

    const scripts = document.querySelectorAll('script[src*="sndcdn.com"]');
    for (const script of scripts) {
      try {
        const resp = await fetch(script.src);
        const text = await resp.text();

        const m = text.match(/client_id\s*[:=]\s*"([a-zA-Z0-9]{32})"/);
        if (m) {
          cachedClientId = m[1];
          console.log(TAG, "Found client_id from bundle");
          return cachedClientId;
        }

        const m2 = text.match(/,client_id:"([a-zA-Z0-9]{32})"/);
        if (m2) {
          cachedClientId = m2[1];
          return cachedClientId;
        }
      } catch (e) {}
    }

    const inlineScripts = document.querySelectorAll("script:not([src])");
    for (const script of inlineScripts) {
      const text = script.textContent || "";
      const m = text.match(/client_id[=:]["']([a-zA-Z0-9]{32})["']/);
      if (m) {
        cachedClientId = m[1];
        return cachedClientId;
      }
    }

    const allScriptSrcs = document.querySelectorAll("script[src]");
    for (const s of allScriptSrcs) {
      const m = s.src.match(/client_id=([a-zA-Z0-9]{32})/);
      if (m) {
        cachedClientId = m[1];
        return cachedClientId;
      }
    }

    return null;
  }

  async function resolveStreamUrl(transcodingUrl) {
    const clientId = await getClientId();
    if (!clientId) {
      console.debug(TAG, "No client_id found, cannot resolve transcoding URL");
      return null;
    }

    const separator = transcodingUrl.includes("?") ? "&" : "?";
    const resolveUrl = `${transcodingUrl}${separator}client_id=${clientId}`;

    try {
      const resp = await fetch(resolveUrl);
      if (!resp.ok) return null;
      const data = await resp.json();
      return data.url || null;
    } catch (e) {
      console.debug(TAG, "Failed to resolve transcoding URL:", e.message);
      return null;
    }
  }

  async function processTrack(track) {
    if (!track || !track.id) return;
    const trackId = String(track.id);
    if (processedIds.has(trackId)) return;

    const transcodings = track.media?.transcodings || [];
    if (transcodings.length === 0) return;

    const hlsTranscoding = transcodings.find(
      (t) =>
        t.format?.protocol === "hls" && t.format?.mime_type?.includes("mpeg"),
    );
    const progressiveTranscoding = transcodings.find(
      (t) => t.format?.protocol === "progressive",
    );
    const anyHls = transcodings.find((t) => t.format?.protocol === "hls");

    const transcoding = hlsTranscoding || progressiveTranscoding || anyHls;
    if (!transcoding?.url) return;

    const streamUrl = await resolveStreamUrl(transcoding.url);
    if (!streamUrl) return;

    processedIds.add(trackId);

    const isHls = transcoding.format?.protocol === "hls";
    const thumbnail =
      track.artwork_url?.replace("-large", "-t500x500") || track.artwork_url;

    const options = {
      customTitle: track.title || document.title.replace(/\s*\|.*$/, ""),
      thumbnail: thumbnail,
      author: track.user?.username || track.user?.permalink,
      stableId: `soundcloud_${trackId}`,
      videoId: trackId,
      platform: "soundcloud",
      isAudio: true,
      duration: track.duration ? Math.round(track.duration / 1000) : null,
      description: track.description,
      formats: [],
    };

    for (const t of transcodings) {
      if (t === transcoding || !t.url) continue;
      const altUrl = await resolveStreamUrl(t.url);
      if (altUrl) {
        options.formats.push({
          url: altUrl,
          quality: t.format?.protocol === "progressive" ? "Direct MP3" : "HLS",
          qualityLabel: `${t.format?.mime_type || "audio"} (${t.format?.protocol || "unknown"})`,
          mimeType: t.format?.mime_type || "audio/mpeg",
          isMuxed: true,
          isVideo: false,
          isAudio: true,
          ext: t.format?.protocol === "progressive" ? "mp3" : "m4a",
        });
      }
    }

    console.log(TAG, `Detected track: ${options.customTitle}`);
    notifyBackground({
      url: streamUrl,
      type: isHls ? "HLS" : "MP3",
      options,
    });
    detectedCount++;
  }

  async function extractFromHydration() {
    const scripts = document.querySelectorAll("script:not([src])");
    for (const script of scripts) {
      const text = script.textContent || "";
      if (!text.includes("__sc_hydration")) continue;

      const m = text.match(/__sc_hydration\s*=\s*(\[[\s\S]*?\]);/);
      if (!m) continue;

      try {
        const data = JSON.parse(m[1]);
        for (const item of data) {
          if (item.hydratable === "sound" && item.data) {
            await processTrack(item.data);
          }

          if (item.hydratable === "playlist" && item.data?.tracks) {
            for (const track of item.data.tracks) {
              if (track.media) await processTrack(track);
            }
          }
        }
        return true;
      } catch (e) {
        console.debug(TAG, "Failed to parse hydration data:", e.message);
      }
    }
    return false;
  }

  function hookNetworkRequests() {
    const origFetch = window.fetch;
    window.fetch = async function (input, init) {
      const response = await origFetch.apply(this, arguments);
      try {
        const url = typeof input === "string" ? input : input?.url || "";

        if (
          url.includes("api-v2.soundcloud.com") &&
          (url.includes("/tracks") || url.includes("/resolve"))
        ) {
          const clone = response.clone();
          clone
            .json()
            .then((data) => {
              if (data?.media?.transcodings) processTrack(data);
              if (data?.tracks) {
                for (const t of data.tracks) {
                  if (t?.media?.transcodings) processTrack(t);
                }
              }
            })
            .catch(() => {});
        }

        if (url.includes("client_id=") && !cachedClientId) {
          const m = url.match(/client_id=([a-zA-Z0-9]{32})/);
          if (m) {
            cachedClientId = m[1];
            console.log(TAG, "Captured client_id from API request");
          }
        }
      } catch (e) {}
      return response;
    };
  }

  async function run() {
    await extractFromHydration();
  }

  hookNetworkRequests();
  setTimeout(run, 1000);
  setTimeout(run, 3000);
  setTimeout(run, 6000);

  let lastUrl = location.href;
  const onNav = () => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      detectedCount = 0;
      setTimeout(run, 1000);
      setTimeout(run, 3000);
    }
  };
  window.addEventListener("popstate", onNav);
  const origPush = history.pushState;
  const origReplace = history.replaceState;
  history.pushState = function () {
    origPush.apply(this, arguments);
    setTimeout(onNav, 100);
  };
  history.replaceState = function () {
    origReplace.apply(this, arguments);
    setTimeout(onNav, 100);
  };

  console.log(TAG, "v2 specialist loaded");
})();
