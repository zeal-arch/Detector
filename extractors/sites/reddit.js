(function () {
  "use strict";

  console.log("[Reddit Specialist v2] Loaded on:", location.href);

  const processedIds = new Set();
  let lastUrl = location.href;

  function notifyBackground(data) {
    window.postMessage(
      {
        type: "MAGIC_M3U8_DETECTION",
        source: "SITE_SPECIALIST",
        data,
      },
      "*",
    );
    window.__SPECIALIST_DETECTED = true;
  }

  function isPostPage(url) {
    return /\/comments\/[a-z0-9]+/i.test(url);
  }

  function extractPostId(url) {
    const m = url.match(/\/comments\/([a-z0-9]+)/i);
    return m ? m[1] : null;
  }

  function extractSubreddit(url) {
    const m = url.match(/\/r\/([^/?#]+)/);
    return m ? m[1] : null;
  }

  async function fetchPostData() {
    try {

      const path = location.pathname.replace(/\/$/, "");
      const jsonUrl = `${location.origin}${path}.json`;
      const resp = await fetch(jsonUrl, {
        headers: { Accept: "application/json" },
      });
      if (!resp.ok) return null;
      return await resp.json();
    } catch (err) {
      console.debug("[Reddit] JSON fetch failed:", err);
      return null;
    }
  }

  function getListing(postData) {

    return postData?.[0]?.data?.children?.[0]?.data || null;
  }

  function buildOptions(listing, postId) {
    const preview = listing.preview?.images?.[0]?.source?.url?.replace(
      /&amp;/g,
      "&",
    );
    return {
      customTitle: listing.title || `Reddit Post ${postId}`,
      stableId: `reddit_${postId}`,
      postId,
      author: listing.author || null,
      authorUrl: listing.author
        ? `https://www.reddit.com/user/${listing.author}`
        : null,
      subreddit: listing.subreddit || extractSubreddit(location.href),
      thumbnail: preview || cleanThumbnail(listing.thumbnail),
      platform: "reddit",
      pageUrl: location.href,
    };
  }

  function cleanThumbnail(thumb) {
    if (!thumb || thumb === "self" || thumb === "default" || thumb === "nsfw")
      return null;
    return thumb;
  }

  function extractVideo(listing, postId) {
    const media =
      listing.media?.reddit_video || listing.secure_media?.reddit_video;
    if (!media) return null;

    const opts = buildOptions(listing, postId);
    opts.duration = formatDuration(media.duration);
    opts.isGif = media.is_gif || false;

    if (media.fallback_url) {
      const fallback = media.fallback_url.split("?")[0];
      const formats = buildMP4Formats(fallback, media, opts.isGif);

      notifyBackground({
        url: fallback,
        type: "MP4",
        videoId: postId,
        options: {
          ...opts,
          quality: formats[0]?.quality || "Direct",
          formats,
        },
      });
      return true;
    }

    if (media.hls_url) {
      notifyBackground({
        url: media.hls_url,
        type: "HLS",
        videoId: postId,
        options: opts,
      });
      return true;
    }

    return null;
  }

  function buildMP4Formats(fallbackUrl, media, isGif) {
    const formats = [];

    const actualHeight = media.height || 0;

    const baseUrl = fallbackUrl.replace(/DASH_\d+\.mp4.*$/, "");

    const allQualities = [1080, 720, 480, 360, 240];
    const qualities =
      actualHeight > 0
        ? allQualities.filter((q) => q <= actualHeight)
        : allQualities;

    if (actualHeight > 0 && !allQualities.includes(actualHeight)) {
      qualities.unshift(actualHeight);
    }

    if (qualities.length === 0) {
      const qMatch = fallbackUrl.match(/DASH_(\d+)\.mp4/);
      qualities.push(qMatch ? parseInt(qMatch[1]) : 720);
    }

    for (const q of qualities) {
      formats.push({
        url: `${baseUrl}DASH_${q}.mp4`,
        quality: `${q}p`,
        qualityLabel: `${q}p`,
        mimeType: "video/mp4",
        width: 0,
        height: q,
        isVideo: true,
        isMuxed: isGif,
        ext: "mp4",
      });
    }

    if (!isGif) {

      formats.push({
        url: `${baseUrl}DASH_AUDIO_128.mp4`,
        quality: "Audio",
        qualityLabel: "Audio (128kbps)",
        mimeType: "audio/mp4",
        isVideo: false,
        isAudio: true,
        isMuxed: false,
        ext: "mp4",
      });
    }

    return formats;
  }

  function extractImage(listing, postId) {
    const opts = buildOptions(listing, postId);

    if (listing.is_gallery && listing.media_metadata) {
      return extractGallery(listing, postId, opts);
    }

    const url = listing.url || listing.url_overridden_by_dest || "";
    const hint = listing.post_hint || "";

    if (hint === "image" || /\.(jpg|jpeg|png|gif|webp)(\?|$)/i.test(url)) {
      const ext = getImageExt(url);
      const formats = [
        {
          url: url,
          quality: "Original",
          qualityLabel: "Original",
          mimeType: `image/${ext === "jpg" ? "jpeg" : ext}`,
          isVideo: false,
          isImage: true,
          isMuxed: true,
          ext: ext,
        },
      ];

      const previews = listing.preview?.images?.[0]?.resolutions || [];
      for (const p of previews) {
        const pUrl = (p.url || "").replace(/&amp;/g, "&");
        if (pUrl && p.width) {
          formats.push({
            url: pUrl,
            quality: `${p.width}w`,
            qualityLabel: `${p.width}×${p.height}`,
            mimeType: "image/jpeg",
            width: p.width,
            height: p.height,
            isVideo: false,
            isImage: true,
            isMuxed: true,
            ext: "jpg",
          });
        }
      }

      formats.sort((a, b) => {
        if (a.quality === "Original") return -1;
        if (b.quality === "Original") return 1;
        return (b.width || 0) - (a.width || 0);
      });

      notifyBackground({
        url: url,
        type: "MP4",
        videoId: postId,
        options: {
          ...opts,
          quality: "Original",
          formats,
        },
      });
      return true;
    }

    return false;
  }

  function extractGallery(listing, postId, opts) {
    const metadata = listing.media_metadata || {};
    const galleryItems = listing.gallery_data?.items || [];
    const formats = [];

    for (const item of galleryItems) {
      const mediaId = item.media_id;
      const media = metadata[mediaId];
      if (!media || media.status !== "valid") continue;

      const source = media.s;
      if (!source) continue;

      const imgUrl = (source.u || source.gif || "").replace(/&amp;/g, "&");
      if (!imgUrl) continue;

      const ext = media.m ? media.m.split("/")[1] || "jpg" : "jpg";
      const caption = item.caption || `Image ${formats.length + 1}`;

      formats.push({
        url: imgUrl,
        quality: `${caption}`,
        qualityLabel: `${caption} (${source.x}×${source.y})`,
        mimeType: media.m || "image/jpeg",
        width: source.x || 0,
        height: source.y || 0,
        isVideo: false,
        isImage: true,
        isMuxed: true,
        ext: ext === "jpeg" ? "jpg" : ext,
      });
    }

    if (formats.length === 0) return false;

    opts.customTitle = (opts.customTitle || "") + ` (${formats.length} images)`;

    notifyBackground({
      url: formats[0].url,
      type: "MP4",
      videoId: postId,
      options: {
        ...opts,
        quality: `${formats.length} images`,
        formats,
      },
    });
    return true;
  }

  function getImageExt(url) {
    const m = url.match(/\.(jpg|jpeg|png|gif|webp)/i);
    return m ? m[1].toLowerCase().replace("jpeg", "jpg") : "jpg";
  }

  function extractCrosspost(listing, postId) {
    const cross = listing.crosspost_parent_list?.[0];
    if (!cross) return false;

    if (extractVideo(cross, postId)) return true;
    if (extractImage(cross, postId)) return true;
    return false;
  }

  async function extract() {
    const url = location.href;

    if (!isPostPage(url)) {
      console.debug("[Reddit] Not a post page, skipping");
      return;
    }

    const postId = extractPostId(url);
    if (!postId || processedIds.has(postId)) return;

    console.log("[Reddit] Extracting post:", postId);

    const postData = await fetchPostData();
    if (!postData) {
      console.debug("[Reddit] Could not fetch post JSON");
      return;
    }

    const listing = getListing(postData);
    if (!listing) {
      console.debug("[Reddit] No listing data in JSON");
      return;
    }

    processedIds.add(postId);

    if (extractVideo(listing, postId)) return;
    if (extractImage(listing, postId)) return;
    if (extractCrosspost(listing, postId)) return;

    const embedUrl = listing.url_overridden_by_dest || listing.url || "";
    if (
      embedUrl &&
      (embedUrl.includes("youtube.com") ||
        embedUrl.includes("youtu.be") ||
        embedUrl.includes("twitch.tv") ||
        embedUrl.includes("streamable.com"))
    ) {
      console.log("[Reddit] External video embed:", embedUrl);

    }

    console.debug("[Reddit] No downloadable content found for post", postId);
  }

  function formatDuration(seconds) {
    if (!seconds) return null;
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  window.__SPECIALIST_DETECTED = false;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () =>
      setTimeout(extract, 300),
    );
  } else {
    setTimeout(extract, 200);
  }
  setTimeout(extract, 1500);

  const origPush = history.pushState;
  const origReplace = history.replaceState;

  history.pushState = function (...args) {
    origPush.apply(this, args);
    setTimeout(onNav, 200);
  };
  history.replaceState = function (...args) {
    origReplace.apply(this, args);
    setTimeout(onNav, 200);
  };
  window.addEventListener("popstate", () => setTimeout(onNav, 200));

  function onNav() {
    const currentUrl = location.href;
    if (currentUrl !== lastUrl) {
      lastUrl = currentUrl;

      processedIds.clear();
      setTimeout(extract, 300);
    }
  }

  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      onNav();
    }
  }).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  console.log("[Reddit Specialist v2] Initialized");
})();
