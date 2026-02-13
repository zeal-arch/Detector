(function () {
  "use strict";

  const TAG = "[Kick]";
  const processedIds = new Set();
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

  function getChannel() {

    const m = location.pathname.match(/^\/([a-zA-Z0-9_-]+)\/?$/);
    if (
      m &&
      ![
        "categories",
        "following",
        "search",
        "terms",
        "privacy",
        "community-guidelines",
        "dmca",
        "login",
        "register",
      ].includes(m[1].toLowerCase())
    ) {
      return m[1];
    }
    return null;
  }

  function getVideoId() {

    const m = location.pathname.match(/\/video\/([a-f0-9-]+)/i);
    return m ? m[1] : null;
  }

  function getClipId() {

    const params = new URLSearchParams(location.search);
    return params.get("clip") || null;
  }

  async function fetchChannelApi(channel) {
    try {
      const resp = await fetch(`https://kick.com/api/v2/channels/${channel}`, {
        headers: { Accept: "application/json" },
      });
      if (!resp.ok) return null;
      return await resp.json();
    } catch (e) {
      console.debug(TAG, "Channel API error:", e.message);
      return null;
    }
  }

  async function fetchVideoApi(videoId) {
    try {
      const resp = await fetch(`https://kick.com/api/v1/video/${videoId}`, {
        headers: { Accept: "application/json" },
      });
      if (!resp.ok) return null;
      return await resp.json();
    } catch (e) {
      console.debug(TAG, "Video API error:", e.message);
      return null;
    }
  }

  async function extractLive(channel) {
    const id = `live_${channel}`;
    if (processedIds.has(id)) return;

    const data = await fetchChannelApi(channel);
    if (!data) return;

    const livestream = data.livestream;
    if (!livestream || !livestream.is_live) {
      console.debug(TAG, `${channel} is not live`);
      return;
    }

    const hlsUrl = livestream.source || data.playback_url;
    if (!hlsUrl) {
      console.debug(TAG, "No playback URL found for live stream");
      return;
    }

    processedIds.add(id);

    const thumbnail = livestream.thumbnail?.url || data.user?.profile_pic;
    const title = livestream.session_title || `${channel} - Live on Kick`;

    notifyBackground({
      url: hlsUrl,
      type: "HLS",
      options: {
        customTitle: title,
        thumbnail: thumbnail,
        author: data.user?.username || channel,
        stableId: `kick_live_${channel}`,
        videoId: String(livestream.id || channel),
        platform: "kick",
        isLive: true,
        viewCount: livestream.viewer_count,
      },
    });
    detectedCount++;
    console.log(TAG, `Live stream detected: ${title}`);
  }

  async function extractVod(videoId) {
    const id = `vod_${videoId}`;
    if (processedIds.has(id)) return;

    const data = await fetchVideoApi(videoId);
    if (!data) return;

    const hlsUrl = data.source || data.playback_url || data.livestream?.source;
    if (!hlsUrl) {
      console.debug(TAG, "No playback URL found for VOD");
      return;
    }

    processedIds.add(id);

    notifyBackground({
      url: hlsUrl,
      type: "HLS",
      options: {
        customTitle: data.session_title || data.title || `Kick VOD ${videoId}`,
        thumbnail: data.thumbnail?.url,
        author: data.channel?.user?.username,
        stableId: `kick_vod_${videoId}`,
        videoId: videoId,
        platform: "kick",
        duration: data.duration,
        viewCount: data.views,
      },
    });
    detectedCount++;
    console.log(TAG, `VOD detected: ${data.session_title || videoId}`);
  }

  function processApiResponse(data) {
    if (!data || typeof data !== "object") return;

    if (data.livestream?.source && data.livestream.is_live) {
      const channel = data.slug || data.user?.username;
      if (channel && !processedIds.has(`live_${channel}`)) {
        processedIds.add(`live_${channel}`);
        notifyBackground({
          url: data.livestream.source,
          type: "HLS",
          options: {
            customTitle: data.livestream.session_title || `${channel} - Live`,
            thumbnail: data.livestream.thumbnail?.url,
            author: channel,
            stableId: `kick_live_${channel}`,
            platform: "kick",
            isLive: true,
          },
        });
        detectedCount++;
      }
    }

    if (data.source && (data.session_title || data.title) && !data.is_live) {
      const vodId = data.uuid || data.id;
      if (vodId && !processedIds.has(`vod_${vodId}`)) {
        processedIds.add(`vod_${vodId}`);
        notifyBackground({
          url: data.source,
          type: "HLS",
          options: {
            customTitle: data.session_title || data.title,
            thumbnail: data.thumbnail?.url,
            author: data.channel?.user?.username,
            stableId: `kick_vod_${vodId}`,
            platform: "kick",
          },
        });
        detectedCount++;
      }
    }

    if (data.clip_url || data.video_url) {
      const clipUrl = data.clip_url || data.video_url;
      const clipId = data.id || data.clip_id;
      if (clipId && !processedIds.has(`clip_${clipId}`)) {
        processedIds.add(`clip_${clipId}`);
        notifyBackground({
          url: clipUrl,
          type: clipUrl.includes(".m3u8") ? "HLS" : "MP4",
          options: {
            customTitle: data.title || `Kick Clip`,
            thumbnail: data.thumbnail_url || data.thumbnail?.url,
            author: data.channel?.user?.username || data.creator?.username,
            stableId: `kick_clip_${clipId}`,
            platform: "kick",
          },
        });
        detectedCount++;
      }
    }
  }

  function hookNetworkRequests() {
    const origFetch = window.fetch;
    window.fetch = async function (input, init) {
      const response = await origFetch.apply(this, arguments);
      try {
        const url = typeof input === "string" ? input : input?.url || "";
        if (
          url.includes("kick.com/api/") ||
          url.includes("/channels/") ||
          url.includes("/video/")
        ) {
          const clone = response.clone();
          clone
            .json()
            .then((data) => processApiResponse(data))
            .catch(() => {});
        }
      } catch (e) {}
      return response;
    };

    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this._kickUrl = url;
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      const xhr = this;
      if ((this._kickUrl || "").includes("kick.com/api/")) {
        this.addEventListener("load", function () {
          try {
            processApiResponse(JSON.parse(xhr.responseText));
          } catch (e) {}
        });
      }
      return origSend.apply(this, arguments);
    };
  }

  async function run() {
    const videoId = getVideoId();
    const channel = getChannel();

    if (videoId) {
      await extractVod(videoId);
    } else if (channel) {
      await extractLive(channel);
    }
  }

  hookNetworkRequests();
  setTimeout(run, 1500);
  setTimeout(run, 4000);

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
