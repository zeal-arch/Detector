(function () {
  "use strict";

  const SITE_ID = "eastmojo";
  const TAG = "[EastMojo-Specialist]";
  const sentUrls = new Set();
  let lastUrl = location.href;

  function getTitle() {
    const el = document.querySelector(
      "h1, .entry-title, .post-title, .story-title, .headline, .article-title",
    );
    return (el && el.textContent.trim()) || document.title;
  }

  function resolveEmbed(src) {
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
    if (src.includes("facebook.com/plugins/video")) {
      try {
        return new URL(src).searchParams.get("href") || null;
      } catch {
        return null;
      }
    }
    return null;
  }

  function guessQuality(url) {
    if (url.includes("1080")) return "1080p";
    if (url.includes("720")) return "720p";
    if (url.includes("480")) return "480p";
    if (url.includes("360")) return "360p";
    return "auto";
  }

  function send(videos) {
    const fresh = videos.filter((v) => !sentUrls.has(v.url));
    if (fresh.length === 0) return;
    fresh.forEach((v) => sentUrls.add(v.url));
    console.log(TAG, `Sending ${fresh.length} media items`);
    window.postMessage(
      {
        type: "LALHLIMPUII_JAHAU_DETECTED",
        source: SITE_ID,
        data: { videos: fresh },
      },
      "*",
    );
  }

  function extract() {
    const videos = [];
    const title = getTitle();

    for (const m of document.querySelectorAll(
      'meta[property="og:video"], meta[property="og:video:url"], meta[property="og:video:secure_url"]',
    )) {
      const url = m.content;
      if (url && url.startsWith("http")) {
        const resolved = resolveEmbed(url) || url;
        videos.push({
          url: resolved,
          quality: "embed",
          format: "embed",
          title,
        });
      }
    }
    for (const m of document.querySelectorAll(
      'meta[property="og:audio"], meta[property="og:audio:url"]',
    )) {
      const url = m.content;
      if (url && url.startsWith("http")) {
        videos.push({
          url,
          quality: "audio",
          format: "mp3",
          title: title + " (Audio)",
        });
      }
    }

    for (const iframe of document.querySelectorAll(
      "figure.wp-block-embed iframe, .wp-block-embed__wrapper iframe",
    )) {
      const u = resolveEmbed(iframe.src);
      if (u)
        videos.push({
          url: u,
          quality: "embed",
          format: "embed",
          title: title + " (Embed)",
        });
    }

    for (const v of document.querySelectorAll(
      ".wp-block-video video, figure.wp-block-video video",
    )) {
      if (v.src)
        videos.push({ url: v.src, quality: "auto", format: "mp4", title });
    }
    for (const a of document.querySelectorAll(
      ".wp-block-audio audio, figure.wp-block-audio audio",
    )) {
      if (a.src)
        videos.push({
          url: a.src,
          quality: "audio",
          format: "mp3",
          title: title + " (Audio)",
        });
    }

    for (const v of document.querySelectorAll("video")) {
      if (v.src)
        videos.push({
          url: v.src,
          quality: guessQuality(v.src),
          format: "mp4",
          title,
        });
      for (const s of v.querySelectorAll("source")) {
        if (s.src)
          videos.push({
            url: s.src,
            quality: guessQuality(s.src),
            format: "mp4",
            title,
          });
      }
    }
    for (const a of document.querySelectorAll("audio")) {
      if (a.src)
        videos.push({
          url: a.src,
          quality: "audio",
          format: "mp3",
          title: title + " (Audio)",
        });
      for (const s of a.querySelectorAll("source")) {
        if (s.src)
          videos.push({
            url: s.src,
            quality: "audio",
            format: "mp3",
            title: title + " (Audio)",
          });
      }
    }

    for (const iframe of document.querySelectorAll(
      'iframe[src*="youtube"], iframe[src*="youtu.be"], iframe[src*="vimeo"], iframe[src*="dailymotion"], iframe[src*="facebook.com/plugins/video"]',
    )) {
      const u = resolveEmbed(iframe.src);
      if (u)
        videos.push({
          url: u,
          quality: "embed",
          format: "embed",
          title: title + " (Embed)",
        });
    }

    const article = document.querySelector(
      "article, .entry-content, .post-content, .content, .story-content",
    );
    if (article) {
      for (const link of article.querySelectorAll("a[href]")) {
        const href = link.href;
        const yt = href.match(
          /(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]+)/,
        );
        if (yt) {
          videos.push({
            url: `https://www.youtube.com/watch?v=${yt[1]}`,
            quality: "embed",
            format: "embed",
            title: title + " (YouTube)",
          });
          continue;
        }
        const vim = href.match(/vimeo\.com\/(\d+)/);
        if (vim) {
          videos.push({
            url: `https://vimeo.com/${vim[1]}`,
            quality: "embed",
            format: "embed",
            title: title + " (Vimeo)",
          });
          continue;
        }
        const fb = href.match(/facebook\.com\/.*\/videos?\//);
        if (fb) {
          videos.push({
            url: href,
            quality: "embed",
            format: "embed",
            title: title + " (Facebook)",
          });
          continue;
        }
        if (/\.(?:mp4|m3u8|mp3|m4a|webm|ogg)(\?|$)/i.test(href)) {
          const isAudio = /\.(?:mp3|m4a|ogg)(\?|$)/i.test(href);
          videos.push({
            url: href,
            quality: isAudio ? "audio" : guessQuality(href),
            format: "mp4",
            title: link.textContent.trim() || title,
          });
        }
      }
    }

    try {
      if (typeof window.jwplayer === "function") {
        const p = window.jwplayer();
        if (p && typeof p.getPlaylistItem === "function") {
          const item = p.getPlaylistItem();
          if (item) {
            if (item.file)
              videos.push({
                url: item.file,
                quality: "auto",
                format: "mp4",
                title: item.title || title,
              });
            if (item.sources)
              for (const s of item.sources) {
                if (s.file)
                  videos.push({
                    url: s.file,
                    quality: s.label || "auto",
                    format: "mp4",
                    title: item.title || title,
                  });
              }
          }
        }
      }
    } catch (e) {

    }

    for (const amp of document.querySelectorAll("amp-video")) {
      const src =
        amp.getAttribute("src") ||
        amp.querySelector("source")?.getAttribute("src");
      if (src)
        videos.push({
          url: src,
          quality: "auto",
          format: "mp4",
          title: title + " (Story)",
        });
    }

    for (const script of document.querySelectorAll("script")) {
      const c = script.textContent || "";
      if (c.length < 20 || c.length > 300000) continue;
      const matches = c.match(
        /["'](https?:\/\/[^"']+\.(?:mp4|m3u8|webm|ogg|mp3|m4a))["']/gi,
      );
      if (matches) {
        for (const m of matches) {
          const url = m.slice(1, -1);
          if (url.startsWith("http"))
            videos.push({
              url,
              quality: guessQuality(url),
              format: "mp4",
              title,
            });
        }
      }
    }

    const seen = new Set();
    const unique = videos.filter((v) => {
      if (seen.has(v.url)) return false;
      seen.add(v.url);
      return true;
    });
    if (unique.length > 0) send(unique);
  }

  setTimeout(extract, 3000);

  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      sentUrls.clear();
      setTimeout(extract, 3000);
    }
  }).observe(document, { subtree: true, childList: true });

  window.addEventListener("popstate", () => {
    sentUrls.clear();
    setTimeout(extract, 2000);
  });

  setInterval(extract, 10000);

  window.addEventListener("message", (e) => {
    if (
      e.data?.type === "LALHLIMPUII_JAHAU_EXTRACT" &&
      e.data.source === SITE_ID
    )
      extract();
  });

  console.log(TAG, "Specialist loaded");
})();
