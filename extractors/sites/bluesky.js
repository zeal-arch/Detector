(function () {
  "use strict";

  const TAG = "[Bluesky]";
  const processedIds = new Set();
  const BSKY_API = "https://public.api.bsky.app/xrpc";
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

  function parsePostUrl() {

    const m = location.pathname.match(/\/profile\/([^/]+)\/post\/([a-z0-9]+)/i);
    if (m) return { handle: m[1], rkey: m[2] };
    return null;
  }

  async function resolveHandle(handle) {

    if (handle.startsWith("did:")) return handle;
    try {
      const resp = await fetch(
        `${BSKY_API}/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`,
      );
      if (!resp.ok) return null;
      const data = await resp.json();
      return data.did || null;
    } catch (e) {
      console.debug(TAG, "Failed to resolve handle:", e.message);
      return null;
    }
  }

  async function getPostThread(uri) {
    try {
      const resp = await fetch(
        `${BSKY_API}/app.bsky.feed.getPostThread?uri=${encodeURIComponent(uri)}&depth=0`,
      );
      if (!resp.ok) return null;
      return await resp.json();
    } catch (e) {
      console.debug(TAG, "Failed to get post thread:", e.message);
      return null;
    }
  }

  function extractVideoFromPost(post) {
    if (!post?.record && !post?.value) return null;
    const record = post.record || post.value;
    const embed = record?.embed || post.embed;
    const author = post.author;

    if (embed?.$type === "app.bsky.embed.video" || embed?.video) {
      const video = embed.video || embed;
      return {
        did: author?.did,
        cid: video.ref?.$link || video.cid || video.ref?.cid,
        mimeType: video.mimeType || "video/mp4",
        size: video.size,
        aspectRatio: embed.aspectRatio,
        alt: embed.alt,
        author: author,
        text: record?.text,
      };
    }

    if (embed?.$type === "app.bsky.embed.recordWithMedia") {
      const media = embed.media;
      if (media?.$type === "app.bsky.embed.video" || media?.video) {
        const video = media.video || media;
        return {
          did: author?.did,
          cid: video.ref?.$link || video.cid,
          mimeType: video.mimeType || "video/mp4",
          size: video.size,
          aspectRatio: media.aspectRatio,
          alt: media.alt,
          author: author,
          text: record?.text,
        };
      }
    }

    return null;
  }

  function extractVideoFromView(post) {

    const embed = post?.embed;
    const author = post?.author;

    if (embed?.$type === "app.bsky.embed.video#view") {
      return {
        playlist: embed.playlist,
        thumbnail: embed.thumbnail,
        aspectRatio: embed.aspectRatio,
        alt: embed.alt,
        cid: embed.cid,
        author: author,
        text: post?.record?.text,
      };
    }

    if (embed?.$type === "app.bsky.embed.recordWithMedia#view") {
      const media = embed.media;
      if (media?.$type === "app.bsky.embed.video#view") {
        return {
          playlist: media.playlist,
          thumbnail: media.thumbnail,
          aspectRatio: media.aspectRatio,
          cid: media.cid,
          author: author,
          text: post?.record?.text,
        };
      }
    }

    return null;
  }

  function sendVideo(videoData, postInfo) {
    const id = videoData.cid || videoData.playlist || `bsky_${Date.now()}`;
    if (processedIds.has(id)) return;
    processedIds.add(id);

    let videoUrl = null;
    let videoType = "MP4";

    if (videoData.playlist) {

      videoUrl = videoData.playlist;
      videoType = "HLS";
    } else if (videoData.did && videoData.cid) {

      videoUrl = `https://video.bsky.app/watch/${videoData.did}/${videoData.cid}/playlist.m3u8`;
      videoType = "HLS";
    }

    if (!videoUrl) return;

    const author = videoData.author;
    const displayName = author?.displayName || author?.handle || "";
    const handle = author?.handle || "";
    const text = videoData.text || "";
    const title = text.substring(0, 80) || `Bluesky post by @${handle}`;

    notifyBackground({
      url: videoUrl,
      type: videoType,
      options: {
        customTitle: title,
        thumbnail: videoData.thumbnail,
        author: displayName || handle,
        stableId: `bluesky_${id}`,
        videoId: id,
        platform: "bluesky",
        description: text,
      },
    });
    detectedCount++;
    console.log(TAG, `Detected video: ${title.substring(0, 50)}`);
  }

  async function extractFromApi() {
    const postInfo = parsePostUrl();
    if (!postInfo) return;

    const did = await resolveHandle(postInfo.handle);
    if (!did) return;

    const uri = `at://${did}/app.bsky.feed.post/${postInfo.rkey}`;
    const thread = await getPostThread(uri);
    if (!thread?.thread?.post) return;

    const post = thread.thread.post;

    const viewVideo = extractVideoFromView(post);
    if (viewVideo) {
      sendVideo(viewVideo, postInfo);
      return;
    }

    const recordVideo = extractVideoFromPost(post);
    if (recordVideo) {
      if (!recordVideo.did) recordVideo.did = did;
      recordVideo.author = post.author;
      sendVideo(recordVideo, postInfo);
    }
  }

  function processApiData(data) {
    if (!data || typeof data !== "object") return;

    const posts = [];
    findPosts(data, posts);
    for (const post of posts) {
      const video = extractVideoFromView(post) || extractVideoFromPost(post);
      if (video) {
        if (!video.author) video.author = post.author;
        sendVideo(video);
      }
    }
  }

  function findPosts(obj, results, depth) {
    if (!obj || typeof obj !== "object" || (depth || 0) > 10) return;
    const d = (depth || 0) + 1;

    if (obj.author?.did && (obj.record || obj.embed)) {
      results.push(obj);
      return;
    }

    if (Array.isArray(obj)) {
      for (const item of obj) findPosts(item, results, d);
    } else {
      for (const key of Object.keys(obj)) {
        try {
          findPosts(obj[key], results, d);
        } catch (e) {}
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
          url.includes("bsky.") &&
          (url.includes("/xrpc/") ||
            url.includes("/feed") ||
            url.includes("/post"))
        ) {
          const clone = response.clone();
          clone
            .json()
            .then((data) => processApiData(data))
            .catch(() => {});
        }
      } catch (e) {}
      return response;
    };
  }

  function scanForHlsUrls() {
    if (detectedCount > 0) return;

    const scripts = document.querySelectorAll("script:not([src])");
    for (const script of scripts) {
      const text = script.textContent || "";
      const hlsMatches = text.matchAll(
        /(https?:\/\/video\.bsky\.app\/watch\/[^"'\s]+\.m3u8[^"'\s]*)/g,
      );
      for (const m of hlsMatches) {
        const url = m[1];
        if (!processedIds.has(url)) {
          processedIds.add(url);
          notifyBackground({
            url: url,
            type: "HLS",
            options: {
              customTitle:
                document.title.replace(/\s*[-|].*$/, "").trim() ||
                "Bluesky Video",
              thumbnail: document.querySelector('meta[property="og:image"]')
                ?.content,
              platform: "bluesky",
              stableId: `bluesky_${Date.now()}`,
            },
          });
          detectedCount++;
        }
      }
    }

    const videos = document.querySelectorAll("video");
    for (const v of videos) {
      const src = v.src || v.currentSrc;
      if (src && src.includes(".m3u8") && !processedIds.has(src)) {
        processedIds.add(src);
        notifyBackground({
          url: src,
          type: "HLS",
          options: {
            customTitle:
              document.title.replace(/\s*[-|].*$/, "").trim() ||
              "Bluesky Video",
            platform: "bluesky",
            stableId: `bluesky_${Date.now()}`,
          },
        });
        detectedCount++;
      }
    }
  }

  async function run() {
    await extractFromApi();
    if (detectedCount === 0) scanForHlsUrls();
  }

  hookNetworkRequests();
  setTimeout(run, 1500);
  setTimeout(run, 4000);

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
