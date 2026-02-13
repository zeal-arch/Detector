(function () {
  "use strict";

  console.log(
    "[GenericIE] Pattern detector loaded on:",
    window.location.hostname,
  );

  const processedVideos = new Set();
  let detectionAttempted = false;

  const SPECIALIST_SITES = [
    "youtube.com",
    "youtu.be",
    "vimeo.com",
    "vk.com",
    "vk.ru",
    "vkvideo.ru",
    "facebook.com",
    "instagram.com",
    "iq.com",
    "ok.ru",
    "canva.com",
    "tiktok.com",
    "twitter.com",
    "x.com",
    "twitch.tv",
    "reddit.com",
    "dailymotion.com",
    "streamable.com",
    "9gag.com",
    "imgur.com",
    "rumble.com",
    "bitchute.com",

    "flixtor.li",
    "flixtor.to",
    "flixtor.id",

    "netflix.com",
    "hulu.com",
    "disneyplus.com",
    "hbomax.com",
    "max.com",
    "primevideo.com",
    "amazon.com",
    "peacocktv.com",
    "paramountplus.com",
    "espn.com",
    "nba.com",
    "nfl.com",
    "mlb.com",
    "cnn.com",
    "bbc.com",
    "foxnews.com",
    "nbcnews.com",
    "soundcloud.com",
    "bandcamp.com",
    "mixcloud.com",
    "spotify.com",
    "udemy.com",
    "coursera.org",
    "skillshare.com",
  ];

  const hostname = window.location.hostname
    .replace("www.", "")
    .replace("m.", "");
  const hasSpecialist = SPECIALIST_SITES.some((site) =>
    hostname.includes(site),
  );

  if (hasSpecialist) {
    console.log(
      "[GenericIE] Specialist site detected, skipping generic detection",
    );
    return;
  }

  function notifyBackground(videoData) {
    const hash = `${videoData.url}_${videoData.source}`.replace(
      /[^a-zA-Z0-9]/g,
      "",
    );
    if (processedVideos.has(hash)) return;
    processedVideos.add(hash);

    window.postMessage(
      {
        type: "MAGIC_M3U8_DETECTION",
        source: "GENERIC_IE",
        data: {
          url: videoData.url,
          type: videoData.type || "HLS",
          options: {
            customTitle: videoData.title || document.title,
            thumbnail: videoData.thumbnail,
            quality: videoData.quality,
            width: videoData.width,
            height: videoData.height,
            duration: videoData.duration,
            pageUrl: window.location.href,
            detectionSource: videoData.source,
            description: videoData.description,
          },
        },
      },
      "*",
    );

    window.__SPECIALIST_DETECTED = true;
    console.log(
      "[GenericIE] Video found via:",
      videoData.source,
      videoData.url,
    );
  }

  function detectJWPlayer(html) {
    const patterns = [

      /jwplayer\s*\([^)]*\)\.setup\s*\(\s*(\{[\s\S]*?\})\s*\)/gi,

      /jwplayer_files\s*=\s*(\[[^\]]+\])/gi,

      /window\.jwDefaults\s*=\s*(\{[\s\S]*?\});/gi,

      /jwConfig\s*=\s*(\{[\s\S]*?\});/gi,

      /data-jw-config=['"]([^'"]+)['"]/gi,
    ];

    for (const pattern of patterns) {
      const matches = html.matchAll(pattern);
      for (const match of matches) {
        try {
          let config = match[1];

          if (config.startsWith('"') || config.startsWith("'")) {
            config = config.slice(1, -1).replace(/\\"/g, '"');
          }

          const parsed = JSON.parse(config);
          const videoUrl =
            parsed.file ||
            parsed.sources?.[0]?.file ||
            parsed.sources?.[0]?.src ||
            parsed.playlist?.[0]?.file ||
            parsed.playlist?.[0]?.sources?.[0]?.file;

          if (videoUrl && isValidVideoUrl(videoUrl)) {
            return {
              url: resolveUrl(videoUrl),
              title: parsed.title || parsed.playlist?.[0]?.title,
              thumbnail: parsed.image || parsed.playlist?.[0]?.image,
              source: "jwplayer",
              type: getVideoType(videoUrl),
            };
          }
        } catch (e) {

        }
      }
    }

    const directFile = html.match(/jwplayer[^}]*file:\s*["']([^"']+)["']/i);
    if (directFile && isValidVideoUrl(directFile[1])) {
      return {
        url: resolveUrl(directFile[1]),
        source: "jwplayer_direct",
        type: getVideoType(directFile[1]),
      };
    }

    return null;
  }

  function detectBrightcove(html) {

    const accountMatch = html.match(/data-account=["'](\d+)["']/);
    const playerMatch = html.match(/data-player=["']([^"']+)["']/);
    const videoMatch = html.match(/data-video-id=["'](\d+)["']/);

    if (accountMatch && videoMatch) {
      const playerId = playerMatch ? playerMatch[1] : "default";
      return {
        url: `https://players.brightcove.net/${accountMatch[1]}/${playerId}_default/index.html?videoId=${videoMatch[1]}`,
        source: "brightcove",
        type: "brightcove_embed",
      };
    }

    const bcIframe = html.match(
      /src=["'](https?:\/\/players\.brightcove\.net\/[^"']+)["']/,
    );
    if (bcIframe) {
      return {
        url: bcIframe[1],
        source: "brightcove_iframe",
        type: "brightcove_embed",
      };
    }

    const policyKey = html.match(/policyKey:\s*["']([^"']+)["']/);
    const bcAccount = html.match(/accountId:\s*["']?(\d+)["']?/);
    const bcVideo = html.match(/videoId:\s*["']?(\d+)["']?/);

    if (policyKey && bcAccount && bcVideo) {
      return {
        url: `https://edge.api.brightcove.com/playback/v1/accounts/${bcAccount[1]}/videos/${bcVideo[1]}`,
        source: "brightcove_api",
        type: "brightcove_api",
        policyKey: policyKey[1],
      };
    }

    return null;
  }

  function detectHTML5Video(doc) {
    const videos = doc.querySelectorAll("video");

    for (const video of videos) {

      if (video.offsetWidth < 100 || video.offsetHeight < 50) continue;

      if (video.src && isValidVideoUrl(video.src)) {
        return {
          url: video.src,
          source: "html5_video_src",
          type: getVideoType(video.src),
          width: video.videoWidth || video.offsetWidth,
          height: video.videoHeight || video.offsetHeight,
        };
      }

      const sources = video.querySelectorAll("source");
      for (const source of sources) {
        if (source.src && isValidVideoUrl(source.src)) {
          return {
            url: source.src,
            source: "html5_source",
            type: source.type || getVideoType(source.src),
            width: video.videoWidth || video.offsetWidth,
            height: video.videoHeight || video.offsetHeight,
          };
        }
      }

      const dataSrc =
        video.dataset.src || video.dataset.videoSrc || video.dataset.streamUrl;
      if (dataSrc && isValidVideoUrl(dataSrc)) {
        return {
          url: dataSrc,
          source: "html5_data_src",
          type: getVideoType(dataSrc),
        };
      }
    }

    return null;
  }

  function detectOpenGraph(doc) {
    const selectors = [
      'meta[property="og:video"]',
      'meta[property="og:video:url"]',
      'meta[property="og:video:secure_url"]',
      'meta[name="twitter:player:stream"]',
      'meta[name="twitter:player"]',
    ];

    for (const selector of selectors) {
      const meta = doc.querySelector(selector);
      if (meta?.content && isValidVideoUrl(meta.content)) {

        const ogTitle = doc.querySelector('meta[property="og:title"]')?.content;
        const ogImage = doc.querySelector('meta[property="og:image"]')?.content;
        const ogDesc = doc.querySelector(
          'meta[property="og:description"]',
        )?.content;

        return {
          url: meta.content,
          title: ogTitle,
          thumbnail: ogImage,
          description: ogDesc,
          source: "opengraph",
          type: getVideoType(meta.content),
        };
      }
    }

    return null;
  }

  function detectJSONLD(html) {
    const jsonLdRegex =
      /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let match;

    while ((match = jsonLdRegex.exec(html)) !== null) {
      try {
        const json = JSON.parse(match[1]);
        const items = Array.isArray(json) ? json : [json];

        for (const item of items) {

          if (item["@type"] === "VideoObject") {
            const videoUrl = item.contentUrl || item.embedUrl || item.url;
            if (videoUrl && isValidVideoUrl(videoUrl)) {
              return {
                url: videoUrl,
                title: item.name,
                description: item.description,
                thumbnail: item.thumbnailUrl,
                duration: item.duration,
                source: "jsonld_video",
                type: getVideoType(videoUrl),
              };
            }
          }

          if (item.video) {
            const video = Array.isArray(item.video)
              ? item.video[0]
              : item.video;
            const videoUrl = video.contentUrl || video.embedUrl || video.url;
            if (videoUrl && isValidVideoUrl(videoUrl)) {
              return {
                url: videoUrl,
                title: item.headline || item.name,
                description: item.description,
                thumbnail: video.thumbnailUrl || item.image,
                source: "jsonld_nested",
                type: getVideoType(videoUrl),
              };
            }
          }
        }
      } catch (e) {

      }
    }

    return null;
  }

  function detectVideoJS(html, doc) {

    const advancedMatch = html.match(
      /\bvideojs\s*\(.+?([a-zA-Z0-9_$]+)\.src\s*\(\s*((?:\[.+?\]|\{.+?\}))\s*\)\s*;/s,
    );
    if (advancedMatch) {
      const varName = advancedMatch[1];
      const sourcesStr = advancedMatch[2];

      try {

        const sources = JSON.parse(sourcesStr.replace(/'/g, '"'));
        const sourceList = Array.isArray(sources) ? sources : [sources];

        for (const source of sourceList) {
          const srcUrl = source.src;
          if (!srcUrl) continue;

          if (/youtube\.com|youtu\.be/.test(srcUrl)) {
            console.log("[GenericIE] Found YouTube embed in Video.js");
            return { url: srcUrl, source: "videojs_youtube", type: "youtube" };
          }

          if (
            source.type === "application/dash+xml" ||
            /\.mpd($|\?)/.test(srcUrl)
          ) {
            console.log("[GenericIE] Found DASH manifest in Video.js");
            return {
              url: resolveUrl(srcUrl),
              source: "videojs_dash",
              type: "dash",
            };
          }

          if (
            source.type === "application/x-mpegURL" ||
            /\.m3u8($|\?)/.test(srcUrl)
          ) {
            console.log("[GenericIE] Found HLS manifest in Video.js");
            return {
              url: resolveUrl(srcUrl),
              source: "videojs_hls",
              type: "hls",
            };
          }

          if (isValidVideoUrl(srcUrl)) {
            return {
              url: resolveUrl(srcUrl),
              source: "videojs_src_call",
              type: source.type || getVideoType(srcUrl),
            };
          }
        }

        const trackPattern = new RegExp(
          `${varName}\\.addRemoteTextTrack\\s*\\(\\s*(\\{[^}]+\\})\\s*\\)`,
          "g",
        );
        const tracks = [];
        let trackMatch;
        while ((trackMatch = trackPattern.exec(html)) !== null) {
          try {
            const track = JSON.parse(trackMatch[1].replace(/'/g, '"'));
            if (track.src || track.file) {
              tracks.push({
                url: track.src || track.file,
                language: track.srclang || track.language || "en",
                label: track.label,
              });
            }
          } catch (e) {
            console.debug("[GenericIE] Failed to parse Video.js subtitle:", e);
          }
        }

      } catch (e) {
        console.debug(
          "[GenericIE] Failed to parse Video.js advanced pattern:",
          e,
        );
      }
    }

    const vjsElements = doc.querySelectorAll(
      ".video-js, [data-setup], [data-video-js]",
    );

    for (const el of vjsElements) {

      const setup = el.dataset.setup;
      if (setup) {
        try {
          const config = JSON.parse(setup);
          const src = config.sources?.[0]?.src || config.src;
          if (src && isValidVideoUrl(src)) {
            return {
              url: resolveUrl(src),
              source: "videojs_setup",
              type: config.sources?.[0]?.type || getVideoType(src),
            };
          }
        } catch (e) {
          console.debug("[GenericIE] Failed to parse Video.js data:", e);
        }
      }

      const source = el.querySelector("source");
      if (source?.src && isValidVideoUrl(source.src)) {
        return {
          url: source.src,
          source: "videojs_source",
          type: source.type || getVideoType(source.src),
        };
      }
    }

    const vjsConfig = html.match(/videojs\.options\s*=\s*(\{[\s\S]*?\});/);
    if (vjsConfig) {
      try {
        const config = JSON.parse(vjsConfig[1]);
        const src = config.sources?.[0]?.src;
        if (src && isValidVideoUrl(src)) {
          return {
            url: resolveUrl(src),
            source: "videojs_options",
            type: getVideoType(src),
          };
        }
      } catch (e) {
        console.debug("[GenericIE] Failed to parse Video.js source:", e);
      }
    }

    return null;
  }

  function detectYouTubeEmbed(html) {
    const patterns = [

      /src=["'](?:https?:)?\/\/(?:www\.)?youtube\.com\/embed\/([a-zA-Z0-9_-]{11})[^"']*/gi,

      /data-youtube-id=["']([a-zA-Z0-9_-]{11})["']/gi,

      /youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/gi,

      /youtu\.be\/([a-zA-Z0-9_-]{11})/gi,
    ];

    for (const pattern of patterns) {
      const match = pattern.exec(html);
      if (match) {
        return {
          url: `https://www.youtube.com/watch?v=${match[1]}`,
          source: "youtube_embed",
          type: "youtube",
        };
      }
    }

    return null;
  }

  function detectVimeoEmbed(html) {
    const patterns = [
      /src=["'](?:https?:)?\/\/player\.vimeo\.com\/video\/(\d+)[^"']*/gi,
      /vimeo\.com\/(?:video\/)?(\d+)/gi,
      /data-vimeo-id=["'](\d+)["']/gi,
    ];

    for (const pattern of patterns) {
      const match = pattern.exec(html);
      if (match) {
        return {
          url: `https://vimeo.com/${match[1]}`,
          source: "vimeo_embed",
          type: "vimeo",
        };
      }
    }

    return null;
  }

  function detectDailymotionEmbed(html) {
    const patterns = [
      /dailymotion\.com\/(?:embed\/)?video\/([a-zA-Z0-9]+)/gi,
      /dai\.ly\/([a-zA-Z0-9]+)/gi,
      /data-dailymotion-id=["']([a-zA-Z0-9]+)["']/gi,
    ];

    for (const pattern of patterns) {
      const match = pattern.exec(html);
      if (match) {
        return {
          url: `https://www.dailymotion.com/video/${match[1]}`,
          source: "dailymotion_embed",
          type: "dailymotion",
        };
      }
    }

    return null;
  }

  function detectTwitterEmbed(html) {
    const match = html.match(/twitter\.com\/(\w+)\/status\/(\d+)/);
    if (match) {
      return {
        url: `https://twitter.com/${match[1]}/status/${match[2]}`,
        source: "twitter_embed",
        type: "twitter",
      };
    }
    return null;
  }

  function detectDirectUrls(html) {

    let found = filterVideoUrls(
      html.match(/flashvars:\s*['"](.*?&)?file=(http[^'"&]*)/gi),
    );
    if (found.length > 0) {
      console.log("[GenericIE] Found JW Player in SWFObject");
      return {
        url: resolveUrl(found[0]),
        source: "jwplayer_swf",
        type: getVideoType(found[0]),
      };
    }

    found = filterVideoUrls(
      html.match(
        /(?:jw_plugins|JWPlayerOptions|jwplayer\s*\(\s*["'][^'"]+["']\s*\)\s*\.setup)[\s\S]*?['"]?file['"]?\s*:\s*["']([^"']+)["']/gi,
      ),
    );
    if (found.length > 0) {
      console.log("[GenericIE] Found JW Player embed");
      return {
        url: resolveUrl(found[0]),
        source: "jwplayer_embed",
        type: getVideoType(found[0]),
      };
    }

    found = filterVideoUrls(
      html.match(/[^A-Za-z0-9]?(?:file|source)=(http[^'"&]*)/gi),
    );
    if (found.length > 0) {
      console.log("[GenericIE] Found video file parameter");
      return {
        url: resolveUrl(found[0]),
        source: "file_param",
        type: getVideoType(found[0]),
      };
    }

    found = filterVideoUrls(
      html.match(
        /[^A-Za-z0-9]?(?:file|video_url)["']?\s*:\s*["'](http(?![^'"]+\.[0-9]+['"])[^'"]+)["']/gi,
      ),
    );
    if (found.length > 0) {
      console.log("[GenericIE] Found JW Player JS loader");
      return {
        url: resolveUrl(found[0]),
        source: "jwplayer_js",
        type: getVideoType(found[0]),
      };
    }

    const flowMatch = html.match(
      /flowplayer\("[^"]+",\s*\{[^}]+?\}\s*,\s*\{[^}]+?["']?clip["']?\s*:\s*\{\s*["']?url["']?\s*:\s*["']([^"']+)["']/,
    );
    if (flowMatch && isValidVideoUrl(flowMatch[1])) {
      console.log("[GenericIE] Found Flow Player");
      return {
        url: resolveUrl(flowMatch[1]),
        source: "flowplayer",
        type: getVideoType(flowMatch[1]),
      };
    }

    const cineramaMatch = html.match(
      /cinerama\.embedPlayer\(\s*'[^']+',\s*'([^']+)'/,
    );
    if (cineramaMatch && isValidVideoUrl(cineramaMatch[1])) {
      console.log("[GenericIE] Found Cinerama player");
      return {
        url: resolveUrl(cineramaMatch[1]),
        source: "cinerama",
        type: getVideoType(cineramaMatch[1]),
      };
    }

    const videoPatterns = [

      /(https?:\/\/[^"'\s<>]+\.m3u8(?:\?[^"'\s<>]*)?)/gi,

      /(https?:\/\/[^"'\s<>]+\.mpd(?:\?[^"'\s<>]*)?)/gi,

      /(https?:\/\/[^"'\s<>]+\.mp4(?:\?[^"'\s<>]*)?)/gi,

      /(https?:\/\/[^"'\s<>]+\.webm(?:\?[^"'\s<>]*)?)/gi,

      /(https?:\/\/[^"'\s<>]+\.mov(?:\?[^"'\s<>]*)?)/gi,

      /(https?:\/\/[^"'\s<>]+\.flv(?:\?[^"'\s<>]*)?)/gi,
    ];

    for (const pattern of videoPatterns) {
      const matches = [...html.matchAll(pattern)];
      for (const match of matches) {
        let url = match[1];

        url = unescapeVideoUrl(url);

        if (isAdUrl(url)) continue;

        if (
          url.includes("/thumb") ||
          url.includes("_thumb") ||
          url.includes("/poster")
        )
          continue;

        if (isValidVideoUrl(url)) {
          return {
            url: url,
            source: "direct_url",
            type: getVideoType(url),
          };
        }
      }
    }

    return null;
  }

  function filterVideoUrls(matches) {
    if (!matches) return [];
    return matches
      .filter((url) => {
        if (!url) return false;

        const urlMatch = url.match(/https?:\/\/[^"'\s<>&]+/);
        const actualUrl = urlMatch ? urlMatch[0] : url;
        return checkVideo(actualUrl);
      })
      .map((url) => {
        const urlMatch = url.match(/https?:\/\/[^"'\s<>&]+/);
        return urlMatch ? urlMatch[0] : url;
      });
  }

  function checkVideo(vurl) {
    if (!vurl) return false;

    if (vurl.includes("youtube.com") || vurl.includes("youtu.be")) return true;
    if (vurl.startsWith("rtmp://") || vurl.startsWith("rtmpe://")) return true;

    try {
      const pathname = new URL(vurl).pathname;
      const ext = pathname.split(".").pop().toLowerCase();

      const nonVideoExts = [
        "swf",
        "png",
        "jpg",
        "jpeg",
        "gif",
        "srt",
        "sbv",
        "sub",
        "vtt",
        "ttml",
        "js",
        "xml",
        "css",
        "html",
      ];
      if (nonVideoExts.includes(ext)) return false;

      return (
        ext.length > 0 || vurl.includes("manifest") || vurl.includes("playlist")
      );
    } catch (e) {
      return false;
    }
  }

  function kvsGetLicenseToken(licenseCode) {
    licenseCode = licenseCode.replace(/\$/g, "");
    const licenseValues = licenseCode.split("").map((ch) => parseInt(ch, 10));

    let modlicense = licenseCode.replace(/0/g, "1");
    const center = Math.floor(modlicense.length / 2);
    const fronthalf = parseInt(modlicense.substring(0, center + 1), 10);
    const backhalf = parseInt(modlicense.substring(center), 10);
    modlicense = String(4 * Math.abs(fronthalf - backhalf)).substring(
      0,
      center + 1,
    );

    const result = [];
    const modlicenseDigits = modlicense.split("").map((d) => parseInt(d, 10));
    for (let index = 0; index < modlicenseDigits.length; index++) {
      const current = modlicenseDigits[index];
      for (let offset = 0; offset < 4; offset++) {
        result.push((licenseValues[index + offset] + current) % 10);
      }
    }

    return result;
  }

  function kvsGetRealUrl(videoUrl, licenseCode) {
    if (!videoUrl.startsWith("function/0/")) {
      return videoUrl;
    }

    try {
      const urlPath = videoUrl.substring("function/0/".length);
      const licenseToken = kvsGetLicenseToken(licenseCode);
      const urlparts = urlPath.split("/");

      const HASH_LENGTH = 32;
      const hash = urlparts[3].substring(0, HASH_LENGTH);
      const indices = Array.from({ length: HASH_LENGTH }, (_, i) => i);

      let accum = 0;
      for (let src = HASH_LENGTH - 1; src >= 0; src--) {
        accum += licenseToken[src];
        const dest = (src + accum) % HASH_LENGTH;
        [indices[src], indices[dest]] = [indices[dest], indices[src]];
      }

      const newHash =
        indices.map((i) => hash[i]).join("") +
        urlparts[3].substring(HASH_LENGTH);
      urlparts[3] = newHash;

      return urlparts.join("/");
    } catch (e) {
      console.error("[GenericIE] KVS URL de-obfuscation failed:", e);
      return videoUrl;
    }
  }

  function detectKVSPlayer(html) {

    const kvsMatch =
      html.match(
        /<script\b[^>]+?\bsrc\s*=\s*["']https?:\/\/(?:[^"'?#])+\/kt_player\.js\?v=(\d+(?:\.\d+)+)["']/i,
      ) ||
      html.match(
        /kt_player\s*\(\s*["'](?:[\w\W])+["']\s*,\s*["']https?:\/\/(?:[^"'?#])+\/kt_player\.swf\?v=(\d+(?:\.\d+)+)["']/i,
      );

    if (kvsMatch) {
      console.log("[GenericIE] Found KVS Player version:", kvsMatch[1]);

      const flashvarsMatch = html.match(
        /var\s+flashvars\s*=\s*(\{[^;]+\})\s*;/,
      );
      if (flashvarsMatch) {
        try {
          const flashvars = JSON.parse(flashvarsMatch[1].replace(/'/g, '"'));

          const urlKeys = Object.keys(flashvars).filter((key) =>
            /^video_(?:url|alt_url\d*)$/.test(key),
          );
          const licenseCode = flashvars.license_code;

          for (const key of urlKeys) {
            let videoUrl = flashvars[key];
            if (!videoUrl || !videoUrl.includes("/get_file/")) continue;

            if (licenseCode && videoUrl.startsWith("function/0/")) {
              videoUrl = kvsGetRealUrl(videoUrl, licenseCode);
            }

            videoUrl = resolveUrl(videoUrl);

            if (isValidVideoUrl(videoUrl)) {
              const quality = flashvars[`${key}_text`] || key;
              return {
                url: videoUrl,
                source: "kvs_player",
                type: "MP4",
                quality: quality,
                thumbnail: resolveUrl(flashvars.preview_url),
                title: flashvars.video_title,
              };
            }
          }
        } catch (e) {
          console.error("[GenericIE] Failed to parse KVS flashvars:", e);
        }
      }

      const videoFileMatch = html.match(
        /(?:video_url|video_file|file_url)\s*[:=]\s*["']([^"']+)["']/i,
      );
      if (videoFileMatch && isValidVideoUrl(videoFileMatch[1])) {
        return {
          url: resolveUrl(videoFileMatch[1]),
          source: "kvs_player_fallback",
          type: getVideoType(videoFileMatch[1]),
        };
      }

      const flashvarsMatch2 =
        html.match(/flashvars\s*[=:]\s*["']([^"']+)["']/i) ||
        html.match(/flashvars\s*[=:]\s*\{([^}]+)\}/i);
      if (flashvarsMatch2) {
        const flashvars = flashvarsMatch2[1];
        const videoUrl =
          flashvars.match(/video_url=([^&"']+)/) ||
          flashvars.match(/file_url=([^&"']+)/) ||
          flashvars.match(/video=([^&"']+)/);
        if (videoUrl && isValidVideoUrl(decodeURIComponent(videoUrl[1]))) {
          return {
            url: resolveUrl(decodeURIComponent(videoUrl[1])),
            source: "kvs_flashvars",
            type: getVideoType(decodeURIComponent(videoUrl[1])),
          };
        }
      }

      const licenseMatch = html.match(
        /license_code\s*[:=]\s*["']([^"']+)["']/i,
      );
      const videoIdMatch = html.match(/video_id\s*[:=]\s*["']?(\d+)["']?/i);
      if (licenseMatch && videoIdMatch) {
        return {
          url: window.location.href,
          source: "kvs_player",
          type: "kvs",
          kvs_license: licenseMatch[1],
          kvs_video_id: videoIdMatch[1],
        };
      }
    }

    return null;
  }

  function detectFlowPlayer(html) {
    const patterns = [
      /flowplayer\([^,]*,\s*(\{[\s\S]*?\})\s*\)/gi,
      /data-flowplayer-config=["']([^"']+)["']/gi,
    ];

    for (const pattern of patterns) {
      const match = pattern.exec(html);
      if (match) {
        try {
          const config = JSON.parse(match[1].replace(/'/g, '"'));
          const src =
            config.clip?.url || config.src || config.sources?.[0]?.src;
          if (src && isValidVideoUrl(src)) {
            return {
              url: resolveUrl(src),
              source: "flowplayer",
              type: getVideoType(src),
            };
          }
        } catch (e) {
          console.debug("[GenericIE] Failed to parse FlowPlayer config:", e);
        }
      }
    }

    return null;
  }

  function detectKaltura(html) {
    const partnerId = html.match(/partnerId['":\s]+['"]?(\d+)['"]?/i);
    const entryId = html.match(/entryId['":\s]+['"]?([a-z0-9_]+)['"]?/i);

    if (partnerId && entryId) {
      return {
        url: `https://cdnapisec.kaltura.com/p/${partnerId[1]}/sp/${partnerId[1]}00/playManifest/entryId/${entryId[1]}/format/url/protocol/https`,
        source: "kaltura",
        type: "kaltura",
      };
    }

    return null;
  }

  function detectWistia(html) {

    const wistiaId = html.match(/wistia_async_([a-zA-Z0-9]+)/);
    if (wistiaId) {
      return {
        url: `https://fast.wistia.com/embed/medias/${wistiaId[1]}`,
        source: "wistia",
        type: "wistia",
      };
    }

    const wistiaIframe = html.match(
      /src=["'](https?:\/\/fast\.wistia\.(?:com|net)\/embed\/[^"']+)["']/,
    );
    if (wistiaIframe) {
      return {
        url: wistiaIframe[1],
        source: "wistia_iframe",
        type: "wistia",
      };
    }

    return null;
  }

  function detectVidyard(html) {
    const patterns = [
      /vidyard-embed[^>]*data-uuid=["']([^"']+)["']/gi,
      /play\.vidyard\.com\/([a-zA-Z0-9]+)/gi,
    ];

    for (const pattern of patterns) {
      const match = pattern.exec(html);
      if (match) {
        return {
          url: `https://play.vidyard.com/${match[1]}`,
          source: "vidyard",
          type: "vidyard",
        };
      }
    }

    return null;
  }

  function detectLoom(html) {
    const match = html.match(/loom\.com\/(?:share|embed)\/([a-zA-Z0-9]+)/);
    if (match) {
      return {
        url: `https://www.loom.com/share/${match[1]}`,
        source: "loom",
        type: "loom",
      };
    }
    return null;
  }

  function detectSproutVideo(html) {
    const match = html.match(/videos\.sproutvideo\.com\/embed\/([a-zA-Z0-9]+)/);
    if (match) {
      return {
        url: `https://videos.sproutvideo.com/embed/${match[1]}`,
        source: "sproutvideo",
        type: "sproutvideo",
      };
    }
    return null;
  }

  function detectIframeVideo(doc) {
    const iframes = doc.querySelectorAll("iframe[src]");
    const videoDomains = [
      "youtube.com",
      "youtu.be",
      "vimeo.com",
      "dailymotion.com",
      "dai.ly",
      "twitch.tv",
      "facebook.com",
      "twitter.com",
      "tiktok.com",
      "streamable.com",
      "gfycat.com",
      "giphy.com",
      "imgur.com",
      "rumble.com",
      "bitchute.com",
      "odysee.com",
      "lbry.tv",
      "mixcloud.com",
      "soundcloud.com",
      "bandcamp.com",
      "wistia.com",
      "wistia.net",
      "vidyard.com",
      "loom.com",
      "brightcove.net",
      "kaltura.com",
      "sproutvideo.com",
      "jwplatform.com",
      "jwplayer.com",
      "videojs.com",
    ];

    for (const iframe of iframes) {
      const src = iframe.src;
      for (const domain of videoDomains) {
        if (src.includes(domain)) {
          return {
            url: src,
            source: "iframe_embed",
            type: domain.split(".")[0],
          };
        }
      }
    }

    return null;
  }

  function detectPlyr(html, doc) {
    const plyrElements = doc.querySelectorAll(".plyr, [data-plyr-provider]");

    for (const el of plyrElements) {
      const provider = el.dataset.plyrProvider;
      const embedId = el.dataset.plyrEmbedId;

      if (provider && embedId) {
        if (provider === "youtube") {
          return {
            url: `https://youtube.com/watch?v=${embedId}`,
            source: "plyr_youtube",
            type: "youtube",
          };
        }
        if (provider === "vimeo") {
          return {
            url: `https://vimeo.com/${embedId}`,
            source: "plyr_vimeo",
            type: "vimeo",
          };
        }
      }

      const video = el.querySelector("video source, video[src]");
      if (video) {
        const src = video.src || video.getAttribute("src");
        if (src && isValidVideoUrl(src)) {
          return { url: src, source: "plyr_video", type: getVideoType(src) };
        }
      }
    }

    return null;
  }

  function detectMediaElement(html, doc) {
    const meElements = doc.querySelectorAll(
      ".mejs-container, .mejs__container",
    );

    for (const el of meElements) {
      const video = el.querySelector("video, audio");
      if (video?.src && isValidVideoUrl(video.src)) {
        return {
          url: video.src,
          source: "mediaelement",
          type: getVideoType(video.src),
        };
      }
    }

    return null;
  }

  function detectOoyala(html) {
    const embedCode = html.match(/data-embedcode=["']([^"']+)["']/);
    const pcode = html.match(/data-pcode=["']([^"']+)["']/);

    if (embedCode && pcode) {
      return {
        url: `https://player.ooyala.com/player.js?embedCode=${embedCode[1]}&pcode=${pcode[1]}`,
        source: "ooyala",
        type: "ooyala",
      };
    }

    return null;
  }

  function detectThePlatform(html) {
    const patterns = [
      /player\.theplatform\.com\/p\/([^/]+)\/([^/]+)\?([^"'\s]+)/gi,
      /link\.theplatform\.com\/s\/([^?]+)\?([^"'\s]+)/gi,
    ];

    for (const pattern of patterns) {
      const match = pattern.exec(html);
      if (match) {
        return {
          url: match[0],
          source: "theplatform",
          type: "theplatform",
        };
      }
    }

    return null;
  }

  function detectAkamai(html) {
    const match = html.match(
      /(https?:\/\/[^"'\s]*akamaihd\.net[^"'\s]*\.m3u8[^"'\s]*)/i,
    );
    if (match && isValidVideoUrl(match[1])) {
      return {
        url: match[1],
        source: "akamai_hls",
        type: "HLS",
      };
    }
    return null;
  }

  function detectCloudflareStream(html) {
    const patterns = [
      /cloudflarestream\.com\/([a-zA-Z0-9]+)/gi,
      /videodelivery\.net\/([a-zA-Z0-9]+)/gi,
      /stream\.cloudflare\.com\/([a-zA-Z0-9]+)/gi,
    ];

    for (const pattern of patterns) {
      const match = pattern.exec(html);
      if (match) {
        return {
          url: `https://cloudflarestream.com/${match[1]}/manifest/video.m3u8`,
          source: "cloudflare_stream",
          type: "HLS",
        };
      }
    }

    return null;
  }

  function detectBunnyCDN(html) {
    const match = html.match(
      /(https?:\/\/[^"'\s]*\.b-cdn\.net[^"'\s]*(?:\.m3u8|\.mp4)[^"'\s]*)/i,
    );
    if (match && isValidVideoUrl(match[1])) {
      return {
        url: match[1],
        source: "bunnycdn",
        type: getVideoType(match[1]),
      };
    }
    return null;
  }

  function detectSMIL(html) {

    const smilPatterns = [
      /(https?:\/\/[^"'\s<>]+\.smil(?:\?[^"'\s<>]*)?)/gi,
      /["']([^"'\s]+\.smil(?:\?[^"']*)?)['"]/gi,
    ];

    for (const pattern of smilPatterns) {
      const match = pattern.exec(html);
      if (match && isValidVideoUrl(match[1])) {
        return {
          url: resolveUrl(match[1]),
          source: "smil",
          type: "SMIL",
        };
      }
    }

    return null;
  }

  function detectXSPF(html) {

    const xspfPattern = /(https?:\/\/[^"'\s<>]+\.xspf(?:\?[^"'\s<>]*)?)/gi;
    const match = xspfPattern.exec(html);

    if (match && isValidVideoUrl(match[1])) {
      return {
        url: resolveUrl(match[1]),
        source: "xspf",
        type: "XSPF",
      };
    }

    return null;
  }

  function detectF4M(html) {

    const f4mPattern = /(https?:\/\/[^"'\s<>]+\.f4m(?:\?[^"'\s<>]*)?)/gi;
    const match = f4mPattern.exec(html);

    if (match && isValidVideoUrl(match[1])) {
      return {
        url: resolveUrl(match[1]),
        source: "f4m",
        type: "F4M",
      };
    }

    return null;
  }

  function detectISM(html) {

    const ismPattern =
      /(https?:\/\/[^"'\s<>]+\.(?:ism|isml)\/[Mm]anifest(?:\([^)]*\))?(?:\?[^"'\s<>]*)?)/gi;
    const match = ismPattern.exec(html);

    if (match) {
      return {
        url: resolveUrl(match[1]),
        source: "ism_smooth_streaming",
        type: "ISM",
      };
    }

    return null;
  }

  function detectMetaRefresh(html, doc) {

    const REDIRECT_REGEX = /[\d]{0,2};\s*(?:URL|url)=['"]?([^'">\s]+)['"]?/;

    const metaRefresh = doc.querySelector('meta[http-equiv="refresh" i]');
    if (metaRefresh?.content) {
      const match = metaRefresh.content.match(REDIRECT_REGEX);
      if (match && match[1] && match[1] !== window.location.href) {
        return {
          url: resolveUrl(match[1]),
          source: "meta_refresh",
          type: "redirect",
        };
      }
    }

    const htmlMatch = html.match(
      /<meta\s+(?=[^>]*http-equiv=["']refresh["'])[^>]*content=["']([^"']+)["']/i,
    );
    if (htmlMatch) {
      const match = htmlMatch[1].match(REDIRECT_REGEX);
      if (match && match[1] && match[1] !== window.location.href) {
        return {
          url: resolveUrl(match[1]),
          source: "meta_refresh_html",
          type: "redirect",
        };
      }
    }

    return null;
  }

  function detectTwitterPlayerStream(doc) {

    const playerStream = doc.querySelector(
      'meta[property="twitter:player:stream"], meta[name="twitter:player:stream"]',
    );
    if (playerStream?.content && isValidVideoUrl(playerStream.content)) {
      const ogTitle = doc.querySelector('meta[property="og:title"]')?.content;
      const ogImage = doc.querySelector('meta[property="og:image"]')?.content;

      return {
        url: playerStream.content,
        title: ogTitle,
        thumbnail: ogImage,
        source: "twitter_player_stream",
        type: getVideoType(playerStream.content),
      };
    }

    return null;
  }

  function detectTwitterPlayer(doc) {

    const twitterPlayer = doc.querySelector(
      'meta[property="twitter:player"], meta[name="twitter:player"]',
    );
    if (
      twitterPlayer?.content &&
      twitterPlayer.content !== window.location.href
    ) {
      const ogTitle = doc.querySelector('meta[property="og:title"]')?.content;
      const ogImage = doc.querySelector('meta[property="og:image"]')?.content;

      return {
        url: twitterPlayer.content,
        title: ogTitle,
        thumbnail: ogImage,
        source: "twitter_player_iframe",
        type: "embed",
      };
    }

    return null;
  }

  function unescapeVideoUrl(url) {
    if (!url) return url;

    url = url.replace(/\\u([0-9a-fA-F]{4})/g, (match, grp) =>
      String.fromCharCode(parseInt(grp, 16)),
    );

    const textarea = document.createElement("textarea");
    textarea.innerHTML = url;
    url = textarea.value;

    url = url.replace(/\\\//g, "/");

    return url;
  }

  function isValidVideoUrl(url) {
    if (!url) return false;

    if (
      !url.startsWith("http://") &&
      !url.startsWith("https://") &&
      !url.startsWith("//")
    )
      return false;

    const EXCLUDED_EXTS = [
      "swf",
      "png",
      "jpg",
      "jpeg",
      "gif",
      "srt",
      "sbv",
      "sub",
      "vtt",
      "ttml",
      "js",
      "xml",
      "css",
      "html",
    ];
    try {
      const pathname = new URL(url, window.location.href).pathname;
      const ext = pathname.split(".").pop().toLowerCase();
      if (EXCLUDED_EXTS.includes(ext)) return false;
    } catch (e) {

    }

    const videoExtensions = [
      ".mp4",
      ".webm",
      ".m3u8",
      ".mpd",
      ".mov",
      ".avi",
      ".mkv",
      ".flv",
      ".f4v",
      ".smil",
      ".xspf",
      ".f4m",
    ];
    const isVideoFile = videoExtensions.some((ext) =>
      url.toLowerCase().includes(ext),
    );
    const isStream =
      url.includes("manifest") ||
      url.includes("playlist") ||
      url.includes("stream");
    const isPlayer =
      url.includes("embed") || url.includes("player") || url.includes("/e/");
    return isVideoFile || isStream || isPlayer;
  }

  function isAdUrl(url) {
    const adPatterns = [
      "doubleclick",
      "googlesyndication",
      "googleadservices",
      "adsystem",
      "adserver",
      "adtech",
      "advertising",
      "tracking",
      "analytics",
      "beacon",
      "pixel",
    ];
    return adPatterns.some((pattern) => url.toLowerCase().includes(pattern));
  }

  function getVideoType(url) {
    if (url.includes(".m3u8")) return "HLS";
    if (url.includes(".mpd")) return "DASH";
    if (url.includes(".mp4")) return "MP4";
    if (url.includes(".webm")) return "WebM";
    if (url.includes(".smil")) return "SMIL";
    if (url.includes(".f4m")) return "F4M";
    if (url.includes(".xspf")) return "XSPF";
    return "video";
  }

  function resolveUrl(url) {
    if (!url) return url;
    if (url.startsWith("//")) return "https:" + url;
    if (url.startsWith("/")) return window.location.origin + url;
    if (!url.startsWith("http")) {
      try {
        return new URL(url, window.location.href).href;
      } catch (e) {
        return url;
      }
    }
    return url;
  }

  function runDetection() {
    if (detectionAttempted) return;
    detectionAttempted = true;

    const html = document.documentElement.outerHTML;
    const doc = document;

    console.log("[GenericIE] Starting pattern detection...");

    const detectors = [
      () => detectJWPlayer(html),
      () => detectKVSPlayer(html),
      () => detectBrightcove(html, doc),
      () => detectHTML5Video(doc),
      () => detectTwitterPlayerStream(doc),
      () => detectJSONLD(html),
      () => detectOpenGraph(doc),
      () => detectVideoJS(html, doc),
      () => detectYouTubeEmbed(html),
      () => detectVimeoEmbed(html),
      () => detectDailymotionEmbed(html),
      () => detectTwitterEmbed(html),
      () => detectMetaRefresh(html, doc),
      () => detectSMIL(html),
      () => detectXSPF(html),
      () => detectF4M(html),
      () => detectISM(html),
      () => detectDirectUrls(html),
      () => detectFlowPlayer(html),
      () => detectKaltura(html),
      () => detectWistia(html, doc),
      () => detectVidyard(html),
      () => detectLoom(html),
      () => detectSproutVideo(html),
      () => detectIframeVideo(doc),
      () => detectPlyr(html, doc),
      () => detectMediaElement(html, doc),
      () => detectOoyala(html),
      () => detectThePlatform(html),
      () => detectAkamai(html),
      () => detectCloudflareStream(html),
      () => detectBunnyCDN(html),
      () => detectTwitterPlayer(doc),
    ];

    for (const detector of detectors) {
      try {
        const result = detector();
        if (result && result.url) {
          notifyBackground(result);
          return;
        }
      } catch (e) {
        console.error("[GenericIE] Detector error:", e);
      }
    }

    console.log("[GenericIE] No patterns matched");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      setTimeout(runDetection, 500);
    });
  } else {
    setTimeout(runDetection, 500);
  }

  let mutationTimeout;
  const observer = new MutationObserver(() => {
    if (mutationTimeout) clearTimeout(mutationTimeout);
    mutationTimeout = setTimeout(() => {
      if (!window.__SPECIALIST_DETECTED) {
        detectionAttempted = false;
        runDetection();
      }
    }, 1000);
  });

  observer.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true,
  });
})();
