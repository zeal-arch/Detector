(function () {
  "use strict";

  const TAG = "[Twitch]";
  const processedIds = new Set();
  const TWITCH_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";
  const GQL_URL = "https://gql.twitch.tv/gql";
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

  function extractChannel(url) {
    const m = url.match(/twitch\.tv\/([a-zA-Z0-9_]+)(?:$|[/?#])/);
    if (
      m &&
      ![
        "videos",
        "clips",
        "directory",
        "settings",
        "search",
        "downloads",
        "subscriptions",
        "inventory",
        "wallet",
        "drops",
      ].includes(m[1])
    ) {
      return m[1];
    }
    return null;
  }

  function extractVodId(url) {
    const m = url.match(/twitch\.tv\/videos\/(\d+)/);
    return m ? m[1] : null;
  }

  function extractClipSlug(url) {
    let m = url.match(/twitch\.tv\/[^/]+\/clip\/([A-Za-z0-9_-]+)/);
    if (m) return m[1];
    m = url.match(/clips\.twitch\.tv\/([A-Za-z0-9_-]+)/);
    if (m) return m[1];
    return null;
  }

  function extractMeta() {
    const meta = { title: null, thumbnail: null };
    try {
      const ogTitle = document.querySelector('meta[property="og:title"]');
      if (ogTitle) meta.title = ogTitle.content;
      const ogImage = document.querySelector('meta[property="og:image"]');
      if (ogImage) meta.thumbnail = ogImage.content;
    } catch (e) {}
    return meta;
  }

  async function gqlQuery(body) {
    try {
      const resp = await fetch(GQL_URL, {
        method: "POST",
        headers: {
          "Client-Id": TWITCH_CLIENT_ID,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!resp.ok) return null;
      return await resp.json();
    } catch (e) {
      console.debug(TAG, "GQL error:", e.message);
      return null;
    }
  }

  async function extractLive(channel) {
    const id = `live_${channel}`;
    if (processedIds.has(id)) return;

    const data = await gqlQuery({
      operationName: "PlaybackAccessToken",
      variables: {
        isLive: true,
        login: channel,
        isVod: false,
        vodID: "",
        playerType: "site",
        platform: "web",
      },
      extensions: {
        persistedQuery: {
          version: 1,
          sha256Hash:
            "3093517e37e4f4cb48906155bcd02f85e52e5f5cb03ddb43e0cba5e3cbe2ecdc",
        },
      },
    });

    const token = data?.data?.streamPlaybackAccessToken;
    if (!token) {
      console.debug(TAG, "No playback token for live channel:", channel);

      return await extractLiveFallback(channel);
    }

    const hlsUrl =
      `https://usher.ttvnw.net/api/channel/hls/${channel}.m3u8` +
      `?token=${encodeURIComponent(token.value)}` +
      `&sig=${token.signature}` +
      `&allow_source=true&allow_audio_only=true` +
      `&fast_bread=true&p=${Math.floor(Math.random() * 999999)}`;

    processedIds.add(id);
    const meta = extractMeta();

    notifyBackground({
      url: hlsUrl,
      type: "HLS",
      options: {
        customTitle: meta.title || `${channel} - Live Stream`,
        stableId: `twitch_live_${channel}`,
        author: channel,
        authorUrl: `https://www.twitch.tv/${channel}`,
        thumbnail: meta.thumbnail,
        isLive: true,
        platform: "twitch",
      },
    });
    detectedCount++;
  }

  async function extractLiveFallback(channel) {
    const id = `live_${channel}`;
    if (processedIds.has(id)) return;

    const data = await gqlQuery([
      {
        operationName: "PlaybackAccessToken_Template",
        query: `query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!) {
        streamPlaybackAccessToken(channelName: $login, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) {
          value signature __typename
        }
        videoPlaybackAccessToken(id: $vodID, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isVod) {
          value signature __typename
        }
      }`,
        variables: {
          isLive: true,
          login: channel,
          isVod: false,
          vodID: "",
          playerType: "site",
        },
      },
    ]);

    const result = Array.isArray(data) ? data[0] : data;
    const token = result?.data?.streamPlaybackAccessToken;
    if (!token) return;

    const hlsUrl =
      `https://usher.ttvnw.net/api/channel/hls/${channel}.m3u8` +
      `?token=${encodeURIComponent(token.value)}` +
      `&sig=${token.signature}` +
      `&allow_source=true&allow_audio_only=true` +
      `&p=${Math.floor(Math.random() * 999999)}`;

    processedIds.add(id);
    const meta = extractMeta();

    notifyBackground({
      url: hlsUrl,
      type: "HLS",
      options: {
        customTitle: meta.title || `${channel} - Live Stream`,
        stableId: `twitch_live_${channel}`,
        author: channel,
        authorUrl: `https://www.twitch.tv/${channel}`,
        thumbnail: meta.thumbnail,
        isLive: true,
        platform: "twitch",
      },
    });
    detectedCount++;
  }

  async function extractVod(vodId) {
    const id = `vod_${vodId}`;
    if (processedIds.has(id)) return;

    const data = await gqlQuery({
      operationName: "PlaybackAccessToken",
      variables: {
        isLive: false,
        login: "",
        isVod: true,
        vodID: vodId,
        playerType: "site",
        platform: "web",
      },
      extensions: {
        persistedQuery: {
          version: 1,
          sha256Hash:
            "3093517e37e4f4cb48906155bcd02f85e52e5f5cb03ddb43e0cba5e3cbe2ecdc",
        },
      },
    });

    const token = data?.data?.videoPlaybackAccessToken;
    if (!token) {
      console.debug(TAG, "No playback token for VOD:", vodId);
      return;
    }

    const hlsUrl =
      `https://usher.ttvnw.net/vod/${vodId}.m3u8` +
      `?token=${encodeURIComponent(token.value)}` +
      `&sig=${token.signature}` +
      `&allow_source=true&allow_audio_only=true` +
      `&p=${Math.floor(Math.random() * 999999)}`;

    processedIds.add(id);
    const meta = extractMeta();
    const channel = extractChannel(location.href);

    notifyBackground({
      url: hlsUrl,
      type: "HLS",
      options: {
        customTitle: meta.title || `Twitch VOD ${vodId}`,
        stableId: `twitch_vod_${vodId}`,
        vodId: vodId,
        author: channel,
        authorUrl: channel ? `https://www.twitch.tv/${channel}` : null,
        thumbnail: meta.thumbnail,
        platform: "twitch",
      },
    });
    detectedCount++;
  }

  async function extractClip(slug) {
    const id = `clip_${slug}`;
    if (processedIds.has(id)) return;

    const data = await gqlQuery([
      {
        operationName: "ClipSource",
        variables: { slug: slug },
        extensions: {
          persistedQuery: {
            version: 1,
            sha256Hash:
              "36b89d2507fce29e5ca551df756d27c1cfe079e2609642b4c7b97f736d7c38d2",
          },
        },
      },
    ]);

    const result = Array.isArray(data) ? data[0] : data;
    const clip = result?.data?.clip;
    if (!clip) {
      console.debug(TAG, "No clip data for:", slug);
      return await extractClipFallback(slug);
    }

    const qualities = clip.videoQualities || [];
    const meta = extractMeta();
    const channel =
      clip.broadcaster?.displayName || extractChannel(location.href);

    if (qualities.length > 0) {

      qualities.sort(
        (a, b) => parseInt(b.quality || 0) - parseInt(a.quality || 0),
      );
      const best = qualities[0];

      const options = {
        customTitle: clip.title || meta.title || `Twitch Clip ${slug}`,
        stableId: `twitch_clip_${slug}`,
        clipSlug: slug,
        author: channel,
        authorUrl: channel ? `https://www.twitch.tv/${channel}` : null,
        thumbnail: clip.thumbnailURL || meta.thumbnail,
        platform: "twitch",
        formats: qualities.slice(1).map((q) => ({
          url: q.sourceURL,
          quality: `${q.quality}p`,
          qualityLabel: `${q.quality}p${q.frameRate ? ` ${q.frameRate}fps` : ""}`,
          mimeType: "video/mp4",
          isMuxed: true,
          isVideo: true,
          ext: "mp4",
        })),
      };

      processedIds.add(id);
      notifyBackground({
        url: best.sourceURL,
        type: "MP4",
        options: {
          ...options,
          quality: `${best.quality}p`,
          qualityLabel: `${best.quality}p`,
        },
      });
      detectedCount++;
    } else if (clip.playbackAccessToken) {

      const videoUrl = `https://production.assets.clips.twitchcdn.net/${clip.playbackAccessToken.value}.mp4`;
      processedIds.add(id);
      notifyBackground({
        url: videoUrl,
        type: "MP4",
        options: {
          customTitle: clip.title || meta.title || `Twitch Clip ${slug}`,
          stableId: `twitch_clip_${slug}`,
          author: channel,
          thumbnail: clip.thumbnailURL || meta.thumbnail,
          platform: "twitch",
        },
      });
      detectedCount++;
    }
  }

  async function extractClipFallback(slug) {

    const data = await gqlQuery([
      {
        operationName: "ClipsChatCard",
        variables: { slug: slug },
        extensions: {
          persistedQuery: {
            version: 1,
            sha256Hash:
              "25dabf0e2f3ca12e9ee76c2ea7246a39cfce7c075024f4dadd40e520a5eb0ba6",
          },
        },
      },
    ]);

    const result = Array.isArray(data) ? data[0] : data;
    const clip = result?.data?.clip;
    if (!clip?.url && !clip?.embedURL) return;

    const scripts = document.querySelectorAll("script:not([src])");
    for (const script of scripts) {
      const text = script.textContent || "";
      const mp4Match = text.match(
        /"(https?:\/\/[^"]*clips-media-assets[^"]*\.mp4[^"]*)"/,
      );
      if (mp4Match) {
        processedIds.add(`clip_${slug}`);
        notifyBackground({
          url: mp4Match[1].replace(/\\\//g, "/"),
          type: "MP4",
          options: {
            customTitle: clip.title || `Twitch Clip ${slug}`,
            stableId: `twitch_clip_${slug}`,
            thumbnail: clip.thumbnailURL,
            platform: "twitch",
          },
        });
        detectedCount++;
        return;
      }
    }
  }

  function processGqlResponse(data) {
    if (!data || typeof data !== "object") return;
    const items = Array.isArray(data) ? data : [data];
    for (const item of items) {

      const streamToken = item?.data?.streamPlaybackAccessToken;
      if (streamToken) {
        const channel = extractChannel(location.href);
        if (channel && !processedIds.has(`live_${channel}`)) {
          const hlsUrl =
            `https://usher.ttvnw.net/api/channel/hls/${channel}.m3u8` +
            `?token=${encodeURIComponent(streamToken.value)}&sig=${streamToken.signature}` +
            `&allow_source=true&allow_audio_only=true&p=${Math.floor(Math.random() * 999999)}`;
          processedIds.add(`live_${channel}`);
          const meta = extractMeta();
          notifyBackground({
            url: hlsUrl,
            type: "HLS",
            options: {
              customTitle: meta.title || `${channel} - Live`,
              stableId: `twitch_live_${channel}`,
              author: channel,
              thumbnail: meta.thumbnail,
              isLive: true,
              platform: "twitch",
            },
          });
          detectedCount++;
        }
      }

      const clip = item?.data?.clip;
      if (clip?.videoQualities?.length) {
        const slug = extractClipSlug(location.href);
        if (slug && !processedIds.has(`clip_${slug}`)) {
          const best = clip.videoQualities.sort(
            (a, b) => parseInt(b.quality || 0) - parseInt(a.quality || 0),
          )[0];
          processedIds.add(`clip_${slug}`);
          notifyBackground({
            url: best.sourceURL,
            type: "MP4",
            options: {
              customTitle: clip.title || `Twitch Clip`,
              stableId: `twitch_clip_${slug}`,
              author: clip.broadcaster?.displayName,
              thumbnail: clip.thumbnailURL,
              platform: "twitch",
            },
          });
          detectedCount++;
        }
      }
    }
  }

  function hookNetworkRequests() {
    const origFetch = window.fetch;
    window.fetch = async function (input, init) {
      const response = await origFetch.apply(this, arguments);
      try {
        const url = typeof input === "string" ? input : input?.url || "";
        if (url.includes("gql.twitch.tv/gql")) {
          const clone = response.clone();
          clone
            .json()
            .then((data) => processGqlResponse(data))
            .catch(() => {});
        }
      } catch (e) {}
      return response;
    };

    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this._twUrl = url;
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      const xhr = this;
      if ((this._twUrl || "").includes("gql.twitch.tv")) {
        this.addEventListener("load", function () {
          try {
            processGqlResponse(JSON.parse(xhr.responseText));
          } catch (e) {}
        });
      }
      return origSend.apply(this, arguments);
    };
  }

  async function run() {
    const url = location.href;
    const vodId = extractVodId(url);
    const clipSlug = extractClipSlug(url);
    const channel = extractChannel(url);

    if (vodId) {
      await extractVod(vodId);
    } else if (clipSlug) {
      await extractClip(clipSlug);
    } else if (channel && !url.includes("/videos") && !url.includes("/clip")) {
      await extractLive(channel);
    }
  }

  hookNetworkRequests();
  run();
  setTimeout(run, 2000);
  setTimeout(run, 5000);

  let lastUrl = location.href;
  const onNav = () => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      detectedCount = 0;
      setTimeout(run, 500);
      setTimeout(run, 2000);
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
