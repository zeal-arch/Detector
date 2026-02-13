class InstagramExtractor extends BaseExtractor {
  constructor() {
    super("Instagram");
    this._processedPosts = new Set();
    this._apiAttempted = false;
  }

  static get URL_PATTERNS() {
    return [
      {
        match:
          /^https?:\/\/(www\.)?instagram\.com\/(p|reel|reels|tv|stories)\//,
      },
      { match: /^https?:\/\/(www\.)?instagram\.com\/?$/ },
      { match: /^https?:\/\/(www\.)?instagram\.com\/[^/]+\/?$/ },
    ];
  }

  static get GRAPHQL_DOC_ID() {
    return "8845758582119845";
  }
  static get APP_ID() {
    return "936619743392459";
  }
  static get API_BASE() {
    return "https://i.instagram.com/api/v1";
  }
  static get GRAPHQL_URL() {
    return "https://www.instagram.com/graphql/query/";
  }
  static get ENCODING_CHARS() {
    return "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  }
  static get MOBILE_UA() {
    return "Instagram 275.0.0.27.98 Android (33/13; 280dpi; 720x1423; Xiaomi; Redmi 7; onclite; qcom; en_US; 458229237)";
  }

  static shortcodeToPK(shortcode) {
    const chars = InstagramExtractor.ENCODING_CHARS;
    let pk = BigInt(0);
    const code =
      shortcode.length > 28
        ? shortcode.substring(0, shortcode.length - 28)
        : shortcode;
    for (let i = 0; i < Math.min(code.length, 11); i++) {
      const idx = chars.indexOf(code[i]);
      if (idx < 0) continue;
      pk = pk * BigInt(64) + BigInt(idx);
    }
    return pk.toString();
  }

  async init() {
    console.log(this.TAG, "Initializing (v2 — cobalt-inspired)");

    this._apiAttempted = false;
    this.timer(() => this._extractViaAPI(), 500);

    this.timer(() => this._scanPageData(), 1500);

    this._tryInjectNetworkHook();

    this.listen(window, "message", (e) => this._onInterceptedData(e));

    this.observe(
      document.body || document.documentElement,
      { childList: true, subtree: true },
      () => this._debouncedScan(),
    );

    this.timer(() => this._scanVideoElements(), 3000);

    console.log(this.TAG, "Initialized");
  }

  async extract() {
    const formats = this._extractFromPageData();
    return formats.length > 0
      ? {
          videoId: this._getPostId(),
          formats,
          formatSource: "instagram",
          title: document.title,
        }
      : null;
  }

  async _extractViaAPI() {
    if (this._apiAttempted) return;
    this._apiAttempted = true;

    const shortcode = this._getPostId();
    if (!shortcode) {
      console.log(
        this.TAG,
        "No shortcode found in URL — skipping API extraction",
      );
      return;
    }

    if (this._processedPosts.has(shortcode)) return;

    this._sendMessage({ action: "EXTRACTION_STARTED" });

    console.log(
      this.TAG,
      "=== Starting extraction cascade for shortcode:",
      shortcode,
      "===",
    );

    let mediaData = null;

    console.log(this.TAG, "[Tier 1] Trying GraphQL with token scraping...");
    mediaData = await this._fetchGraphQLWithTokens(shortcode);

    if (!mediaData) {
      console.log(this.TAG, "[Tier 2] Trying oEmbed -> v1 mobile API...");
      mediaData = await this._fetchViaOEmbed(shortcode);
    }

    if (!mediaData) {
      console.log(this.TAG, "[Tier 3] Trying embed/captioned page...");
      mediaData = await this._fetchEmbedCaptioned(shortcode);
    }

    if (mediaData) {
      this._processMediaData(shortcode, mediaData);
    } else {
      console.log(
        this.TAG,
        "All API tiers failed — relying on page data, network hook & DOM",
      );

      this.timer(() => {
        if (!this._processedPosts.has(shortcode)) {
          this._sendMessage({ action: "EXTRACTION_FAILED" });
        }
      }, 6000);
    }
  }

  async _fetchGraphQLWithTokens(shortcode) {
    try {

      const csrfToken = this._getCSRFToken();

      const simpleResult = await this._fetchGraphQLSimple(shortcode, csrfToken);
      if (simpleResult) return simpleResult;

      console.log(this.TAG, "Simple GraphQL failed, scraping page tokens...");
      const pageTokens = await this._scrapePageTokens(shortcode);
      if (!pageTokens) {
        console.log(this.TAG, "Could not scrape page tokens");
        return null;
      }

      return await this._fetchGraphQLFull(shortcode, pageTokens);
    } catch (e) {
      console.error(this.TAG, "Tier 1 error:", e);
      return null;
    }
  }

  async _fetchGraphQLSimple(shortcode, csrfToken) {
    try {
      const variables = JSON.stringify({
        shortcode,
        fetch_tagged_user_count: null,
        hoisted_comment_id: null,
        hoisted_reply_id: null,
      });

      const params = new URLSearchParams({
        doc_id: InstagramExtractor.GRAPHQL_DOC_ID,
        variables,
      });

      const headers = {
        "X-IG-App-ID": InstagramExtractor.APP_ID,
        "X-Requested-With": "XMLHttpRequest",
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: `https://www.instagram.com/p/${shortcode}/`,
      };

      if (csrfToken) {
        headers["X-CSRFToken"] = csrfToken;
      }

      const response = await this._sendMessage({
        action: "FETCH_URL",
        url: InstagramExtractor.GRAPHQL_URL,
        options: {
          method: "POST",
          headers,
          body: params.toString(),
        },
      });

      if (response?.error) {
        console.log(this.TAG, "Simple GraphQL error:", response.error);
        return null;
      }

      const data = response?.data;
      if (!data) return null;

      const media =
        data?.data?.xdt_shortcode_media ||
        data?.data?.shortcode_media ||
        data?.data?.xdt_api__v1__media__shortcode__web_info?.items?.[0];

      if (!media) {
        console.log(this.TAG, "No media in simple GraphQL response");
        return null;
      }

      console.log(this.TAG, "Simple GraphQL extraction successful!");
      return media;
    } catch (e) {
      console.log(this.TAG, "Simple GraphQL exception:", e.message);
      return null;
    }
  }

  async _scrapePageTokens(shortcode) {
    try {
      const response = await this._sendMessage({
        action: "FETCH_URL",
        url: `https://www.instagram.com/p/${shortcode}/`,
        options: {
          method: "GET",
          headers: {
            Accept: "text/html,application/xhtml+xml",
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          },
        },
      });

      if (response?.error) {
        console.log(this.TAG, "Page scrape error:", response.error);
        return null;
      }

      const html = response?.data;
      if (!html || typeof html !== "string") return null;

      console.log(this.TAG, "Scraped page HTML:", html.length, "chars");

      const csrf =
        html.match(/"csrf_token":"([^"]+)"/)?.[1] ||
        html.match(/csrftoken=([^;"\s]+)/)?.[1];

      const lsd = html.match(/\["LSD",\[\],\{"token":"([^"]+)"\}/)?.[1];

      const appId =
        html.match(/"appId":"(\d+)"/)?.[1] || InstagramExtractor.APP_ID;

      const deviceId = html.match(/"device_id":"([^"]+)"/)?.[1];
      const machineId = html.match(/"machine_id":"([^"]+)"/)?.[1];

      const bloksVersionId = html.match(/"bloks_version_id":"([^"]+)"/)?.[1];

      console.log(this.TAG, "Scraped tokens:", {
        csrf: csrf ? "found" : "missing",
        lsd: lsd ? "found" : "missing",
        deviceId: deviceId ? "found" : "missing",
        machineId: machineId ? "found" : "missing",
      });

      const ogImage =
        html.match(
          /<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i,
        )?.[1] ||
        html.match(
          /content=["']([^"']+)["']\s+property=["']og:image["']/i,
        )?.[1];
      if (ogImage) {
        this._pageThumbnail = ogImage.replace(/&amp;/g, "&");
        console.log(this.TAG, "Found og:image thumbnail from page");
      }

      const pageMediaData = this._extractMediaFromHTML(html);
      if (pageMediaData) {
        console.log(this.TAG, "Found media data directly in page HTML!");

        this._pageMediaFallback = pageMediaData;
      }

      return { csrf, lsd, appId, deviceId, machineId, bloksVersionId };
    } catch (e) {
      console.log(this.TAG, "Page scrape exception:", e.message);
      return null;
    }
  }

  _extractMediaFromHTML(html) {

    const vvMatch = html.match(/"video_versions"\s*:\s*(\[\{.+?\}\])/s);
    if (vvMatch) {
      try {
        const versions = JSON.parse(vvMatch[1]);
        if (versions.length > 0) {
          console.log(
            this.TAG,
            "Found video_versions in page HTML:",
            versions.length,
          );
          return { video_versions: versions, is_video: true };
        }
      } catch (e) {}
    }

    const vuMatch = html.match(/"video_url"\s*:\s*"(https?:[^"]+)"/);
    if (vuMatch) {
      const videoUrl = vuMatch[1]
        .replace(/\\u0026/g, "&")
        .replace(/\\\//g, "/")
        .replace(/\\u002F/g, "/");
      console.log(this.TAG, "Found video_url in page HTML");
      return { video_url: videoUrl, is_video: true };
    }

    const dashMatch = html.match(/"dash_manifest(?:_url)?"\s*:\s*"([^"]+)"/);
    if (dashMatch) {
      console.log(this.TAG, "Found dash_manifest in page HTML");

    }

    return null;
  }

  async _fetchGraphQLFull(shortcode, tokens) {
    try {
      const headers = {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-IG-App-ID": tokens.appId || InstagramExtractor.APP_ID,
        "X-CSRFToken": tokens.csrf || "",
        "X-FB-LSD": tokens.lsd || "",
        "X-Requested-With": "XMLHttpRequest",
        "X-ASBD-ID": "129477",
        "X-IG-WWW-Claim": "0",
        Origin: "https://www.instagram.com",
        Referer: `https://www.instagram.com/p/${shortcode}/`,
      };

      const body = new URLSearchParams({
        doc_id: InstagramExtractor.GRAPHQL_DOC_ID,
        variables: JSON.stringify({
          shortcode,
          fetch_tagged_user_count: null,
          hoisted_comment_id: null,
          hoisted_reply_id: null,
        }),
        fb_api_caller_class: "RelayModern",
        fb_api_req_friendly_name: "PolarisPostActionLoadPostQueryQuery",
        server_timestamps: "true",
        lsd: tokens.lsd || "",
      });

      const response = await this._sendMessage({
        action: "FETCH_URL",
        url: InstagramExtractor.GRAPHQL_URL,
        options: {
          method: "POST",
          headers,
          body: body.toString(),
        },
      });

      if (response?.error) {
        console.log(this.TAG, "Full GraphQL error:", response.error);

        if (this._pageMediaFallback) {
          console.log(this.TAG, "Using page media fallback from scrape step");
          return this._pageMediaFallback;
        }
        return null;
      }

      const data = response?.data;
      if (!data) {
        if (this._pageMediaFallback) return this._pageMediaFallback;
        return null;
      }

      const media =
        data?.data?.xdt_shortcode_media || data?.data?.shortcode_media;

      if (!media) {
        console.log(this.TAG, "No media in full GraphQL response");
        if (this._pageMediaFallback) return this._pageMediaFallback;
        return null;
      }

      console.log(this.TAG, "Full GraphQL extraction successful!");
      return media;
    } catch (e) {
      console.log(this.TAG, "Full GraphQL exception:", e.message);
      if (this._pageMediaFallback) return this._pageMediaFallback;
      return null;
    }
  }

  async _fetchViaOEmbed(shortcode) {
    try {

      const oembedUrl = `https://i.instagram.com/api/v1/oembed/?url=https://www.instagram.com/p/${shortcode}/`;

      const oembedResp = await this._sendMessage({
        action: "FETCH_URL",
        url: oembedUrl,
        options: {
          method: "GET",
          headers: { Referer: "https://www.instagram.com/" },
        },
      });

      let mediaId = null;

      if (oembedResp?.error) {
        console.log(this.TAG, "oEmbed error:", oembedResp.error);

      } else {
        mediaId = oembedResp?.data?.media_id;
      }

      if (!mediaId) {
        mediaId = InstagramExtractor.shortcodeToPK(shortcode);
        console.log(this.TAG, "oEmbed failed, using PK conversion:", mediaId);
      } else {
        console.log(this.TAG, "oEmbed media_id:", mediaId);
      }

      const infoUrl = `${InstagramExtractor.API_BASE}/media/${mediaId}/info/`;

      const infoResp = await this._sendMessage({
        action: "FETCH_URL",
        url: infoUrl,
        options: {
          method: "GET",
          headers: {
            "X-IG-App-ID": InstagramExtractor.APP_ID,
            "X-Requested-With": "XMLHttpRequest",
            "User-Agent": InstagramExtractor.MOBILE_UA,
            Referer: "https://www.instagram.com/",
          },
        },
      });

      if (infoResp?.error) {
        console.log(this.TAG, "v1 mobile API error:", infoResp.error);
        return null;
      }

      const item = infoResp?.data?.items?.[0];
      if (!item) {
        console.log(this.TAG, "No item in v1 mobile API response");
        return null;
      }

      console.log(this.TAG, "v1 mobile API extraction successful!");
      return item;
    } catch (e) {
      console.error(this.TAG, "Tier 2 error:", e);
      return null;
    }
  }

  async _fetchEmbedCaptioned(shortcode) {
    try {

      const embedUrl = `https://www.instagram.com/p/${shortcode}/embed/captioned/`;
      console.log(this.TAG, "Trying embed/captioned:", embedUrl);

      const response = await this._sendMessage({
        action: "FETCH_URL",
        url: embedUrl,
        options: {
          method: "GET",
          headers: {
            Accept: "text/html,application/xhtml+xml",
            Referer: "https://www.instagram.com/",
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          },
        },
      });

      if (response?.error) {
        console.log(this.TAG, "Embed/captioned fetch error:", response.error);

        return await this._fetchEmbedPlain(shortcode);
      }

      const html = response?.data;
      if (!html || typeof html !== "string") {
        console.log(this.TAG, "Embed/captioned: empty response");
        return await this._fetchEmbedPlain(shortcode);
      }

      console.log(this.TAG, "Embed/captioned page: got", html.length, "chars");

      let result = this._parseEmbedCobaltStyle(html);
      if (result) return result;

      result = this._parseEmbedAdditionalData(html);
      if (result) return result;

      result = this._parseEmbedVideoUrl(html);
      if (result) return result;

      result = this._parseEmbedVideoVersions(html);
      if (result) return result;

      result = this._parseEmbedVideoElement(html);
      if (result) return result;

      result = this._parseEmbedGqlData(html);
      if (result) return result;

      console.log(this.TAG, "Embed/captioned: no video data found");

      return await this._fetchEmbedPlain(shortcode);
    } catch (e) {
      console.error(this.TAG, "Tier 3 error:", e);
      return null;
    }
  }

  async _fetchEmbedPlain(shortcode) {
    try {
      const embedUrl = `https://www.instagram.com/p/${shortcode}/embed/`;
      console.log(this.TAG, "Trying plain embed:", embedUrl);

      const response = await this._sendMessage({
        action: "FETCH_URL",
        url: embedUrl,
        options: {
          method: "GET",
          headers: {
            Accept: "text/html,application/xhtml+xml",
            Referer: "https://www.instagram.com/",
          },
        },
      });

      if (response?.error) {
        console.log(this.TAG, "Plain embed error:", response.error);
        return null;
      }

      const html = response?.data;
      if (!html || typeof html !== "string") return null;

      console.log(this.TAG, "Plain embed page: got", html.length, "chars");

      return (
        this._parseEmbedCobaltStyle(html) ||
        this._parseEmbedAdditionalData(html) ||
        this._parseEmbedVideoUrl(html) ||
        this._parseEmbedVideoVersions(html) ||
        this._parseEmbedVideoElement(html) ||
        this._parseEmbedGqlData(html) ||
        null
      );
    } catch (e) {
      console.log(this.TAG, "Plain embed error:", e.message);
      return null;
    }
  }

  _parseEmbedCobaltStyle(html) {
    try {
      const initMatch = html.match(/"init",\[\],\[(.*?)\]\],/s);
      if (!initMatch) return null;

      let embedData = JSON.parse(initMatch[1]);
      if (embedData?.contextJSON) {
        const context = JSON.parse(embedData.contextJSON);
        if (
          context?.video_url ||
          context?.video_versions ||
          context?.is_video
        ) {
          console.log(this.TAG, "Embed: cobalt init regex found video data");
          return context;
        }

        const media = context?.media || context?.shortcode_media;
        if (media && (media.video_url || media.video_versions)) {
          console.log(this.TAG, "Embed: cobalt init regex found nested media");
          return media;
        }
      }
    } catch (e) {

      try {
        const altMatch = html.match(
          /"init",\[\],\[\{"contextJSON":\s*"((?:\\.|[^"\\])*)"/,
        );
        if (altMatch) {
          const context = JSON.parse(JSON.parse(`"${altMatch[1]}"`));
          if (context?.video_url || context?.video_versions) {
            console.log(this.TAG, "Embed: alt cobalt regex found data");
            return context;
          }
        }
      } catch (e2) {}
    }
    return null;
  }

  _parseEmbedAdditionalData(html) {
    const match = html.match(
      /window\.__additionalDataLoaded\s*\(\s*['"][^'"]*['"]\s*,\s*(\{.+?\})\s*\)/s,
    );
    if (!match) return null;

    try {
      const data = JSON.parse(match[1]);

      const item = data?.items?.[0];
      if (item && (item.video_versions || item.video_url)) {
        console.log(this.TAG, "Embed: __additionalDataLoaded product item");
        return item;
      }

      const media = data?.graphql?.shortcode_media || data?.shortcode_media;
      if (media && (media.video_url || media.is_video)) {
        console.log(this.TAG, "Embed: __additionalDataLoaded graphql media");
        return media;
      }
    } catch (e) {
      console.log(this.TAG, "Embed: __additionalDataLoaded parse error");
    }
    return null;
  }

  _parseEmbedVideoUrl(html) {
    const match = html.match(/"video_url"\s*:\s*"(https?:[^"]+)"/);
    if (!match) return null;

    const videoUrl = match[1]
      .replace(/\\u0026/g, "&")
      .replace(/\\\//g, "/")
      .replace(/\\u002F/g, "/");

    const wMatch = html.match(/"(?:original_)?width"\s*:\s*(\d+)/);
    const hMatch = html.match(/"(?:original_)?height"\s*:\s*(\d+)/);

    console.log(this.TAG, "Embed: found video_url in HTML");
    return {
      video_url: videoUrl,
      is_video: true,
      dimensions: {
        width: wMatch ? parseInt(wMatch[1]) : 0,
        height: hMatch ? parseInt(hMatch[1]) : 0,
      },
    };
  }

  _parseEmbedVideoVersions(html) {
    const match = html.match(/"video_versions"\s*:\s*(\[\{.+?\}\])/s);
    if (!match) return null;

    try {
      const versions = JSON.parse(match[1]);
      if (versions.length > 0) {
        console.log(this.TAG, "Embed: found video_versions");
        return { video_versions: versions, is_video: true };
      }
    } catch (e) {}
    return null;
  }

  _parseEmbedVideoElement(html) {
    const match = html.match(/<video[^>]+src=["']([^"']+)["']/);
    if (!match) return null;

    const src = match[1].replace(/&amp;/g, "&").replace(/&#x2F;/g, "/");

    if (src.startsWith("http")) {
      console.log(this.TAG, "Embed: found <video> src");
      return { video_url: src, is_video: true };
    }
    return null;
  }

  _parseEmbedGqlData(html) {
    const match = html.match(
      /gql_data['"]\s*:\s*(\{.*?"shortcode_media".*?\})\s*[,}]/s,
    );
    if (!match) return null;

    try {
      const media = JSON.parse(match[1])?.shortcode_media;
      if (media && (media.video_url || media.is_video)) {
        console.log(this.TAG, "Embed: found gql_data media");
        return media;
      }
    } catch (e) {}
    return null;
  }

  _sendMessage(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (response) => {
          if (chrome.runtime.lastError) {
            console.log(
              this.TAG,
              "sendMessage error:",
              chrome.runtime.lastError.message,
            );
            resolve(null);
          } else {
            resolve(response);
          }
        });
      } catch (e) {
        console.error(this.TAG, "sendMessage exception:", e);
        resolve(null);
      }
    });
  }

  _processMediaData(shortcode, media) {
    if (this._processedPosts.has(shortcode)) return;
    this._processedPosts.add(shortcode);

    const carouselItems =
      media.carousel_media ||
      media.edge_sidecar_to_children?.edges?.map((e) => e.node);

    if (carouselItems && carouselItems.length > 0) {
      console.log(
        this.TAG,
        "Carousel post with",
        carouselItems.length,
        "items",
      );
      let videoCount = 0;
      for (const item of carouselItems) {
        if (this._isVideoMedia(item)) {
          videoCount++;
          const itemId =
            item.shortcode ||
            item.code ||
            item.pk ||
            `${shortcode}_${videoCount}`;
          this._extractAndSendFormats(String(itemId), item, media);
        }
      }
      if (videoCount === 0) {
        console.log(this.TAG, "Carousel has no video items");
      }
      return;
    }

    if (this._isVideoMedia(media)) {
      this._extractAndSendFormats(shortcode, media, media);
    } else {
      console.log(
        this.TAG,
        "Media is not a video (is_video=false or no video_url)",
      );
    }
  }

  _isVideoMedia(item) {
    return (
      item.is_video === true ||
      item.__typename === "GraphVideo" ||
      item.__typename === "XDTGraphVideo" ||
      item.media_type === 2 ||
      !!item.video_url ||
      !!item.video_versions
    );
  }

  _extractAndSendFormats(id, item, parentMedia) {
    const formats = [];

    if (item.video_versions && Array.isArray(item.video_versions)) {
      const sorted = [...item.video_versions].sort(
        (a, b) =>
          (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0),
      );

      for (let i = 0; i < sorted.length; i++) {
        const v = sorted[i];
        if (!v.url) continue;
        const h = v.height || 0;
        const quality = this._qualityLabel(h);

        formats.push(
          this.buildFormat({
            url: v.url,
            itag: v.id || i,
            mimeType: "video/mp4",
            quality,
            qualityLabel: i === 0 ? quality : `${quality} (${v.type || i})`,
            width: v.width || 0,
            height: h,
            isVideo: true,
            isMuxed: true,
            ext: "mp4",
          }),
        );
      }
    }

    if (item.video_url && formats.length === 0) {
      const h = item.dimensions?.height || item.original_height || 0;
      const w = item.dimensions?.width || item.original_width || 0;

      formats.push(
        this.buildFormat({
          url: item.video_url,
          mimeType: "video/mp4",
          quality: this._qualityLabel(h),
          qualityLabel: this._qualityLabel(h),
          width: w,
          height: h,
          isVideo: true,
          isMuxed: true,
          ext: "mp4",
        }),
      );
    }

    if (formats.length === 0) return;

    const duration = item.video_duration || 0;
    const title = this._extractTitle(item, parentMedia);
    const thumbnail = this._extractThumbnail(item);

    console.log(
      this.TAG,
      `Found ${formats.length} format(s) for ${id}: ${formats.map((f) => f.qualityLabel).join(", ")}`,
    );

    this.sendToBackground({
      videoId: id,
      formats,
      formatSource: "instagram_api",
      title: title || document.title,
      duration,
      thumbnail,
      extra: {
        author: this._extractAuthor(item, parentMedia),
      },
    });
  }

  _scanPageData() {
    const formats = this._extractFromPageData();
    if (formats.length > 0) {
      this.sendToBackground({
        videoId: this._getPostId() || "ig_unknown",
        formats,
        formatSource: "instagram_page",
        title: document.title,
      });
    }
  }

  _extractFromPageData() {
    const formats = [];

    for (const script of document.querySelectorAll("script:not([src])")) {
      const text = script.textContent;
      if (!text) continue;

      if (text.includes("window._sharedData")) {
        const match = text.match(
          /window\._sharedData\s*=\s*(\{.+?\})\s*;?\s*$/ms,
        );
        if (match) {
          try {
            this._findVideosInObject(JSON.parse(match[1]), formats);
          } catch (e) {
            console.log(this.TAG, "_sharedData parse error:", e.message);
          }
        }
      }

      if (text.includes("__additionalDataLoaded")) {
        const match = text.match(
          /__additionalDataLoaded\s*\(\s*['"][^'"]+['"]\s*,\s*(\{.+?\})\s*\)/ms,
        );
        if (match) {
          try {
            this._findVideosInObject(JSON.parse(match[1]), formats);
          } catch (e) {}
        }
      }

      if (text.includes("video_url") || text.includes("video_versions")) {
        const jsonMatches = text.matchAll(
          /\{[^{}]*"video_url"\s*:\s*"https?:[^"]+?"[^{}]*\}/g,
        );
        for (const jm of jsonMatches) {
          try {
            this._findVideosInObject(JSON.parse(jm[0]), formats);
          } catch (e) {}
        }
      }
    }

    const nextScript = document.getElementById("__NEXT_DATA__");
    if (nextScript) {
      try {
        this._findVideosInObject(JSON.parse(nextScript.textContent), formats);
      } catch (e) {}
    }

    return formats;
  }

  _findVideosInObject(obj, formats, depth = 0) {
    if (!obj || typeof obj !== "object" || depth > 25) return;

    if (
      obj.video_versions &&
      Array.isArray(obj.video_versions) &&
      obj.video_versions.length > 0
    ) {
      const id = String(obj.shortcode || obj.code || obj.pk || obj.id || "");
      if (id && !this._processedPosts.has(id)) {
        this._processedPosts.add(id);
        const best = [...obj.video_versions].sort(
          (a, b) =>
            (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0),
        )[0];
        if (best?.url) {
          formats.push(
            this.buildFormat({
              url: best.url,
              mimeType: "video/mp4",
              quality: this._qualityLabel(best.height || 0),
              qualityLabel: this._qualityLabel(best.height || 0),
              width: best.width || 0,
              height: best.height || 0,
              isVideo: true,
              isMuxed: true,
              ext: "mp4",
            }),
          );
        }
      }
    } else if (obj.video_url && typeof obj.video_url === "string") {
      const id = String(obj.shortcode || obj.id || "");
      if (id && !this._processedPosts.has(id)) {
        this._processedPosts.add(id);
        const h = obj.dimensions?.height || obj.original_height || 0;
        formats.push(
          this.buildFormat({
            url: obj.video_url,
            mimeType: "video/mp4",
            quality: this._qualityLabel(h),
            qualityLabel: this._qualityLabel(h),
            width: obj.dimensions?.width || obj.original_width || 0,
            height: h,
            isVideo: true,
            isMuxed: true,
            ext: "mp4",
          }),
        );
      }
    }

    if (Array.isArray(obj)) {
      for (const item of obj)
        this._findVideosInObject(item, formats, depth + 1);
    } else {
      for (const key of Object.keys(obj)) {
        this._findVideosInObject(obj[key], formats, depth + 1);
      }
    }
  }

  _tryInjectNetworkHook() {
    this._sendMessage({
      action: "INJECT_INSTAGRAM_HOOK",
    }).then((resp) => {
      if (resp?.success) {
        console.log(this.TAG, "Network hook injected via background");
      } else {
        console.log(
          this.TAG,
          "Network hook injection skipped:",
          resp?.error || "unknown",
        );
      }
    });
  }

  _onInterceptedData(e) {
    if (!e.data || e.data.type !== "__instagram_extractor__") return;
    if (e.data.action !== "API_VIDEOS") return;

    for (const video of e.data.videos) {
      if (this._processedPosts.has(video.id)) continue;
      this._processedPosts.add(video.id);

      const formats = [];

      if (video.videoUrl) {
        const h = video.height || 0;
        formats.push(
          this.buildFormat({
            url: video.videoUrl,
            mimeType: "video/mp4",
            quality: this._qualityLabel(h),
            qualityLabel: this._qualityLabel(h),
            width: video.width || 0,
            height: h,
            isVideo: true,
            isMuxed: true,
            ext: "mp4",
          }),
        );
      }

      if (video.allVersions) {
        for (const v of video.allVersions) {
          if (v.url === video.videoUrl) continue;
          const h = v.height || 0;
          formats.push(
            this.buildFormat({
              url: v.url,
              mimeType: "video/mp4",
              quality: this._qualityLabel(h),
              qualityLabel: `${this._qualityLabel(h)} (alt)`,
              width: v.width || 0,
              height: h,
              isVideo: true,
              isMuxed: true,
              ext: "mp4",
            }),
          );
        }
      }

      if (formats.length > 0) {
        this.sendToBackground({
          videoId: video.shortcode || video.id,
          formats,
          formatSource: "instagram_hook",
          title: document.title,
          duration: video.duration || null,
        });
      }
    }
  }

  _debouncedScan = this.debounce(() => this._scanVideoElements(), 1500);

  _scanVideoElements() {
    const videos = document.querySelectorAll("video");
    for (const video of videos) {
      const src = video.src || video.currentSrc;
      if (
        !src ||
        src.startsWith("blob:") ||
        src.startsWith("data:") ||
        !/^https?:/.test(src)
      )
        continue;
      if (this._processedPosts.has(src)) continue;
      this._processedPosts.add(src);

      this.sendToBackground({
        videoId: this._getPostId() || src.substring(src.length - 16),
        formats: [
          this.buildFormat({
            url: src,
            mimeType: "video/mp4",
            quality: "Direct",
            qualityLabel: "Direct Video",
            width: video.videoWidth || 0,
            height: video.videoHeight || 0,
            isVideo: true,
            isMuxed: true,
            ext: "mp4",
          }),
        ],
        formatSource: "instagram_dom",
        title: document.title,
      });
    }
  }

  _qualityLabel(height) {
    if (!height || height <= 0) return "SD";
    if (height >= 1080) return "1080p";
    if (height >= 720) return "720p";
    if (height >= 480) return "480p";
    if (height >= 360) return "360p";
    return `${height}p`;
  }

  _extractTitle(item, parent) {
    const caption =
      item.caption?.text ||
      parent?.caption?.text ||
      item.edge_media_to_caption?.edges?.[0]?.node?.text;
    if (caption) {
      return caption.split("\n")[0].substring(0, 80).trim();
    }
    return null;
  }

  _extractAuthor(item, parent) {
    return (
      item.user?.username ||
      parent?.user?.username ||
      item.owner?.username ||
      parent?.owner?.username ||
      null
    );
  }

  _extractThumbnail(item) {
    const candidates = item.image_versions2?.candidates;
    if (candidates && candidates.length > 0) {
      const best = [...candidates].sort(
        (a, b) =>
          (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0),
      )[0];
      if (best?.url) return best.url;
    }
    const resources = item.display_resources;
    if (resources && resources.length > 0) {
      const src = resources[resources.length - 1]?.src;
      if (src) return src;
    }
    if (item.display_url) return item.display_url;
    if (item.thumbnail_src) return item.thumbnail_src;

    if (this._pageThumbnail) return this._pageThumbnail;

    try {
      const ogMeta = document.querySelector('meta[property="og:image"]');
      if (ogMeta?.content) return ogMeta.content;
    } catch (e) {}

    return null;
  }

  _getCSRFToken() {
    const match = document.cookie.match(/csrftoken=([^;]+)/);
    if (match) return match[1];
    const meta = document.querySelector('meta[name="csrf-token"]');
    if (meta) return meta.getAttribute("content");
    return null;
  }

  _getPostId() {
    const m = window.location.pathname.match(
      /\/(p|reel|reels|tv)\/([A-Za-z0-9_-]+)/,
    );
    return m ? m[2] : null;
  }

  destroy() {
    this._processedPosts.clear();
    super.destroy();
  }
}

if (typeof globalThis !== "undefined") {
  globalThis.InstagramExtractor = InstagramExtractor;
}
