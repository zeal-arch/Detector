(function () {
  "use strict";

  const SITE_ID = "northeast-news";

  if (window.__SITE_SPECIALIST_LOADED === SITE_ID) return;
  window.__SITE_SPECIALIST_LOADED = SITE_ID;

  let lastProcessedUrl = "";
  const sentUrls = new Set();

  function log(...args) {
    console.log(`[Specialist][${SITE_ID}]`, ...args);
  }

  function sendToBackground(videos) {
    const fresh = videos.filter((v) => !sentUrls.has(v.url));
    if (fresh.length === 0) return;
    fresh.forEach((v) => sentUrls.add(v.url));

    window.postMessage(
      {
        type: "LALHLIMPUII_JAHAU_DETECTED",
        source: SITE_ID,
        data: { videos: fresh },
      },
      "*",
    );
    log(`Sent ${fresh.length} media items`);
  }

  function getTitle() {
    const el = document.querySelector("h1, .entry-title, .post-title, .title");
    return (el && el.textContent.trim()) || document.title;
  }

  function extFromUrl(url, fallback) {
    try {
      return url.split(".").pop().split("?")[0] || fallback;
    } catch {
      return fallback;
    }
  }

  function resolveEmbedUrl(src) {
    if (!src) return null;
    if (src.includes("youtube.com/embed/")) {
      const id = src.match(/embed\/([^?/]+)/);
      return id ? `https://www.youtube.com/watch?v=${id[1]}` : null;
    }
    if (src.includes("youtube.com/watch")) return src;
    if (src.includes("youtu.be/")) {
      const id = src.match(/youtu\.be\/([^?/]+)/);
      return id ? `https://www.youtube.com/watch?v=${id[1]}` : null;
    }
    if (src.includes("vimeo.com/")) {
      const id = src.match(/vimeo\.com\/(?:video\/)?(\d+)/);
      return id ? `https://vimeo.com/${id[1]}` : null;
    }
    if (src.includes("dailymotion.com/embed/video/")) {
      const id = src.match(/embed\/video\/([^?/]+)/);
      return id ? `https://www.dailymotion.com/video/${id[1]}` : null;
    }
    return null;
  }

  function extractMediaContent() {
    const videos = [];
    const title = getTitle();

    for (const meta of document.querySelectorAll(
      'meta[property="og:video"], meta[property="og:video:url"], meta[property="og:video:secure_url"]',
    )) {
      const url = meta.content;
      if (url && url.startsWith("http")) {
        const resolved = resolveEmbedUrl(url) || url;
        videos.push({
          url: resolved,
          quality: "embed",
          format: "embed",
          title,
          extractor: SITE_ID,
        });
      }
    }

    for (const iframe of document.querySelectorAll(
      "figure.wp-block-embed iframe, .wp-block-embed__wrapper iframe",
    )) {
      const embedUrl = resolveEmbedUrl(iframe.src);
      if (embedUrl)
        videos.push({
          url: embedUrl,
          quality: "embed",
          format: "embed",
          title: title + " (Embed)",
          extractor: SITE_ID,
        });
    }

    for (const block of document.querySelectorAll(".wp-block-video video")) {
      if (block.src)
        videos.push({
          url: block.src,
          quality: "auto",
          format: extFromUrl(block.src, "mp4"),
          title,
          extractor: SITE_ID,
        });
    }

    for (const block of document.querySelectorAll(".wp-block-audio audio")) {
      if (block.src)
        videos.push({
          url: block.src,
          quality: "audio",
          format: extFromUrl(block.src, "mp3"),
          title: title + " (Audio)",
          extractor: SITE_ID,
        });
    }

    for (const video of document.querySelectorAll("video")) {
      if (video.src)
        videos.push({
          url: video.src,
          quality: "auto",
          format: extFromUrl(video.src, "mp4"),
          title,
          extractor: SITE_ID,
        });
    }
    for (const audio of document.querySelectorAll("audio")) {
      if (audio.src)
        videos.push({
          url: audio.src,
          quality: "audio",
          format: extFromUrl(audio.src, "mp3"),
          title: title + " (Audio)",
          extractor: SITE_ID,
        });
    }

    for (const iframe of document.querySelectorAll(
      'iframe[src*="youtube"], iframe[src*="youtu.be"], iframe[src*="vimeo"], iframe[src*="dailymotion"]',
    )) {
      const embedUrl = resolveEmbedUrl(iframe.src);
      if (embedUrl)
        videos.push({
          url: embedUrl,
          quality: "embed",
          format: "embed",
          title: title + " (Embed)",
          extractor: SITE_ID,
        });
    }

    const article = document.querySelector(
      "article, .entry-content, .post-content, .content",
    );
    if (article) {
      for (const link of article.querySelectorAll("a[href]")) {
        const href = link.href;
        const ytMatch = href.match(
          /(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]+)/,
        );
        if (ytMatch) {
          videos.push({
            url: `https://www.youtube.com/watch?v=${ytMatch[1]}`,
            quality: "embed",
            format: "embed",
            title: title + " (YouTube)",
            extractor: SITE_ID,
          });
          continue;
        }
        const vimeoMatch = href.match(/vimeo\.com\/(\d+)/);
        if (vimeoMatch) {
          videos.push({
            url: `https://vimeo.com/${vimeoMatch[1]}`,
            quality: "embed",
            format: "embed",
            title: title + " (Vimeo)",
            extractor: SITE_ID,
          });
          continue;
        }
        if (/\.(?:mp4|m3u8|mp3|m4a|webm|ogg)(\?|$)/i.test(href)) {
          const isAudio = /\.(?:mp3|m4a|ogg)(\?|$)/i.test(href);
          videos.push({
            url: href,
            quality: isAudio ? "audio" : "auto",
            format: extFromUrl(href, "mp4"),
            title: link.textContent.trim() || title,
            extractor: SITE_ID,
          });
        }
      }

      for (const link of article.querySelectorAll(
        'a[href*=".mp4"], a[href*=".m3u8"], a[href*=".mp3"]',
      )) {
        if (!videos.find((v) => v.url === link.href)) {
          videos.push({
            url: link.href,
            quality: "auto",
            format: extFromUrl(link.href, "mp4"),
            title: link.textContent.trim() || title,
            extractor: SITE_ID,
          });
        }
      }
    }

    try {
      if (window.jwplayer) {
        const players = document.querySelectorAll(
          '.jwplayer, [id^="jwplayer"]',
        );
        players.forEach((el) => {
          try {
            const player = window.jwplayer(el.id);
            if (player && player.getPlaylistItem) {
              const item = player.getPlaylistItem();
              if (item && item.file) {
                videos.push({
                  url: item.file,
                  quality: "auto",
                  format: extFromUrl(item.file, "mp4"),
                  title: item.title || title,
                  extractor: SITE_ID,
                });
              }
            }
          } catch {

          }
        });
      }
    } catch {

    }

    for (const script of document.querySelectorAll("script")) {
      const c = script.textContent || "";
      if (c.length < 20 || c.length > 300000) continue;
      const matches = c.match(
        /["'](https?:\/\/[^"']+\.(?:mp4|m3u8|mp3|m4a|webm))["']/gi,
      );
      if (matches) {
        matches.forEach((m) => {
          const url = m.slice(1, -1);
          if (!videos.find((v) => v.url === url)) {
            videos.push({
              url,
              quality: "auto",
              format: extFromUrl(url, "mp4"),
              title,
              extractor: SITE_ID,
            });
          }
        });
      }
    }

    const unique = [];
    const seen = new Set();
    for (const v of videos) {
      if (!seen.has(v.url)) {
        seen.add(v.url);
        unique.push(v);
      }
    }

    if (unique.length > 0) sendToBackground(unique);
  }

  function checkForContent() {
    const currentUrl = location.href;
    if (currentUrl !== lastProcessedUrl) {
      lastProcessedUrl = currentUrl;
      sentUrls.clear();
      setTimeout(extractMediaContent, 2000);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => checkForContent());
  } else {
    checkForContent();
  }

  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      checkForContent();
    }
  }).observe(document, { subtree: true, childList: true });

  window.addEventListener("popstate", checkForContent);
  setInterval(checkForContent, 7000);

  window.addEventListener("message", (event) => {
    if (
      event.data?.type === "LALHLIMPUII_JAHAU_EXTRACT" &&
      event.data.source === SITE_ID
    ) {
      extractMediaContent();
    }
  });

  log("Northeast News specialist initialized (WordPress/Newspack detection)");
})();
