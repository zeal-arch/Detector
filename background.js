const CLIENTS = {
  android_vr: {
    client: {
      clientName: "ANDROID_VR",
      clientVersion: "1.71.26",
      deviceMake: "Oculus",
      deviceModel: "Quest 3",
      androidSdkVersion: 32,
      osName: "Android",
      osVersion: "12L",
    },
    userAgent:
      "com.google.android.apps.youtube.vr.oculus/1.71.26 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip",
    clientId: 28,
    requireCipher: false,
  },
  web: {
    client: {
      clientName: "WEB",
      clientVersion: "2.20260114.08.00",
      osName: "Windows",
      osVersion: "10.0",
      platform: "DESKTOP",
    },
    userAgent: null,
    clientId: 1,
    requireCipher: true,
  },
  // web_embedded: fallback for age-restricted & "made for kids" videos
  // that android_vr returns UNPLAYABLE for. Uses WEB_EMBEDDED_PLAYER which
  // can work around age-gate for embeddable videos (per yt-dlp).
  web_embedded: {
    client: {
      clientName: "WEB_EMBEDDED_PLAYER",
      clientVersion: "1.20260115.01.00",
    },
    // thirdParty context is added automatically in innertubeRequest()
    userAgent: null,
    clientId: 56,
    requireCipher: true,
  },
};

const tabData = new Map();
const sigCache = new Map();
const pendingRequests = new Map();
const sniffedStreams = new Map();
const contentHashes = new Map();
const mergeProgress = new Map();
const REFERER_RULE_ID = 1;
let activeMergeId = null;
let mergeKeepaliveTimer = null; // Keeps SW alive during merge

// Import DRM detection utility
importScripts("lib/drm-detection.js");

async function captureMetadata(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const selectors = [
          { sel: "#vp-preview", attr: "data-thumb" },
          { sel: "meta[property='og:image:secure_url']", attr: "content" },
          { sel: "meta[property='og:image']", attr: "content" },
          { sel: "link[as='image']", attr: "href" },
          { sel: "link[rel='thumbnail']", attr: "href" },
          { sel: "link[rel='image_src']", attr: "href" },
          { sel: "meta[property='twitter:image']", attr: "content" },
          { sel: "video", attr: "poster" },
        ];
        let thumbnail = null;
        for (const d of selectors) {
          const el = document.querySelector(d.sel);
          if (el) {
            const val = el.getAttribute(d.attr);
            if (val) {
              thumbnail = val;
              break;
            }
          }
        }
        const titleMeta = document.querySelector("meta[property='og:title']");
        return {
          title: titleMeta?.content || document.title,
          thumbnail,
          duration: document.querySelector("video")?.duration || null,
        };
      },
    });
    if (results?.[0]?.result) {
      const res = results[0].result;
      if (typeof res.duration === "number" && !isNaN(res.duration)) {
        const mins = Math.floor(res.duration / 60);
        const secs = Math.floor(res.duration % 60);
        res.duration = `${mins}:${String(secs).padStart(2, "0")}`;
      }
      return res;
    }
  } catch (err) {
    console.warn("[BG] captureMetadata failed:", err.message);
  }
  return null;
}

function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

function normalizeUrlForDedup(url) {
  try {
    const u = new URL(url);

    const volatileParams = [
      "_",
      "token",
      "nonce",
      "expire",
      "ei",
      "ip",
      "sparams",
      "sig",
      "signature",
      "key",
      "hash",
      "ts",
      "timestamp",
      "nocache",
      "session_id",
      "sid",
      "rn",
      "rbuf",
      "clen",
      "dur",
      "lmt",
      "keepalive",
      "fexp",
      "txp",
      "vprv",
      "playlist_type",
    ];
    for (const p of volatileParams) u.searchParams.delete(p);

    u.searchParams.sort();
    return u.origin + u.pathname + (u.search || "");
  } catch {
    return url;
  }
}

let _dnrRuleCounter = 100000;
function nextDNRRuleId() {
  const id = _dnrRuleCounter++;
  if (_dnrRuleCounter > 999999) _dnrRuleCounter = 100000;
  return id;
}

const bcIn = new BroadcastChannel("offscreen_to_service");
const bcOut = new BroadcastChannel("service_to_offscreen");

bcIn.onmessage = (e) => {
  const msg = e.data;
  if (!msg?.type) return;

  switch (msg.type) {
    case "PONG":
      break;

    case "MERGE_PROGRESS":
      mergeProgress.set(msg.key, {
        phase: msg.phase,
        message: msg.message,
        percent: msg.percent,
        speed: msg.speed,
      });
      chrome.storage.session.get("activeMerge", (result) => {
        if (result?.activeMerge) {
          chrome.storage.session
            .set({
              activeMerge: {
                ...result.activeMerge,
                phase: msg.phase,
                message: msg.message,
                percent: msg.percent,
                speed: msg.speed,
              },
            })
            .catch(() => {});
        }
      });
      break;

    case "WORKER_PROGRESS":
      if (msg.downloadId) {
        chrome.storage.session.get("activeDownloads", (result) => {
          const downloads = result?.activeDownloads || {};
          downloads[msg.downloadId] = {
            phase: msg.phase,
            message: msg.message,
            percent: msg.percent,
            filename: msg.filename,
            ts: Date.now(),
          };
          chrome.storage.session
            .set({ activeDownloads: downloads })
            .catch(() => {});
        });
        notifyDownloadProgress(msg);
      }
      break;
  }
};

function persistTabData() {
  const obj = {};
  for (const [tabId, data] of tabData) obj[tabId] = data;
  chrome.storage.session.set({ tabDataCache: obj }).catch(() => {});
}

chrome.storage.session.get(["tabDataCache", "activeMerge"], (result) => {
  if (result?.tabDataCache) {
    for (const [tabId, data] of Object.entries(result.tabDataCache)) {
      tabData.set(parseInt(tabId), data);
    }
    console.log("[BG] Restored", tabData.size, "tab entries from session");
  }

  // If the SW restarted while a merge was active, try to auto-resume
  if (result?.activeMerge?.status === "active") {
    const merge = result.activeMerge;
    if (merge.videoId && merge.videoItag && merge.audioItag) {
      console.log(
        "[BG] SW restarted during active merge — attempting auto-resume for",
        merge.videoId,
      );
      chrome.storage.session
        .set({
          activeMerge: {
            ...merge,
            phase: "resuming",
            message: "Reconnecting after restart...",
          },
        })
        .catch(() => {});
      // Kick off resume asynchronously
      resumeMergeFromState(merge).catch((e) => {
        console.error("[BG] Auto-resume failed:", e.message);
        chrome.storage.session
          .set({
            activeMerge: {
              ...merge,
              status: "failed",
              error: "Resume failed: " + e.message,
            },
          })
          .catch(() => {});
      });
    } else {
      console.warn(
        "[BG] SW restarted during merge but no videoId/itags stored — marking failed",
      );
      chrome.storage.session
        .set({
          activeMerge: {
            ...merge,
            status: "failed",
            error: "Service worker restarted (no resume data)",
          },
        })
        .catch(() => {});
    }
  }
});

const INSTAGRAM_REFERER_RULE_ID = 2;
const TWITTER_REFERER_RULE_ID = 3;

chrome.declarativeNetRequest
  .updateDynamicRules({
    removeRuleIds: [
      REFERER_RULE_ID,
      INSTAGRAM_REFERER_RULE_ID,
      TWITTER_REFERER_RULE_ID,
    ],
    addRules: [
      {
        id: REFERER_RULE_ID,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            {
              header: "Referer",
              operation: "set",
              value: "https://www.youtube.com/",
            },
            {
              header: "Origin",
              operation: "set",
              value: "https://www.youtube.com",
            },
          ],
        },
        condition: {
          urlFilter: "||googlevideo.com/",
          resourceTypes: ["xmlhttprequest", "media", "other"],
        },
      },

      {
        id: INSTAGRAM_REFERER_RULE_ID,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            {
              header: "Referer",
              operation: "set",
              value: "https://www.instagram.com/",
            },
            {
              header: "Origin",
              operation: "set",
              value: "https://www.instagram.com",
            },
          ],
        },
        condition: {
          regexFilter: ".*\\.(cdninstagram\\.com|fbcdn\\.net)/.*",
          resourceTypes: ["xmlhttprequest", "media", "other"],
        },
      },

      {
        id: TWITTER_REFERER_RULE_ID,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            {
              header: "Referer",
              operation: "set",
              value: "https://x.com/",
            },
          ],
        },
        condition: {
          urlFilter: "||twimg.com/",
          resourceTypes: ["xmlhttprequest", "media", "other"],
        },
      },
    ],
  })
  .catch((e) => console.warn("[BG] DNR rule error:", e.message));

async function fetchWithDNRHeaders(url, headers, fetchOptions = {}) {
  const ruleId = nextDNRRuleId();

  const validHeaders = Object.entries(headers).filter(
    ([, v]) => v != null && v !== "",
  );
  const requestHeaders = validHeaders.map(([name, value]) => ({
    header: name,
    operation: "set",
    value: String(value),
  }));

  if (requestHeaders.length === 0) {
    return fetch(url, fetchOptions);
  }

  let urlFilter;
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtube.com")) {
      urlFilter = url.split("?")[0];
    } else {
      urlFilter = "||" + u.hostname + u.pathname;
    }
  } catch {
    urlFilter = url.split("?")[0];
  }

  const rule = {
    id: ruleId,
    priority: 2,
    action: { type: "modifyHeaders", requestHeaders },
    condition: {
      urlFilter,
      resourceTypes: ["xmlhttprequest", "media", "other"],
    },
  };

  try {
    await chrome.declarativeNetRequest.updateSessionRules({ addRules: [rule] });
    return await fetch(url, fetchOptions);
  } finally {
    await chrome.declarativeNetRequest
      .updateSessionRules({
        removeRuleIds: [ruleId],
      })
      .catch(() => {});
  }
}

const MERGE_UA_RULE_ID = 50000;

async function addMergeHeaders(videoUrl, audioUrl) {
  // Only ANDROID_VR URLs need User-Agent spoofing for downloads.
  // YouTube has progressively blocked ios/android client direct downloads (403),
  // so we match the extension-youtube approach: only spoof UA for ANDROID_VR,
  // and use a simple urlFilter (proven to work) instead of regexFilter.
  const isVR =
    /[?&]c=ANDROID_VR/i.test(videoUrl || "") ||
    /[?&]c=ANDROID_VR/i.test(audioUrl || "");

  if (!isVR) {
    console.log("[BG] No ANDROID_VR URLs in merge — skipping UA rule");
    return [];
  }

  const rule = {
    id: MERGE_UA_RULE_ID,
    priority: 3,
    action: {
      type: "modifyHeaders",
      requestHeaders: [
        {
          header: "User-Agent",
          operation: "set",
          value: CLIENTS.android_vr.userAgent,
        },
      ],
    },
    condition: {
      urlFilter: "||googlevideo.com/",
      resourceTypes: ["xmlhttprequest", "media", "other"],
    },
  };

  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [MERGE_UA_RULE_ID],
    addRules: [rule],
  });
  console.log("[BG] Added ANDROID_VR User-Agent DNR rule for merge");
  return [MERGE_UA_RULE_ID];
}

async function removeMergeHeaders(ruleIds) {
  if (!ruleIds || !ruleIds.length) return;
  await chrome.declarativeNetRequest
    .updateSessionRules({ removeRuleIds: ruleIds })
    .catch(() => {});
  console.log("[BG] Removed merge DNR rules");
}

async function getYouTubeCookieHeader() {
  return new Promise((resolve) => {
    try {
      chrome.cookies.getAll({ domain: ".youtube.com" }, (cookies) => {
        if (!cookies || cookies.length === 0) {
          resolve("");
          return;
        }
        const cookieStr = cookies.map((c) => c.name + "=" + c.value).join("; ");
        resolve(cookieStr);
      });
    } catch {
      resolve("");
    }
  });
}

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg.target === "offscreen") return false;

  switch (msg.action) {
    case "VIDEO_DETECTED":
      onVideoDetected(msg, sender.tab?.id)
        .then(respond)
        .catch((e) => respond({ success: false, error: e.message }));
      return true;

    case "FETCH_URL":
      doFetchUrl(msg.url, msg.options || {})
        .then(respond)
        .catch((e) => respond({ error: e.message }));
      return true;

    case "EXTRACTION_STARTED":
      if (sender.tab?.id) {
        chrome.action.setBadgeText({ text: "...", tabId: sender.tab.id });
        chrome.action.setBadgeBackgroundColor({
          color: "#FFC107",
          tabId: sender.tab.id,
        });
      }
      return false;

    case "EXTRACTION_FAILED":
      if (sender.tab?.id && !tabData.has(sender.tab.id)) {
        chrome.action.setBadgeText({ text: "✗", tabId: sender.tab.id });
        chrome.action.setBadgeBackgroundColor({
          color: "#F44336",
          tabId: sender.tab.id,
        });
      }
      return false;

    case "INJECT_INSTAGRAM_HOOK":
      if (sender.tab?.id) {
        chrome.scripting
          .executeScript({
            target: { tabId: sender.tab.id, allFrames: false },
            files: ["extractors/sites/instagram-hook.js"],
            world: "MAIN",
          })
          .then(() => respond({ success: true }))
          .catch((e) => respond({ success: false, error: e.message }));
      } else {
        respond({ success: false, error: "No tab ID" });
      }
      return true;

    case "GET_VIDEO_INFO":
      onGetVideoInfo(msg.tabId, msg.videoId)
        .then(respond)
        .catch((e) => respond({ error: e.message }));
      return true;

    case "DOWNLOAD_VIDEO":
      doDownload(msg.url, msg.filename)
        .then(respond)
        .catch((e) => respond({ success: false, error: e.message }));
      return true;

    case "DOWNLOAD_MERGED":
      doMergedDownload(msg)
        .then(respond)
        .catch((e) => respond({ success: false, error: e.message }));
      return true;

    case "DOWNLOAD_BLOB":
      chrome.downloads.download(
        {
          url: msg.blobUrl,
          filename: msg.filename,
          saveAs: true,
        },
        (id) => {
          if (chrome.runtime.lastError) {
            respond({
              success: false,
              error: chrome.runtime.lastError.message,
            });
          } else {
            console.log("[BG] Blob download started, id:", id);
            respond({ success: true, downloadId: id });
          }
        },
      );
      return true;

    case "MERGE_PROGRESS":
      if (msg.target === "background") {
        mergeProgress.set(msg.key, {
          phase: msg.phase,
          message: msg.message,
          percent: msg.percent,
        });
      }
      return false;

    case "GET_MERGE_STATUS":
      respond({
        activeMergeId,
        progress: mergeProgress.get(activeMergeId) || null,
      });
      return true;

    case "GET_SNIFFED_STREAMS":
      respond({ streams: sniffedStreams.get(msg.tabId) || [] });
      return true;

    case "START_WORKER_DOWNLOAD":
      handleWorkerDownload(msg)
        .then(respond)
        .catch((e) => respond({ success: false, error: e.message }));
      return true;

    case "CANCEL_MERGE":
      chrome.runtime.sendMessage(
        { target: "offscreen", action: "CANCEL_MERGE" },
        (response) => {
          if (chrome.runtime.lastError) {
            respond({
              success: false,
              error: chrome.runtime.lastError.message,
            });
          } else {
            respond(response || { success: false });
          }
        },
      );
      return true;

    case "WORKER_PROGRESS":
      return false;

    case "WORKER_COMPLETE":
      if (msg.downloadId) {
        chrome.storage.session.get("activeDownloads", (result) => {
          const downloads = result?.activeDownloads || {};
          downloads[msg.downloadId] = {
            phase: msg.success ? "complete" : "error",
            message: msg.success ? "Download complete" : msg.error,
            percent: msg.success ? 100 : 0,
            filename: msg.filename,
            ts: Date.now(),
          };
          chrome.storage.session
            .set({ activeDownloads: downloads })
            .catch(() => {});

          setTimeout(() => {
            chrome.storage.session.get("activeDownloads", (r) => {
              const d = r?.activeDownloads || {};
              delete d[msg.downloadId];
              chrome.storage.session
                .set({ activeDownloads: d })
                .catch(() => {});
            });
          }, 15000);
        });
        if (msg.success) {
          notifyComplete(msg.filename);
        }
      }
      return false;

    case "REMOVE_SESSION_HEADERS":
      if (msg.ruleId) {
        removeSessionHeaders(msg.ruleId).catch(() => {});
      }
      return false;

    case "SPECIALIST_DETECTED":
      onSpecialistDetected(msg, sender.tab?.id)
        .then(respond)
        .catch((e) => respond({ success: false, error: e.message }));
      return true;
  }
});

chrome.webNavigation.onHistoryStateUpdated.addListener(
  (details) => {
    if (details.frameId !== 0) return;
    const vid = extractVideoIdFromUrl(details.url);
    if (!vid) return;
    const cached = tabData.get(details.tabId);
    if (cached?.videoId === vid) return;
    chrome.action.setBadgeText({ text: "...", tabId: details.tabId });
    chrome.action.setBadgeBackgroundColor({
      color: "#FFC107",
      tabId: details.tabId,
    });
  },
  { url: [{ hostSuffix: "youtube.com" }] },
);

function extractVideoIdFromUrl(url) {
  try {
    const u = new URL(url);
    return (
      u.searchParams.get("v") ||
      url.match(/\/shorts\/([\w-]{11})/)?.[1] ||
      url.match(/\/embed\/([\w-]{11})/)?.[1] ||
      url.match(/\/live\/([\w-]{11})/)?.[1]
    );
  } catch {
    return null;
  }
}

async function onVideoDetected(msg, tabId) {
  console.log("[BG] Video detected:", msg.videoId, "tab:", tabId);
  try {
    const info = await getFormats(msg.videoId, msg.pageData || {});

    // Check for DRM protection
    const drmCheck = DRMDetection.checkVideoData({
      ...info,
      pageUrl: msg.url,
      manifestContent: msg.pageData?.manifestContent,
    });

    if (drmCheck.hasDRM) {
      console.log("[BG] DRM detected:", drmCheck);
      info.drmDetected = true;
      info.drmType = drmCheck.drmType;
      info.drmSources = drmCheck.drmSources;
      info.drmConfidence = drmCheck.confidence;

      // Update badge to indicate DRM
      chrome.action.setBadgeText({ text: "DRM", tabId });
      chrome.action.setBadgeBackgroundColor({ color: "#FF9800", tabId });
    } else {
      chrome.action.setBadgeText({ text: "✓", tabId });
      chrome.action.setBadgeBackgroundColor({ color: "#4CAF50", tabId });
    }

    tabData.set(tabId, { videoId: msg.videoId, info, ts: Date.now() });
    persistTabData();

    if (tabId && (!info.thumbnail || info.title === "Video")) {
      captureMetadata(tabId).then((meta) => {
        if (!meta) return;
        let changed = false;
        if (!info.thumbnail && meta.thumbnail) {
          info.thumbnail = meta.thumbnail;
          changed = true;
        }
        if ((info.title === "Video" || !info.title) && meta.title) {
          info.title = meta.title;
          changed = true;
        }
        if (!info.lengthSeconds && meta.duration) {
          info.lengthSeconds = meta.duration;
          changed = true;
        }
        if (changed) {
          tabData.set(tabId, { videoId: msg.videoId, info, ts: Date.now() });
          persistTabData();
          console.log(
            "[BG] Enriched video with page metadata (thumbnail/title/duration)",
          );
        }
      });
    }

    return { success: true, info };
  } catch (e) {
    console.error("[BG] Error:", e);
    chrome.action.setBadgeText({ text: "✗", tabId });
    chrome.action.setBadgeBackgroundColor({ color: "#F44336", tabId });
    return { success: false, error: e.message };
  }
}

async function onGetVideoInfo(tabId, videoId) {
  let cached = tabData.get(tabId);

  if (!cached && tabId) {
    try {
      const stored = await chrome.storage.session.get("tabDataCache");
      if (stored?.tabDataCache?.[tabId]) {
        cached = stored.tabDataCache[tabId];
        tabData.set(tabId, cached);
      }
    } catch {}
  }

  if (cached?.info && (!videoId || cached.videoId === videoId)) {
    return cached.info;
  }
  if (!videoId) return { error: "No video ID" };
  const info = await getFormats(videoId, {});
  tabData.set(tabId, { videoId, info, ts: Date.now() });
  persistTabData();
  return info;
}

async function getFormats(videoId, pageData) {
  if (pendingRequests.has(videoId)) {
    return pendingRequests.get(videoId);
  }
  const promise = getFormatsInner(videoId, pageData);
  pendingRequests.set(videoId, promise);
  try {
    return await promise;
  } finally {
    pendingRequests.delete(videoId);
  }
}

async function getFormatsInner(videoId, pageData) {
  if (pageData.resolvedFormats && pageData.resolvedFormats.length > 0) {
    console.log(
      "[BG] ★ Tier 1: Using",
      pageData.resolvedFormats.length,
      "pre-deciphered formats from",
      pageData.formatSource || "inject.js",
    );

    let synItag = 80000;
    for (const f of pageData.resolvedFormats) {
      if (!f.itag || f.itag === 0) {
        f.itag = synItag++;
      }
    }

    // Apply N-sig transformation — inject.js extracts code but cannot eval it
    // (CSP blocks eval in MAIN world), so background must always apply n-sig
    const hasUntransformedN = pageData.resolvedFormats.some(
      (f) => f.url && /[?&]n=([^&]{15,})/.test(f.url),
    );

    if (hasUntransformedN) {
      let nSigCode = pageData.nSigCode || null;
      let sig = null;

      // Try to load signature data from player.js (background can fetch without CSP issues)
      const playerUrl = pageData.playerUrl || null;
      if (playerUrl) {
        try {
          sig = await loadSignatureData(playerUrl);
          nSigCode = nSigCode || sig?.nSigCode || null;
          console.log(
            "[BG] Tier 1: Loaded sig data for n-sig transform — nSig:",
            nSigCode ? "yes" : "none",
          );
        } catch (e) {
          console.warn("[BG] Tier 1: Failed to load sig data:", e.message);
        }
      }

      if (nSigCode) {
        console.log(
          "[BG] Tier 1: Applying N-sig transform to",
          pageData.resolvedFormats.length,
          "formats",
        );
        await applyNSig(pageData.resolvedFormats, sig || { nSigCode });
      } else {
        console.warn(
          "[BG] Tier 1: No N-sig code available — downloads may fail with 403",
        );
      }
    }

    const vd = pageData.playerResponse?.videoDetails || {};
    return {
      videoId: vd.videoId || videoId,
      title: vd.title || pageData.title || "Video",
      author: vd.author || pageData.author || "",
      lengthSeconds: parseInt(vd.lengthSeconds) || pageData.duration || 0,
      thumbnail:
        vd.thumbnail?.thumbnails?.slice(-1)[0]?.url || pageData.thumbnail || "",
      formats: pageData.resolvedFormats,
      clientUsed: pageData.formatSource || "page_deciphered",
    };
  }

  console.log(
    "[BG] Tier 1 unavailable (resolvedFormats:",
    pageData.resolvedFormats?.length || 0,
    "| resolveError:",
    pageData.resolveError || "none",
    "), trying Tier 2...",
  );

  let visitorData = pageData.visitorData || null;
  let playerUrl = pageData.playerUrl || null;
  let pagePlayerResp = pageData.playerResponse || null;
  let nSigCode = pageData.nSigCode || null;
  let cipherCode = pageData.cipherCode || null;
  let cipherArgName = pageData.cipherArgName || null;

  if (!visitorData || !playerUrl) {
    try {
      const pd = await fetchPageData(videoId);
      visitorData = visitorData || pd.visitorData;
      playerUrl = playerUrl || pd.playerUrl;
      pagePlayerResp = pagePlayerResp || pd.playerResponse;
    } catch (e) {
      console.warn("[BG] Page fetch failed:", e.message);
    }
  }

  let sig = null;
  if (playerUrl) {
    try {
      sig = await loadSignatureData(playerUrl);
      console.log(
        "[BG] Signature data loaded from background fetch —",
        "cipher:",
        sig.actionList ? "actions" : sig.cipherCode ? "code" : "none",
        "| nSig:",
        sig.nSigCode ? "yes" : "none",
      );
    } catch (e) {
      console.warn("[BG] Sig data load error:", e.message);
    }
  }

  if (nSigCode && sig && !sig.nSigCode) {
    sig.nSigCode = nSigCode;
  }

  if (cipherCode && sig && !sig.cipherCode) {
    sig.cipherCode = cipherCode;
    sig.cipherArgName = cipherArgName;
  }

  // Client cascade order — yt-dlp defaults: android_vr, web, web_safari
  // ios/android removed: they require PO tokens for HTTPS streaming (blocked)
  // android_testsuite removed: dead/unsupported by YouTube
  // web_embedded added dynamically as fallback for UNPLAYABLE/age-gated content
  const order = ["android_vr", "web"];
  let lastErr = null;
  let allFormats = [];
  let successfulClients = [];
  let bestVideoDetails = null;
  let triedWebEmbedded = false;

  for (const key of order) {
    try {
      console.log("[BG] Trying InnerTube client:", key);
      const cfg = CLIENTS[key];
      const resp = await innertubeRequest(
        key,
        videoId,
        visitorData,
        cfg.requireCipher ? pageData.sts || sig?.sts || null : null,
      );

      const status = resp.playabilityStatus?.status;
      const reason = resp.playabilityStatus?.reason || "";

      if (status === "ERROR" || reason.includes("unavailable")) {
        lastErr = reason || "Video unavailable";
        continue;
      }
      if (status === "LOGIN_REQUIRED") {
        // For age-gated content, try web_embedded as fallback
        if (!triedWebEmbedded && !order.includes("web_embedded")) {
          console.log(
            "[BG]",
            key,
            "returned LOGIN_REQUIRED — will try web_embedded",
          );
          order.push("web_embedded");
          triedWebEmbedded = true;
        }
        lastErr = "Login required";
        continue;
      }
      if (status === "UNPLAYABLE") {
        lastErr = reason || "Unplayable";
        console.warn("[BG]", key, "returned UNPLAYABLE:", reason);
        // android_vr can't play "made for kids" videos — fall back to web_embedded
        if (
          key === "android_vr" &&
          !triedWebEmbedded &&
          !order.includes("web_embedded")
        ) {
          console.log(
            "[BG] android_vr UNPLAYABLE — adding web_embedded fallback",
          );
          order.push("web_embedded");
          triedWebEmbedded = true;
        }
        continue;
      }
      if (resp.videoDetails?.videoId && resp.videoDetails.videoId !== videoId) {
        console.warn("[BG]", key, "returned wrong videoId");
        continue;
      }

      if (!bestVideoDetails && resp.videoDetails) {
        bestVideoDetails = resp.videoDetails;
      }

      const info = buildInfo(resp, key);

      if (info.formats.length > 0) {
        console.log("[BG]", key, "returned", info.formats.length, "formats");

        for (const f of info.formats) f.clientUsed = key;
        allFormats.push(...info.formats);
        successfulClients.push(key);

        if (sig?.nSigCode || nSigCode) {
          await applyNSig(info.formats, sig || { nSigCode });
        }

        if (successfulClients.length >= 2 && allFormats.length > 15) {
          break;
        }
      }

      if (cfg.requireCipher && sig?.actionList) {
        const ciphered = buildInfoWithCipher(resp, key, sig);
        if (ciphered.formats.length > 0) {
          console.log(
            "[BG]",
            key,
            "returned",
            ciphered.formats.length,
            "formats (after cipher)",
          );

          for (const f of ciphered.formats) f.clientUsed = key;
          allFormats.push(...ciphered.formats);
          successfulClients.push(key);

          if (sig?.nSigCode || nSigCode) {
            await applyNSig(ciphered.formats, sig || { nSigCode });
          }

          if (successfulClients.length >= 2 && allFormats.length > 15) {
            break;
          }
        }
      }

      if (
        cfg.requireCipher &&
        !sig?.actionList &&
        (cipherCode || sig?.cipherCode)
      ) {
        const cc = cipherCode || sig?.cipherCode;
        const ca = cipherArgName || sig?.cipherArgName;
        const ciphered = await buildInfoWithSandboxCipher(resp, key, cc, ca);
        if (ciphered && ciphered.formats.length > 0) {
          console.log(
            "[BG]",
            key,
            "returned",
            ciphered.formats.length,
            "formats (sandbox cipher)",
          );

          for (const f of ciphered.formats) f.clientUsed = key;
          allFormats.push(...ciphered.formats);
          successfulClients.push(key);

          if (sig?.nSigCode || nSigCode) {
            await applyNSig(ciphered.formats, sig || { nSigCode });
          }

          if (successfulClients.length >= 2 && allFormats.length > 15) {
            break;
          }
        }
      }
    } catch (e) {
      console.warn("[BG]", key, "failed:", e.message);
      lastErr = e.message;
    }
  }

  if (allFormats.length > 0) {
    console.log(
      "[BG] Merging formats from",
      successfulClients.length,
      "clients:",
      successfulClients.join(", "),
    );

    const mergedFormats = deduplicateFormats(allFormats);
    const vd = bestVideoDetails || {};

    return {
      videoId: vd.videoId || videoId,
      title: vd.title || "YouTube Video",
      author: vd.author || "",
      lengthSeconds: parseInt(vd.lengthSeconds) || 0,
      thumbnail: vd.thumbnail?.thumbnails?.slice(-1)[0]?.url || "",
      formats: mergedFormats,
      clientUsed: successfulClients.join("+"),
    };
  }

  console.log("[BG] API clients exhausted, trying Tier 3 (page scrape)...");
  return pageScrapeWithCipher(
    videoId,
    pagePlayerResp,
    playerUrl,
    sig,
    lastErr,
    cipherCode,
    cipherArgName,
  );
}

async function fetchPageData(videoId) {
  const url = `https://www.youtube.com/watch?v=${videoId}&has_verified=1`;

  const cookieHeader = await getYouTubeCookieHeader();
  const headers = {
    Accept: "text/html",
    "Accept-Language": "en-US,en;q=0.9",
  };
  if (cookieHeader) headers["Cookie"] = cookieHeader;

  const resp = await fetchWithDNRHeaders(url, headers, { method: "GET" });
  if (!resp.ok) {
    throw new Error(`YouTube page fetch failed: HTTP ${resp.status}`);
  }
  const html = await resp.text();

  let visitorData = null;
  const vd = /"VISITOR_DATA":\s*"([^"]+)"/.exec(html);
  if (vd) visitorData = vd[1];

  let playerUrl = null;
  for (const re of [
    /"jsUrl":"([^"]+base\.js[^"]*)"/,
    /"PLAYER_JS_URL":"([^"]+)"/,
  ]) {
    const m = html.match(re);
    if (m) {
      playerUrl = m[1];
      break;
    }
  }
  if (playerUrl && !playerUrl.startsWith("http")) {
    playerUrl = "https://www.youtube.com" + playerUrl;
  }

  let playerResponse = null;
  const marker = "ytInitialPlayerResponse";
  const idx = html.indexOf(marker);
  if (idx !== -1) {
    const eqIdx = html.indexOf("=", idx + marker.length);
    if (eqIdx !== -1) {
      let braceStart = -1;
      for (let i = eqIdx + 1; i < html.length; i++) {
        if (html[i] === "{") {
          braceStart = i;
          break;
        }
        if (!" \n\r\t".includes(html[i])) break;
      }
      if (braceStart !== -1) {
        const block = extractBraceBlock(html, braceStart);
        if (block) {
          try {
            playerResponse = JSON.parse(block);
          } catch (e) {}
        }
      }
    }
  }

  return { visitorData, playerUrl, playerResponse };
}

async function innertubeRequest(clientKey, videoId, visitorData, sts) {
  const cfg = CLIENTS[clientKey];

  const body = {
    playbackContext: {
      contentPlaybackContext: {
        html5Preference: "HTML5_PREF_WANTS",
        ...(sts ? { signatureTimestamp: sts } : {}),
      },
    },
    contentCheckOk: true,
    racyCheckOk: true,
    videoId,
    context: {
      client: {
        hl: "en",
        timeZone: "UTC",
        utcOffsetMinutes: 0,
        ...cfg.client,
      },
      // web_embedded needs thirdParty context to work around age-gate
      ...(clientKey === "web_embedded"
        ? { thirdParty: { embedUrl: "https://www.youtube.com/" } }
        : {}),
    },
  };

  const dnrHeaders = {
    "Content-Type": "application/json",
    Origin: "https://www.youtube.com",
    Referer: "https://www.youtube.com/",
    "X-YouTube-Client-Name": String(cfg.clientId),
    "X-YouTube-Client-Version": cfg.client.clientVersion,
  };

  if (cfg.userAgent) {
    dnrHeaders["User-Agent"] = cfg.userAgent;
  }
  if (visitorData) {
    dnrHeaders["X-Goog-Visitor-Id"] = visitorData;
  }

  const cookieStr = await getYouTubeCookieHeader();
  if (cookieStr) {
    dnrHeaders["Cookie"] = cookieStr;
  }

  const resp = await fetchWithDNRHeaders(
    "https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
    dnrHeaders,
    { method: "POST", body: JSON.stringify(body) },
  );

  if (!resp.ok) throw new Error("HTTP " + resp.status);
  return await resp.json();
}

function buildInfo(resp, clientKey) {
  const vd = resp.videoDetails || {};
  const sd = resp.streamingData || {};
  const formats = [];

  for (const fmt of [...(sd.formats || []), ...(sd.adaptiveFormats || [])]) {
    const f = parseFormat(fmt);
    if (f) formats.push(f);
  }

  return {
    videoId: vd.videoId || "",
    title: vd.title || "YouTube Video",
    author: vd.author || "",
    lengthSeconds: parseInt(vd.lengthSeconds) || 0,
    thumbnail: vd.thumbnail?.thumbnails?.slice(-1)[0]?.url || "",
    formats,
    clientUsed: clientKey,
  };
}

function buildInfoWithCipher(resp, clientKey, sig) {
  const vd = resp.videoDetails || {};
  const sd = resp.streamingData || {};
  const formats = [];

  for (const fmt of [...(sd.formats || []), ...(sd.adaptiveFormats || [])]) {
    let url = fmt.url;

    if (!url && (fmt.cipher || fmt.signatureCipher)) {
      const params = new URLSearchParams(fmt.cipher || fmt.signatureCipher);
      url = params.get("url");
      const s = params.get("s");
      const sp = params.get("sp") || "sig";

      if (url && s && sig.actionList) {
        url +=
          (url.includes("?") ? "&" : "?") +
          sp +
          "=" +
          encodeURIComponent(applyCipher(sig.actionList, s));
      } else {
        continue;
      }
    }

    if (!url) continue;
    if (!/ratebypass/.test(url)) url += "&ratebypass=yes";

    const mime = fmt.mimeType || "";
    const cm = mime.match(/codecs="([^"]+)"/);
    const codecs = cm ? cm[1] : "";
    const isV = mime.startsWith("video/");
    const isA = mime.startsWith("audio/");

    formats.push({
      itag: fmt.itag,
      url,
      mimeType: mime,
      quality: fmt.qualityLabel || fmt.quality || "",
      qualityLabel: fmt.qualityLabel || "",
      width: fmt.width || 0,
      height: fmt.height || 0,
      fps: fmt.fps || 0,
      bitrate: fmt.bitrate || 0,
      audioBitrate: fmt.averageBitrate || fmt.bitrate || 0,
      audioQuality: fmt.audioQuality || "",
      contentLength: parseInt(fmt.contentLength) || null,
      codecs,
      isVideo: isV,
      isAudio: isA,
      isMuxed: isV && codecs.includes("mp4a"),
    });
  }

  return {
    videoId: vd.videoId || "",
    title: vd.title || "YouTube Video",
    author: vd.author || "",
    lengthSeconds: parseInt(vd.lengthSeconds) || 0,
    thumbnail: vd.thumbnail?.thumbnails?.slice(-1)[0]?.url || "",
    formats,
    clientUsed: clientKey + "+cipher",
  };
}

function parseFormat(fmt) {
  let url = fmt.url;

  if (!url && (fmt.cipher || fmt.signatureCipher)) return null;
  if (!url) return null;

  if (!/ratebypass/.test(url)) url += "&ratebypass=yes";

  const mime = fmt.mimeType || "";
  const cm = mime.match(/codecs="([^"]+)"/);
  const codecs = cm ? cm[1] : "";
  const isV = mime.startsWith("video/");
  const isA = mime.startsWith("audio/");

  return {
    itag: fmt.itag,
    url,
    mimeType: mime,
    quality: fmt.qualityLabel || fmt.quality || "",
    qualityLabel: fmt.qualityLabel || "",
    width: fmt.width || 0,
    height: fmt.height || 0,
    fps: fmt.fps || 0,
    bitrate: fmt.bitrate || 0,
    audioBitrate: fmt.averageBitrate || fmt.bitrate || 0,
    audioQuality: fmt.audioQuality || "",
    contentLength: parseInt(fmt.contentLength) || null,
    codecs,
    isVideo: isV,
    isAudio: isA,
    isMuxed: isV && codecs.includes("mp4a"),
  };
}

// Client download reliability ranking — android_vr is the most reliable for
// direct downloads. ios/android/android_testsuite removed (broken/require PO tokens).
// web_embedded is lowest priority (fallback only).
const CLIENT_DOWNLOAD_PRIORITY = {
  android_vr: 4,
  web: 3,
  web_embedded: 2,
};

function deduplicateFormats(formats) {
  const seen = new Map();

  for (const fmt of formats) {
    if (!fmt || !fmt.itag) continue;

    const existing = seen.get(fmt.itag);

    if (!existing) {
      seen.set(fmt.itag, fmt);
      continue;
    }

    let keepNew = false;

    // Prefer formats from more reliable clients for downloads
    const existingPrio = CLIENT_DOWNLOAD_PRIORITY[existing.clientUsed] || 0;
    const newPrio = CLIENT_DOWNLOAD_PRIORITY[fmt.clientUsed] || 0;

    if (newPrio > existingPrio) {
      keepNew = true;
    } else if (newPrio === existingPrio) {
      // Same client priority — fall back to content length / bitrate
      if (!existing.url && fmt.url) {
        keepNew = true;
      } else if (existing.url && fmt.url) {
        const existingLen = existing.contentLength || 0;
        const newLen = fmt.contentLength || 0;

        if (newLen > existingLen) {
          keepNew = true;
        } else if (newLen === existingLen && fmt.bitrate > existing.bitrate) {
          keepNew = true;
        }
      }
    }
    // If new client has lower priority, never replace

    if (keepNew) {
      seen.set(fmt.itag, fmt);
    }
  }

  const deduplicated = Array.from(seen.values());

  deduplicated.sort((a, b) => {
    if (a.isVideo && !b.isVideo) return -1;
    if (!a.isVideo && b.isVideo) return 1;

    if (a.isVideo && b.isVideo) {
      if (b.height !== a.height) return b.height - a.height;
      if (b.fps !== a.fps) return b.fps - a.fps;
      return b.bitrate - a.bitrate;
    }

    return b.audioBitrate - a.audioBitrate;
  });

  return deduplicated;
}

async function buildInfoWithSandboxCipher(
  resp,
  clientKey,
  cipherCode,
  argName,
) {
  const vd = resp.videoDetails || {};
  const sd = resp.streamingData || {};
  const raw = [...(sd.formats || []), ...(sd.adaptiveFormats || [])];

  const needCipher = [];
  const plainFormats = [];

  for (const fmt of raw) {
    if (fmt.url) {
      let url = fmt.url;
      if (!/ratebypass/.test(url)) url += "&ratebypass=yes";
      plainFormats.push({ ...fmt, url });
    } else if (fmt.cipher || fmt.signatureCipher) {
      const params = new URLSearchParams(fmt.cipher || fmt.signatureCipher);
      const url = params.get("url");
      const s = params.get("s");
      const sp = params.get("sp") || "sig";
      if (url && s) {
        needCipher.push({ fmt, url, s, sp });
      }
    }
  }

  if (!needCipher.length) return null;

  console.log("[BG] Sandbox cipher eval for", needCipher.length, "signatures");
  const deciphered = await sandboxEvalCipher(
    cipherCode,
    argName || "a",
    needCipher.map((e) => e.s),
  );

  const formats = [];

  for (const fmt of plainFormats) {
    const p = parseFormat(fmt);
    if (p) formats.push(p);
  }

  for (let i = 0; i < needCipher.length; i++) {
    const { fmt, url, sp } = needCipher[i];
    const sig = deciphered[i];
    if (!sig || typeof sig !== "string") continue;

    let fullUrl =
      url +
      (url.includes("?") ? "&" : "?") +
      sp +
      "=" +
      encodeURIComponent(sig);
    if (!/ratebypass/.test(fullUrl)) fullUrl += "&ratebypass=yes";

    const mime = fmt.mimeType || "";
    const cm = mime.match(/codecs="([^"]+)"/);
    const codecs = cm ? cm[1] : "";
    const isV = mime.startsWith("video/");
    const isA = mime.startsWith("audio/");

    formats.push({
      itag: fmt.itag,
      url: fullUrl,
      mimeType: mime,
      quality: fmt.qualityLabel || fmt.quality || "",
      qualityLabel: fmt.qualityLabel || "",
      width: fmt.width || 0,
      height: fmt.height || 0,
      fps: fmt.fps || 0,
      bitrate: fmt.bitrate || 0,
      audioBitrate: fmt.averageBitrate || fmt.bitrate || 0,
      audioQuality: fmt.audioQuality || "",
      contentLength: parseInt(fmt.contentLength) || null,
      codecs,
      isVideo: isV,
      isAudio: isA,
      isMuxed: isV && codecs.includes("mp4a"),
    });
  }

  return {
    videoId: vd.videoId || "",
    title: vd.title || "YouTube Video",
    author: vd.author || "",
    lengthSeconds: parseInt(vd.lengthSeconds) || 0,
    thumbnail: vd.thumbnail?.thumbnails?.slice(-1)[0]?.url || "",
    formats,
    clientUsed: clientKey + "+sandbox_cipher",
  };
}

async function applyNSig(formats, sig) {
  if (!sig?.nSigCode) return;

  const entries = [];
  for (const f of formats) {
    if (!f.url) continue;
    const m = /[?&]n=([^&]+)/i.exec(f.url);
    if (m)
      entries.push({
        itag: f.itag,
        raw: m[1],
        decoded: decodeURIComponent(m[1]),
      });
  }
  if (!entries.length) return;

  console.log("[BG] Transforming", entries.length, "N-params via sandbox...");
  try {
    const results = await sandboxEval(
      sig.nSigCode,
      entries.map((e) => e.decoded),
    );

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const r = results[i];
      if (r && typeof r === "string" && r !== e.decoded) {
        const fmt = formats.find((f) => f.itag === e.itag);
        if (fmt)
          fmt.url = fmt.url.replace("n=" + e.raw, "n=" + encodeURIComponent(r));
      }
    }
  } catch (err) {
    console.warn(
      "[BG] N-sig transform failed, downloads may be throttled:",
      err.message,
    );
  }
}

async function ensureOffscreen() {
  try {
    const all = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [chrome.runtime.getURL("offscreen/offscreen.html")],
    });
    if (all.length > 0) return;
  } catch (e) {}

  try {
    await chrome.offscreen.createDocument({
      url: "offscreen/offscreen.html",
      reasons: ["IFRAME_SCRIPTING", "BLOBS", "WORKERS"],
      justification:
        "N-sig eval in sandbox iframe, audio/video merging via libav.js",
    });
  } catch (e) {
    if (!e.message?.includes("Only a single offscreen")) throw e;
  }

  await Promise.race([
    new Promise((resolve) => {
      const handler = (e) => {
        if (e.data?.type === "PONG") {
          bcIn.removeEventListener("message", handler);
          resolve();
        }
      };
      bcIn.addEventListener("message", handler);
      bcOut.postMessage({ type: "PING" });
    }),
    new Promise((r) => setTimeout(r, 3000)),
  ]);
}

async function sandboxEval(fnCode, params) {
  await ensureOffscreen();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      console.warn("[BG] Sandbox eval timed out (12s)");
      reject(new Error("Sandbox N-sig eval timed out"));
    }, 12000);

    chrome.runtime.sendMessage(
      { target: "offscreen", action: "EVAL_NSIG", fnCode, params },
      (response) => {
        clearTimeout(timeout);
        if (chrome.runtime.lastError) {
          console.warn(
            "[BG] Sandbox message error:",
            chrome.runtime.lastError.message,
          );
          reject(
            new Error(
              "Sandbox communication failed: " +
                chrome.runtime.lastError.message,
            ),
          );
          return;
        }
        if (response?.timedOut || response?.error) {
          console.warn("[BG] Sandbox eval error:", response.error);
          reject(
            new Error("Sandbox eval failed: " + (response.error || "unknown")),
          );
          return;
        }
        resolve(response?.results || params);
      },
    );
  });
}

async function sandboxEvalCipher(cipherCode, argName, sigs) {
  await ensureOffscreen();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      console.warn("[BG] Sandbox cipher eval timed out (12s)");
      reject(new Error("Sandbox cipher eval timed out"));
    }, 12000);

    chrome.runtime.sendMessage(
      { target: "offscreen", action: "EVAL_CIPHER", cipherCode, argName, sigs },
      (response) => {
        clearTimeout(timeout);
        if (chrome.runtime.lastError) {
          console.warn(
            "[BG] Sandbox cipher error:",
            chrome.runtime.lastError.message,
          );
          reject(new Error("Sandbox cipher communication failed"));
          return;
        }
        if (response?.timedOut || response?.error) {
          console.warn("[BG] Sandbox cipher eval error:", response.error);
          reject(
            new Error(
              "Sandbox cipher eval failed: " + (response.error || "unknown"),
            ),
          );
          return;
        }
        resolve(response?.results || sigs);
      },
    );
  });
}

async function pageScrapeWithCipher(
  videoId,
  pageResp,
  playerUrl,
  sig,
  prevErr,
  cipherCode,
  cipherArgName,
) {
  if (!pageResp) {
    const pd = await fetchPageData(videoId);
    pageResp = pd.playerResponse;
    playerUrl = playerUrl || pd.playerUrl;
    if (playerUrl && !sig) {
      try {
        sig = await loadSignatureData(playerUrl);
      } catch (e) {}
    }
  }

  if (!pageResp) throw new Error(prevErr || "No player response available");

  const vd = pageResp.videoDetails || {};
  const sd = pageResp.streamingData || {};
  const raw = [...(sd.formats || []), ...(sd.adaptiveFormats || [])];
  const formats = [];
  const nEntries = [];
  const cipherQueue = [];

  for (const fmt of raw) {
    let url = fmt.url;

    if (!url && (fmt.cipher || fmt.signatureCipher)) {
      const params = new URLSearchParams(fmt.cipher || fmt.signatureCipher);
      url = params.get("url");
      const s = params.get("s");
      const sp = params.get("sp") || "sig";
      if (url && s && sig?.actionList) {
        url +=
          (url.includes("?") ? "&" : "?") +
          sp +
          "=" +
          encodeURIComponent(applyCipher(sig.actionList, s));
      } else if (url && s && (cipherCode || sig?.cipherCode)) {
        cipherQueue.push({ fmt, url, s, sp });
        continue;
      } else {
        continue;
      }
    }
    if (!url) continue;
    if (!/ratebypass/.test(url)) url += "&ratebypass=yes";

    const mime = fmt.mimeType || "";
    const cm = mime.match(/codecs="([^"]+)"/);
    const codecs = cm ? cm[1] : "";
    const isV = mime.startsWith("video/");
    const isA = mime.startsWith("audio/");

    const entry = {
      itag: fmt.itag,
      url,
      mimeType: mime,
      quality: fmt.qualityLabel || fmt.quality || "",
      qualityLabel: fmt.qualityLabel || "",
      width: fmt.width || 0,
      height: fmt.height || 0,
      fps: fmt.fps || 0,
      bitrate: fmt.bitrate || 0,
      audioBitrate: fmt.averageBitrate || fmt.bitrate || 0,
      audioQuality: fmt.audioQuality || "",
      contentLength: parseInt(fmt.contentLength) || null,
      codecs,
      isVideo: isV,
      isAudio: isA,
      isMuxed: isV && codecs.includes("mp4a"),
    };

    const nm = /[?&]n=([^&]+)/i.exec(url);
    if (nm && sig?.nSigCode) {
      nEntries.push({
        idx: formats.length,
        raw: nm[1],
        decoded: decodeURIComponent(nm[1]),
      });
    }
    formats.push(entry);
  }

  if (cipherQueue.length && (cipherCode || sig?.cipherCode)) {
    const cc = cipherCode || sig.cipherCode;
    const ca = cipherArgName || sig?.cipherArgName || "a";
    console.log(
      "[BG] Tier 3: sandbox cipher eval for",
      cipherQueue.length,
      "formats",
    );
    const deciphered = await sandboxEvalCipher(
      cc,
      ca,
      cipherQueue.map((e) => e.s),
    );
    for (let i = 0; i < cipherQueue.length; i++) {
      const { fmt, url, sp } = cipherQueue[i];
      const sig2 = deciphered[i];
      if (!sig2 || typeof sig2 !== "string") continue;

      let fullUrl =
        url +
        (url.includes("?") ? "&" : "?") +
        sp +
        "=" +
        encodeURIComponent(sig2);
      if (!/ratebypass/.test(fullUrl)) fullUrl += "&ratebypass=yes";

      const mime = fmt.mimeType || "";
      const cm = mime.match(/codecs="([^"]+)"/);
      const codecs = cm ? cm[1] : "";
      const isV = mime.startsWith("video/");
      const isA = mime.startsWith("audio/");

      const entry = {
        itag: fmt.itag,
        url: fullUrl,
        mimeType: mime,
        quality: fmt.qualityLabel || fmt.quality || "",
        qualityLabel: fmt.qualityLabel || "",
        width: fmt.width || 0,
        height: fmt.height || 0,
        fps: fmt.fps || 0,
        bitrate: fmt.bitrate || 0,
        audioBitrate: fmt.averageBitrate || fmt.bitrate || 0,
        audioQuality: fmt.audioQuality || "",
        contentLength: parseInt(fmt.contentLength) || null,
        codecs,
        isVideo: isV,
        isAudio: isA,
        isMuxed: isV && codecs.includes("mp4a"),
      };

      const nm = /[?&]n=([^&]+)/i.exec(fullUrl);
      if (nm && sig?.nSigCode) {
        nEntries.push({
          idx: formats.length,
          raw: nm[1],
          decoded: decodeURIComponent(nm[1]),
        });
      }
      formats.push(entry);
    }
  }

  if (nEntries.length && sig?.nSigCode) {
    const results = await sandboxEval(
      sig.nSigCode,
      nEntries.map((e) => e.decoded),
    );
    for (let i = 0; i < nEntries.length; i++) {
      const e = nEntries[i];
      const r = results[i];
      if (r && typeof r === "string" && r !== e.decoded) {
        formats[e.idx].url = formats[e.idx].url.replace(
          "n=" + e.raw,
          "n=" + encodeURIComponent(r),
        );
      }
    }
  }

  return {
    videoId: vd.videoId || videoId,
    title: vd.title || "YouTube Video",
    author: vd.author || "",
    lengthSeconds: parseInt(vd.lengthSeconds) || 0,
    thumbnail: vd.thumbnail?.thumbnails?.slice(-1)[0]?.url || "",
    formats,
    clientUsed: "page_scrape",
  };
}

async function loadSignatureData(playerUrl) {
  if (sigCache.has(playerUrl)) {
    const c = sigCache.get(playerUrl);
    if (Date.now() < c.expiresAt) return c;
  }

  console.log("[BG] Loading player JS:", playerUrl);
  let js = null;
  let lastFetchErr = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = await fetch(playerUrl, {
        cache: attempt === 1 ? "default" : "reload",
      });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      js = await resp.text();
      if (js && js.length > 1000) break;
      js = null;
      throw new Error("Response too small (" + (js || "").length + " bytes)");
    } catch (e) {
      lastFetchErr = e;
      console.warn(
        "[BG] Player.js fetch attempt",
        attempt,
        "failed:",
        e.message,
      );
      if (attempt < 3) await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }

  if (!js) {
    console.error(
      "[BG] Failed to load player.js after 3 attempts:",
      lastFetchErr?.message,
    );
    throw lastFetchErr || new Error("Player.js load failed");
  }

  const actionList = extractCipherActions(js);
  const nSigCode = extractNSigCode(js);

  let cipherCode = null;
  let cipherArgName = null;
  if (!actionList) {
    const extracted = extractRawCipherCode(js);
    if (extracted) {
      cipherCode = extracted.code;
      cipherArgName = extracted.argName;
      console.log(
        "[BG] Extracted raw cipher code (" +
          cipherCode.length +
          "ch) for sandbox eval",
      );
    }
  }

  let sts = null;
  for (const re of [
    /,sts:(\d+)/,
    /signatureTimestamp[=:](\d+)/,
    /"signatureTimestamp":(\d+)/,
  ]) {
    const m = js.match(re);
    if (m) {
      sts = parseInt(m[1]);
      break;
    }
  }

  const data = {
    actionList,
    nSigCode,
    cipherCode,
    cipherArgName,
    sts,
    playerUrl,
    expiresAt: Date.now() + 43200000,
  };
  sigCache.set(playerUrl, data);
  console.log(
    "[BG] Cipher:",
    actionList
      ? actionList.length + " actions"
      : cipherCode
        ? "raw code"
        : "none",
    "| N-sig:",
    nSigCode ? nSigCode.length + "ch" : "none",
    "| STS:",
    sts,
  );
  return data;
}

function extractCipherActions(js) {
  let fn = null;
  const namePatterns = [
    /\b[cs]\s*&&\s*[adf]\.set\([^,]+\s*,\s*encodeURIComponent\(([a-zA-Z0-9$]+)\(/,
    /\b[a-zA-Z0-9]+\s*&&\s*[a-zA-Z0-9]+\.set\([^,]+\s*,\s*encodeURIComponent\(([a-zA-Z0-9$]+)\(/,
    /\bm=([a-zA-Z0-9$]{2,})\(decodeURIComponent\(h\.s\)\)/,
    /\bc\s*&&\s*d\.set\([^,]+\s*,\s*(?:encodeURIComponent\s*\()([a-zA-Z0-9$]+)\(/,
    /\bc\s*&&\s*[a-z]\.set\([^,]+\s*,\s*([a-zA-Z0-9$]+)\(/,
    /\bc\s*&&\s*[a-z]\.set\([^,]+\s*,\s*encodeURIComponent\(([a-zA-Z0-9$]+)\(/,

    /[$_a-zA-Z0-9]+\.set\((?:[$_a-zA-Z0-9]+\.[$_a-zA-Z0-9]+\|\|)?"signature",\s*([$_a-zA-Z0-9]+)\s*\(/,

    /\.set\([^,]+,encodeURIComponent\(([a-zA-Z0-9$]+)\(/,

    /=([a-zA-Z0-9$]{2,})\(decodeURIComponent\(\w+\.s\)\)/,

    /&&\(\w+=([a-zA-Z0-9$]+)\("[^"]*",decodeURIComponent/,
    /&&\(\w+=([a-zA-Z0-9$]+)\(decodeURIComponent/,
  ];

  for (const re of namePatterns) {
    const m = js.match(re);
    if (m && m[1]) {
      fn = m[1];
      break;
    }
  }
  if (!fn) {
    // Fallback: find cipher function by the a=a.split("") signature
    const cipherSplitPatterns = [
      /(?:^|[;,\n])\s*([a-zA-Z0-9$_]+)\s*=\s*function\s*\((\w+)\)\s*\{\s*\2\s*=\s*\2\.split\(\s*""\s*\)/m,
      /(?:^|[;,\n])\s*([a-zA-Z0-9$_]+)\s*=\s*\((\w+)\)\s*=>\s*\{\s*\2\s*=\s*\2\.split\(\s*""\s*\)/m,
      /(?:^|[;,\n])\s*([a-zA-Z0-9$_]+)\s*=\s*(\w+)\s*=>\s*\{\s*\2\s*=\s*\2\.split\(\s*""\s*\)/m,
    ];
    for (const re of cipherSplitPatterns) {
      const m = re.exec(js);
      if (m) {
        fn = m[1];
        break;
      }
    }
  }
  if (!fn) return null;

  const esc = escRe(fn);
  // Match traditional functions AND arrow functions
  const cipherFnPatterns = [
    new RegExp(
      `(?:function ${esc}|(?:var |let |const |,|;\\n?)${esc}\\s*=\\s*function)\\s*\\(([\\w$]+)\\)\\s*\\{`,
    ),
    new RegExp(
      `(?:var |let |const |,|;\\n?)${esc}\\s*=\\s*\\(([\\w$]+)\\)\\s*=>\\s*\\{`,
    ),
    new RegExp(
      `(?:var |let |const |,|;\\n?)${esc}\\s*=\\s*([\\w$]+)\\s*=>\\s*\\{`,
    ),
  ];
  let fbm = null;
  for (const cre of cipherFnPatterns) {
    fbm = js.match(cre);
    if (fbm) break;
  }
  if (!fbm) return null;
  const braceStart = fbm.index + fbm[0].lastIndexOf("{");
  const bodyBlock = extractBraceBlock(js, braceStart);
  if (!bodyBlock) return null;
  const body = bodyBlock.slice(1, -1);

  const calls = [];
  const cre = /([\w$]+)(?:\.([\w$]+)|\["([\w$]+)"\])\([\w$]+(?:,\s*(\d+))?\)/g;
  let cm;
  while ((cm = cre.exec(body)) !== null) {
    calls.push({
      obj: cm[1],
      method: cm[2] || cm[3],
      arg: cm[4] ? parseInt(cm[4]) : null,
    });
  }
  if (!calls.length) return null;

  const hm = js.match(
    new RegExp(
      `(?:var |,|\\n)${escRe(calls[0].obj)}\\s*=\\s*\\{([\\s\\S]*?)\\};`,
    ),
  );
  if (!hm) return null;

  const types = {};
  // Match object methods: traditional, shorthand, and arrow function forms
  const methodPatterns = [
    /([\w$]+)\s*:\s*function\s*\([^)]*\)\s*\{/g,
    /([\w$]+)\s*\([^)]*\)\s*\{/g, // shorthand: methodName(a) {
    /([\w$]+)\s*:\s*\([^)]*\)\s*=>\s*\{/g, // arrow: methodName: (a) => {
  ];
  for (const mre of methodPatterns) {
    let mm;
    while ((mm = mre.exec(hm[1])) !== null) {
      const methodSource = hm[1];
      const localBraceIdx = mm.index + mm[0].lastIndexOf("{");
      const methodBody = extractBraceBlock(methodSource, localBraceIdx);
      if (!methodBody) continue;
      const b = methodBody;
      if (/\.reverse\(\)/.test(b)) types[mm[1]] = "reverse";
      else if (/\.splice\(/.test(b)) types[mm[1]] = "splice";
      else if (/\[\s*0\s*\]/.test(b)) types[mm[1]] = "swap";
      else if (/\.slice\(/.test(b)) types[mm[1]] = "slice";
    }
  }

  const list = [];
  for (const c of calls) {
    if (types[c.method]) list.push([types[c.method], c.arg]);
  }
  return list.length ? list : null;
}

function extractRawCipherCode(js) {
  // Try traditional function first, then arrow function
  const splitJoinPatterns = [
    /(?:^|[;,\n])\s*([a-zA-Z0-9$_]+)\s*=\s*function\s*\((\w+)\)\s*\{\s*\2\s*=\s*\2\.split\(\s*""\s*\)/m,
    /(?:^|[;,\n])\s*([a-zA-Z0-9$_]+)\s*=\s*\((\w+)\)\s*=>\s*\{\s*\2\s*=\s*\2\.split\(\s*""\s*\)/m,
    /(?:^|[;,\n])\s*([a-zA-Z0-9$_]+)\s*=\s*(\w+)\s*=>\s*\{\s*\2\s*=\s*\2\.split\(\s*""\s*\)/m,
  ];
  let m = null;
  for (const re of splitJoinPatterns) {
    m = js.match(re);
    if (m) break;
  }
  if (!m) return null;

  const fname = m[1];
  const argName = m[2];

  const esc = escRe(fname);
  const cipherBodyPatterns = [
    new RegExp(
      `(?:function ${esc}|(?:var |let |const |,|;\\n?)${esc}\\s*=\\s*function)\\s*\\(([\\w$]+)\\)\\s*\\{`,
    ),
    new RegExp(
      `(?:var |let |const |,|;\\n?)${esc}\\s*=\\s*\\(([\\w$]+)\\)\\s*=>\\s*\\{`,
    ),
    new RegExp(
      `(?:var |let |const |,|;\\n?)${esc}\\s*=\\s*([\\w$]+)\\s*=>\\s*\\{`,
    ),
  ];
  let fbm = null;
  for (const cre of cipherBodyPatterns) {
    fbm = js.match(cre);
    if (fbm) break;
  }
  if (!fbm) return null;
  const braceStart = fbm.index + fbm[0].lastIndexOf("{");
  const bodyBlock = extractBraceBlock(js, braceStart);
  if (!bodyBlock) return null;
  const body = bodyBlock.slice(1, -1);

  const helperMatch = body.match(/;\s*([a-zA-Z0-9$_]+)\.\w+\s*\(/);
  if (!helperMatch) return null;
  let helperName = helperMatch[1];
  if (helperName === argName) {
    const allHelpers = body.match(/([a-zA-Z0-9$_]+)\.\w+\s*\(/g);
    if (allHelpers) {
      for (const h of allHelpers) {
        const hm = h.match(/([a-zA-Z0-9$_]+)\./);
        if (hm && hm[1] !== argName) {
          helperName = hm[1];
          break;
        }
      }
    }
  }

  const helperDefMatch = js.match(
    new RegExp(`(?:var\\s+|[;,]\\s*)${escRe(helperName)}\\s*=\\s*\\{`),
  );
  if (!helperDefMatch) return null;
  const objBraceIdx = js.indexOf(
    "{",
    helperDefMatch.index + helperDefMatch[0].lastIndexOf("=") + 1,
  );
  const objBlock = extractBraceBlock(js, objBraceIdx);
  if (!objBlock) return null;

  let code =
    "var " +
    helperName +
    "=" +
    objBlock +
    ";\n" +
    argName +
    "=" +
    argName +
    '.split("");\n' +
    body.replace(
      new RegExp(
        "^\\s*" +
          escRe(argName) +
          "\\s*=\\s*" +
          escRe(argName) +
          '\\.split\\(\\s*""\\s*\\)\\s*;?',
      ),
      "",
    ) +
    "\n";
  if (code.indexOf("return") === -1) {
    code += "return " + argName + '.join("");';
  }

  return { code, argName };
}

function applyCipher(actions, sig) {
  let a = sig.split("");
  for (const [op, n] of actions) {
    switch (op) {
      case "reverse":
        a.reverse();
        break;
      case "splice":
        a.splice(0, n);
        break;
      case "swap": {
        const t = a[0];
        a[0] = a[n % a.length];
        a[n % a.length] = t;
        break;
      }
      case "slice":
        a = a.slice(n);
        break;
    }
  }
  return a.join("");
}

function extractNSigCode(js) {
  let fn = null,
    arrIdx = null;

  const nPatterns = [
    /\.get\("n"\)\)&&\(b=([a-zA-Z0-9$]+)(?:\[(\d+)\])?\([a-zA-Z0-9]\)/,

    /[=(,&|]([a-zA-Z0-9$]+)\(\w+\),\w+\.set\("n",/,

    /[=(,&|]([a-zA-Z0-9$]+)\[(\d+)\]\(\w+\),\w+\.set\("n",/,

    /\.set\("n",\s*([a-zA-Z0-9$]+)\(\s*\w+\s*\)/,

    // Only match decodeURIComponent patterns when near .get("n") context
    /\.get\("n"\).*?&&\(\w+=([a-zA-Z0-9$]+)\(decodeURIComponent/s,

    /\w+=\w+\.get\("n"\)[^}]*\w+&&\(\w+=([a-zA-Z0-9$]+)(?:\[(\d+)\])?\(\w+\)/,

    // Newer patterns (2025+)
    /\.get\("n"\)\s*\)\s*[;,].*?\.set\("n"\s*,\s*([a-zA-Z0-9$]+)\s*\(/s,

    /\.get\("n"\)\)&&.*?[=(,]([a-zA-Z0-9$]+)(?:\[(\d+)\])?\(/,

    /([a-zA-Z0-9$]+)\(\w+\.get\("n"\)\)[,;].*?\.set\("n"/,

    // URL path /n/ replacement pattern (anchored to .set("n") context)
    /\.set\("n"[^)]*\).*?\/n\/[^/]+.*?([a-zA-Z0-9$]+)\s*\(\s*\w+\s*\)/s,
  ];

  for (let idx = 0; idx < nPatterns.length; idx++) {
    const m = js.match(nPatterns[idx]);
    if (m) {
      fn = m[1];
      arrIdx = m[2] != null ? parseInt(m[2]) : null;
      console.log(
        "[BG] N-sig name found with pattern",
        idx,
        ":",
        fn,
        "arrIdx:",
        arrIdx,
      );
      break;
    }
  }

  if (!fn) {
    const arrWrapRe = /;\s*([a-zA-Z0-9$]+)\s*=\s*\[([a-zA-Z0-9$]+)\]\s*[;,]/g;
    let awm;
    while ((awm = arrWrapRe.exec(js)) !== null) {
      const candidateArr = awm[1];
      const candidateFunc = awm[2];
      if (
        js.includes(candidateArr + "[0]") ||
        js.includes(candidateArr + "(")
      ) {
        // Verify the candidate is actually a function
        const funcDefRe = new RegExp(
          "(?:function\\s+" +
            escRe(candidateFunc) +
            "|" +
            escRe(candidateFunc) +
            "\\s*=\\s*function|" +
            escRe(candidateFunc) +
            "\\s*=\\s*\\(?\\w+\\)?\\s*=>)\\s*[\\({]",
        );
        const funcDefMatch = funcDefRe.exec(js);
        if (funcDefMatch) {
          // Verify the function body is large enough and has N-sig structure
          const braceIdx = js.indexOf(
            "{",
            funcDefMatch.index + funcDefMatch[0].length - 1,
          );
          if (braceIdx !== -1) {
            const body = extractBraceBlock(js, braceIdx);
            if (
              body &&
              body.length > 500 &&
              /try\s*\{/.test(body) &&
              /catch\s*\(/.test(body)
            ) {
              fn = candidateFunc;
              arrIdx = null;
              console.log(
                "[BG] N-sig found via array-wrap pattern:",
                fn,
                "(",
                body.length,
                "chars)",
              );
              break;
            }
          }
        }
      }
    }
  }

  if (!fn) {
    const structPatterns = [
      /(?:^|[;,\n])\s*([a-zA-Z0-9$_]+)\s*=\s*function\s*\((\w+)\)\s*\{/gm,
      /(?:^|[;,\n])\s*([a-zA-Z0-9$_]+)\s*=\s*\((\w+)\)\s*=>\s*\{/gm,
      /(?:^|[;,\n])\s*([a-zA-Z0-9$_]+)\s*=\s*(\w+)\s*=>\s*\{/gm,
    ];
    outer: for (const structRe of structPatterns) {
      let sm;
      while ((sm = structRe.exec(js)) !== null) {
        const braceIdx = sm.index + sm[0].lastIndexOf("{");
        const body = extractBraceBlock(js, braceIdx);
        if (!body || body.length < 50 || body.length > 30000) continue;
        if (
          /try\s*\{/.test(body) &&
          /catch\s*\(/.test(body) &&
          /\[\s*\d+\s*\]/.test(body)
        ) {
          fn = sm[1];
          arrIdx = null;
          console.log("[BG] N-sig found by structure:", fn);
          break outer;
        }
      }
    }
  }

  if (!fn) return null;

  if (arrIdx !== null) {
    const am = js.match(
      new RegExp(`[,;\\n]\\s*${escRe(fn)}\\s*=\\s*\\[([\\w$,\\s]+)\\]`),
    );
    if (am) {
      const items = am[1].split(",");
      if (items[arrIdx]) fn = items[arrIdx].trim();
    }
  }

  const esc = escRe(fn);
  const defPatterns = [
    // Traditional function expression: H = function(a) {
    new RegExp(
      `(?:^|[;,\\n])\\s*${esc}\\s*=\\s*function\\s*\\(([^)]*)\\)\\s*\\{`,
      "gm",
    ),
    // Function declaration: function H(a) {
    new RegExp(`function\\s+${esc}\\s*\\(([^)]*)\\)\\s*\\{`, "g"),
    // Arrow function with parens: H = (a) => {
    new RegExp(
      `(?:^|[;,\\n])\\s*${esc}\\s*=\\s*\\(([^)]*)\\)\\s*=>\\s*\\{`,
      "gm",
    ),
    // Arrow function single param: H = a => {
    new RegExp(
      `(?:^|[;,\\n])\\s*${esc}\\s*=\\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\\s*=>\\s*\\{`,
      "gm",
    ),
    // var/let/const with arrow: var H = (a) => {
    new RegExp(
      `(?:var|let|const)\\s+${esc}\\s*=\\s*\\(([^)]*)\\)\\s*=>\\s*\\{`,
      "g",
    ),
    // var/let/const with arrow single param: var H = a => {
    new RegExp(
      `(?:var|let|const)\\s+${esc}\\s*=\\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\\s*=>\\s*\\{`,
      "g",
    ),
  ];

  for (const re of defPatterns) {
    let sm;
    while ((sm = re.exec(js)) !== null) {
      const braceIdx = sm.index + sm[0].lastIndexOf("{");
      const body = extractBraceBlock(js, braceIdx);
      if (!body) continue;

      // N-sig functions are large (typically 500+ chars) and contain
      // try/catch blocks and array indexing — skip tiny matches
      if (body.length < 200) continue;
      if (
        !/try\s*\{/.test(body) &&
        !/\[\s*\d+\s*\]/.test(body) &&
        body.length < 2000
      )
        continue;

      let code = `function(${sm[1]})${body}`;

      const arg0 = sm[1].split(",")[0].trim();
      code = code.replace(
        new RegExp(
          `if\\s*\\([^)]*typeof\\s+${escRe(arg0)}[^)]*\\)\\s*return\\s+${escRe(arg0)}\\s*;?`,
        ),
        ";",
      );

      console.log(
        "[BG] N-sig code extracted:",
        code.length,
        "chars from function",
        fn,
      );
      return code;
    }
  }

  console.warn(
    "[BG] N-sig function definition not found or too small for:",
    fn,
  );
  return null;
}

function extractBraceBlock(code, pos) {
  if (code[pos] !== "{") return null;
  let d = 0,
    inStr = false,
    sc = "",
    esc = false;
  for (let i = pos; i < code.length && i < pos + 500000; i++) {
    const c = code[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (c === "\\") {
      esc = true;
      continue;
    }
    if (inStr) {
      if (c === sc) inStr = false;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inStr = true;
      sc = c;
      continue;
    }
    if (c === "{") d++;
    if (c === "}") {
      d--;
      if (d === 0) return code.substring(pos, i + 1);
    }
  }
  return null;
}

// ============================================================
// Service Worker Keepalive during merge
// Chrome kills SW after 30s of inactivity. A periodic call to a
// trivial chrome API resets the inactivity timer.
// Uses chrome.runtime.getPlatformInfo — the lightest possible
// extension API call (recommended by official Chrome docs).
// See: https://developer.chrome.com/docs/extensions/develop/migrate/to-service-workers#keep-sw-alive
// ============================================================
function startMergeKeepalive() {
  stopMergeKeepalive();
  mergeKeepaliveTimer = setInterval(chrome.runtime.getPlatformInfo, 25000);
  console.log("[BG] Merge keepalive started");
}

function stopMergeKeepalive() {
  if (mergeKeepaliveTimer) {
    clearInterval(mergeKeepaliveTimer);
    mergeKeepaliveTimer = null;
    console.log("[BG] Merge keepalive stopped");
  }
}

// ============================================================
// Resume merge after SW restart or offscreen death
// Re-fetches fresh YouTube URLs using the stored videoId/itags,
// then restarts the merge with new URLs.
// ============================================================
async function resumeMergeFromState(mergeState) {
  const { videoId, videoItag, audioItag, filename } = mergeState;
  console.log(
    "[BG] Resuming merge:",
    videoId,
    "video:",
    videoItag,
    "audio:",
    audioItag,
  );

  // Re-fetch fresh formats — old URLs will have expired
  const info = await getFormats(videoId, {});
  if (!info?.formats?.length) {
    throw new Error("Could not re-fetch video formats");
  }

  const videoFmt = info.formats.find(
    (f) => String(f.itag) === String(videoItag),
  );
  const audioFmt = info.formats.find(
    (f) => String(f.itag) === String(audioItag),
  );

  if (!videoFmt?.url) {
    throw new Error(`Video format itag=${videoItag} not found or has no URL`);
  }
  if (!audioFmt?.url) {
    throw new Error(`Audio format itag=${audioItag} not found or has no URL`);
  }

  console.log("[BG] Got fresh URLs for resume — starting merge");

  const result = await doMergedDownload({
    videoUrl: videoFmt.url,
    audioUrl: audioFmt.url,
    filename,
    videoItag,
    audioItag,
    videoId,
    isResume: true,
  });

  return result;
}

async function doMergedDownload(msg) {
  const { videoUrl, audioUrl, filename, videoItag, audioItag, videoId } = msg;

  if (!videoUrl || !audioUrl) {
    throw new Error("Both video and audio URLs required");
  }

  if (activeMergeId) {
    console.warn("[BG] Merge already in progress:", activeMergeId);
    return { success: false, error: "A merge is already in progress" };
  }

  await ensureOffscreen();

  const mergeId = Date.now().toString();
  activeMergeId = mergeId;
  console.log("[BG] Starting merged download:", filename, "mergeId:", mergeId);

  chrome.storage.session
    .set({
      activeMerge: {
        mergeId,
        filename,
        videoId: videoId || null,
        videoItag: videoItag || null,
        audioItag: audioItag || null,
        startTime: Date.now(),
        status: "active",
        phase: "starting",
        percent: 0,
      },
    })
    .catch(() => {});

  // Keep the service worker alive for the duration of the merge
  startMergeKeepalive();

  const mergeRuleIds = await addMergeHeaders(videoUrl, audioUrl).catch((e) => {
    console.warn("[BG] Failed to add merge headers:", e.message);
    return [];
  });

  try {
    const result = await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        console.warn("[BG] Merge timed out after 30 minutes");
        resolve({ success: false, error: "Merge timed out" });
      }, 1800000);

      chrome.runtime.sendMessage(
        {
          target: "offscreen",
          action: "MERGE_AND_DOWNLOAD",
          videoUrl,
          audioUrl,
          filename,
          mergeId,
        },
        (response) => {
          clearTimeout(timeout);
          if (chrome.runtime.lastError) {
            const errMsg = chrome.runtime.lastError.message;
            console.error("[BG] Merge message error:", errMsg);
            // Offscreen document was likely destroyed (DevTools, Chrome GC, etc.)
            // If we have resume data, try to auto-retry with fresh URLs
            if (videoId && videoItag && audioItag && !msg.isResume) {
              console.log(
                "[BG] Offscreen died — will auto-retry with fresh URLs",
              );
              resolve({
                success: false,
                error: errMsg,
                shouldRetry: true,
              });
            } else {
              resolve({ success: false, error: errMsg });
            }
            return;
          }

          if (response?.success) {
            console.log(
              "[BG] Merged download started, id:",
              response.downloadId,
            );
            setTimeout(() => {
              chrome.runtime
                .sendMessage({
                  target: "offscreen",
                  action: "CLEANUP_OPFS",
                })
                .catch(() => {});
            }, 5000);
            resolve({
              success: true,
              downloadId: response.downloadId,
              size: response.size,
            });
          } else {
            resolve({
              success: false,
              error: response?.error || "Merge failed",
            });
          }
        },
      );
    });

    // If offscreen died and we can retry, do so with fresh URLs
    if (result.shouldRetry) {
      console.log("[BG] Auto-retrying merge after offscreen death...");
      // Clean up current state so resume can start fresh
      await removeMergeHeaders(mergeRuleIds);
      activeMergeId = null;
      stopMergeKeepalive();

      try {
        const retryResult = await resumeMergeFromState({
          videoId,
          videoItag,
          audioItag,
          filename,
        });
        return retryResult;
      } catch (retryErr) {
        console.error("[BG] Auto-retry failed:", retryErr.message);
        chrome.storage.session
          .set({
            activeMerge: {
              mergeId,
              filename,
              videoId,
              videoItag,
              audioItag,
              status: "failed",
              error: "Retry failed: " + retryErr.message,
              phase: "error",
              percent: 0,
            },
          })
          .catch(() => {});
        return { success: false, error: "Retry failed: " + retryErr.message };
      }
    }

    chrome.storage.session
      .set({
        activeMerge: {
          mergeId,
          filename,
          videoId: videoId || null,
          videoItag: videoItag || null,
          audioItag: audioItag || null,
          status: result.success ? "complete" : "failed",
          error: result.error || null,
          phase: result.success ? "complete" : "error",
          percent: result.success ? 100 : 0,
        },
      })
      .catch(() => {});

    return result;
  } finally {
    await removeMergeHeaders(mergeRuleIds);
    activeMergeId = null;
    stopMergeKeepalive();

    setTimeout(() => {
      chrome.storage.session.remove("activeMerge").catch(() => {});
    }, 10000);
  }
}

async function doDownload(url, filename) {
  filename = sanitize(filename);

  return new Promise((resolve) => {
    chrome.downloads.download({ url, filename, saveAs: true }, (id) => {
      if (chrome.runtime.lastError) {
        console.error("[BG] Download error:", chrome.runtime.lastError.message);

        if (/^https?:\/\//i.test(url)) {
          chrome.tabs.create({ url, active: false });
        }
        resolve({
          success: false,
          error: chrome.runtime.lastError.message,
          fallback: "tab",
        });
      } else {
        console.log("[BG] Download started, id:", id);
        resolve({ success: true, downloadId: id });
      }
    });
  });
}

function sanitize(n) {
  if (!n) return "video.mp4";
  return n
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .substring(0, 200);
}

function escRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

chrome.tabs.onRemoved.addListener((id) => {
  tabData.delete(id);
  sniffedStreams.delete(id);
  persistTabData();
});

async function doFetchUrl(url, options = {}) {
  try {
    const fetchOpts = {
      method: options.method || "GET",
      headers: options.headers || {},
    };

    if (options.body !== undefined && fetchOpts.method !== "GET") {
      fetchOpts.body = options.body;
    }

    fetchOpts.credentials = "include";

    const resp = await fetch(url, fetchOpts);
    if (!resp.ok) return { error: `HTTP ${resp.status}` };
    const contentType = resp.headers.get("content-type") || "";
    if (contentType.includes("json")) {
      return { data: await resp.json(), contentType };
    }
    return { data: await resp.text(), contentType };
  } catch (e) {
    return { error: e.message };
  }
}

console.log(
  "[BG] YouTube Downloader service worker ready (3-tier architecture)",
);

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
]);

const SNIFF_MEDIA_TYPES = new Set([
  "video/mp4",
  "video/webm",
  "video/mp2t",
  "video/x-flv",
  "audio/mpeg",
  "audio/mp4",
  "audio/aac",
  "audio/ogg",
  "audio/webm",
  "application/vnd.apple.mpegurl",
  "application/x-mpegurl",
  "application/dash+xml",
  "video/m3u8",
]);

const MIN_MEDIA_SIZE = 100 * 1024;

function isYouTubeTab(tabId) {
  const data = tabData.get(tabId);
  if (data?.videoId) return true;
  return false;
}

function getTabHost(tabId) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError || !tab?.url) {
          resolve(null);
          return;
        }
        try {
          resolve(new URL(tab.url).hostname);
        } catch {
          resolve(null);
        }
      });
    } catch {
      resolve(null);
    }
  });
}

chrome.webRequest.onResponseStarted.addListener(
  (details) => {
    if (details.tabId < 0) return;

    if (isYouTubeTab(details.tabId)) return;

    const contentType = (
      details.responseHeaders?.find(
        (h) => h.name.toLowerCase() === "content-type",
      )?.value || ""
    ).toLowerCase();

    const contentLength = parseInt(
      details.responseHeaders?.find(
        (h) => h.name.toLowerCase() === "content-length",
      )?.value || "0",
      10,
    );

    if (!contentType) return;

    let streamType = null;
    const baseType = contentType.split(";")[0].trim();

    if (
      baseType === "application/vnd.apple.mpegurl" ||
      baseType === "application/x-mpegurl" ||
      baseType === "video/m3u8" ||
      details.url.match(/\.m3u8(\?|$)/i)
    ) {
      streamType = "hls";
    } else if (
      baseType === "application/dash+xml" ||
      details.url.match(/\.mpd(\?|$)/i)
    ) {
      streamType = "dash";
    } else if (SNIFF_MEDIA_TYPES.has(baseType)) {
      if (contentLength > 0 && contentLength < MIN_MEDIA_SIZE) return;
      streamType = "direct";
    }

    if (!streamType) return;

    try {
      const urlHost = new URL(details.url).hostname;
      if (YOUTUBE_HOSTS.has(urlHost) || urlHost.endsWith(".googlevideo.com")) {
        return;
      }

      if (
        urlHost.endsWith(".cdninstagram.com") ||
        urlHost.endsWith(".fbcdn.net")
      ) {
        return;
      }

      if (urlHost.endsWith(".twimg.com")) {
        return;
      }

      if (
        urlHost.endsWith(".dmcdn.net") ||
        urlHost.endsWith(".dailymotion.com") ||
        urlHost === "cdndirector.dailymotion.com"
      ) {
        return;
      }

      if (
        urlHost.endsWith(".redd.it") ||
        urlHost.endsWith(".reddit.com") ||
        urlHost === "v.redd.it" ||
        urlHost === "packaged-media.redd.it"
      ) {
        return;
      }
    } catch {
      return;
    }

    const stream = {
      url: details.url,
      type: streamType,
      contentType: baseType,
      size: contentLength || 0,
      ts: Date.now(),
      method: details.method,
    };

    if (!sniffedStreams.has(details.tabId)) {
      sniffedStreams.set(details.tabId, []);
    }

    const streams = sniffedStreams.get(details.tabId);

    const normUrl = normalizeUrlForDedup(stream.url);
    const urlHash = cyrb53(normUrl);
    stream._urlHash = urlHash;

    const existingIdx = streams.findIndex((s) => s._urlHash === urlHash);
    if (existingIdx >= 0) {
      streams[existingIdx] = stream;
    } else {
      streams.push(stream);

      if (streams.length > 50) streams.shift();
    }

    const hlsDash = streams.filter(
      (s) => s.type === "hls" || s.type === "dash",
    );
    const badgeText = hlsDash.length > 0 ? "▶" + hlsDash.length : "●";
    chrome.action.setBadgeText({ text: badgeText, tabId: details.tabId });
    chrome.action.setBadgeBackgroundColor({
      color: "#2196F3",
      tabId: details.tabId,
    });

    console.log(
      `[SNIFFER] ${streamType} detected on tab ${details.tabId}:`,
      details.url.substring(0, 120),
    );
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"],
);

chrome.tabs.onRemoved.addListener((tabId) => {
  sniffedStreams.delete(tabId);
  contentHashes.delete(tabId);
});

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId === 0 && details.tabId >= 0) {
    sniffedStreams.delete(details.tabId);
    contentHashes.delete(details.tabId);
  }
});

const SITE_EXTRACTOR_MAP = {
  "vimeo.com": "vimeo.js",
  "dailymotion.com": "dailymotion.js",
  "rutube.ru": "rutube.js",
  "rumble.com": "rumble.js",
  "bitchute.com": "bitchute.js",
  "odysee.com": "odysee.js",
  "peertube.tv": "peertube.js",
  "dtube.video": "dtube.js",
  "vlare.tv": "vlare.js",
  "metacafe.com": "metacafe.js",
  "newgrounds.com": "newgrounds.js",
  "streamable.com": "streamable.js",
  "coub.com": "coub.js",

  "facebook.com": "facebook.js",
  "fb.watch": "facebook.js",
  "reddit.com": "reddit.js",
  "tiktok.com": "tiktok.js",
  "snapchat.com": "snapchat.js",
  "pinterest.com": "pinterest.js",
  "linkedin.com": "linkedin.js",
  "tumblr.com": "tumblr.js",
  "vk.com": "vk.js",
  "vk.ru": "vk.js",
  "vkvideo.ru": "vkvideo.js",
  "ok.ru": "ok.js",
  "weibo.com": "weibo.js",
  "bluesky.app": "bluesky.js",
  "bsky.app": "bluesky.js",
  "likee.video": "likee.js",
  "triller.co": "triller.js",

  "netflix.com": "netflix.js",
  "disneyplus.com": "disneyplus.js",
  "hbomax.com": "hbomax.js",
  "max.com": "hbomax.js",
  "hulu.com": "hulu.js",
  "primevideo.com": "primevideo.js",
  "amazon.com": "primevideo.js",
  "peacocktv.com": "peacock.js",
  "paramountplus.com": "paramountplus.js",
  "starz.com": "starz.js",
  "showtime.com": "showtime.js",
  "britbox.com": "britbox.js",
  "crunchyroll.com": "crunchyroll.js",
  "funimation.com": "crunchyroll.js",
  "curiositystream.com": "curiositystream.js",
  "nebula.tv": "nebula.js",
  "dropout.tv": "dropout.js",
  "plex.tv": "plex.js",
  "tubi.tv": "tubi.js",
  "tubitv.com": "tubi.js",
  "plutotv.com": "plutotv.js",
  "pluto.tv": "plutotv.js",
  "roku.com": "roku.js",
  "therokuchannel.roku.com": "roku.js",
  "crackle.com": "crackle.js",
  "popcornflix.com": "popcornflix.js",
  "flixtor.to": "flixtor.js",
  "vudu.com": "vudu.js",
  "amcplus.com": "amcplus.js",

  "twitch.tv": "twitch.js",
  "kick.com": "kick.js",
  "dlive.tv": "dlive.js",
  "trovo.live": "trovo.js",
  "caffeine.tv": "caffeine.js",
  "afreecatv.com": "afreeca.js",
  "twitcasting.tv": "twitcasting.js",
  "huya.com": "huya.js",

  "soundcloud.com": "soundcloud.js",
  "spotify.com": "spotify.js",
  "deezer.com": "deezer.js",
  "bandcamp.com": "bandcamp.js",
  "audiomack.com": "audiomack.js",
  "mixcloud.com": "mixcloud.js",
  "iheart.com": "iheart.js",
  "tunein.com": "tunein.js",
  "podbean.com": "podbean.js",
  "spreaker.com": "spreaker.js",
  "anchor.fm": "anchor.js",
  "last.fm": "lastfm.js",
  "vevo.com": "vevo.js",

  "cnn.com": "cnn.js",
  "foxnews.com": "foxnews.js",
  "bbc.co.uk": "bbc.js",
  "bbc.com": "bbc.js",
  "reuters.com": "reuters.js",
  "bloomberg.com": "bloomberg.js",
  "cbsnews.com": "cbsnews.js",
  "nbcnews.com": "nbcnews.js",
  "aljazeera.com": "aljazeera.js",
  "france24.com": "france24.js",
  "dw.com": "dw.js",
  "skynews.com": "skynews.js",
  "sky.com": "skynews.js",
  "nytimes.com": "nytimes.js",
  "washingtonpost.com": "washingtonpost.js",
  "espn.com": "espn.js",

  "bilibili.com": "bilibili.js",
  "acfun.cn": "acfun.js",
  "iq.com": "iq.js",
  "iqiyi.com": "iqiyi.js",
  "youku.com": "youku.js",
  "mgtv.com": "mangotv.js",
  "douyin.com": "douyin.js",
  "niconico.jp": "niconico.js",
  "nicovideo.jp": "niconico.js",
  "naver.com": "naver.js",
  "vlive.tv": "vlive.js",
  "daum.net": "daum.js",
  "hotstar.com": "hotstar.js",
  "sonyliv.com": "sonyliv.js",
  "zee5.com": "zee5.js",
  "viu.com": "viu.js",
  "shahid.mbc.net": "shahid.js",
  "tver.jp": "tver.js",
  "abema.tv": "abematv.js",

  "coursera.org": "coursera.js",
  "udemy.com": "udemy.js",
  "skillshare.com": "skillshare.js",
  "masterclass.com": "masterclass.js",
  "khanacademy.org": "khanacademy.js",
  "egghead.io": "egghead.js",
  "pluralsight.com": "pluralsight.js",
  "ted.com": "ted.js",

  "ard.de": "ard.js",
  "ardmediathek.de": "ard.js",
  "zdf.de": "zdf.js",
  "arte.tv": "arte.js",
  "france.tv": "francetv.js",
  "rai.it": "raiplay.js",
  "raiplay.it": "raiplay.js",
  "itv.com": "itv.js",
  "channel4.com": "channel4.js",
  "svtplay.se": "svt.js",
  "svt.se": "svt.js",
  "nrk.no": "nrk.js",
  "dr.dk": "drtv.js",
  "ertflix.gr": "ertflix.js",
  "9now.com.au": "9now.js",
  "sbs.com.au": "sbs.js",
  "nhk.or.jp": "nhk.js",
  "cctv.com": "cctv.js",
  "cda.pl": "cda.js",

  "imgur.com": "imgur.js",
  "flickr.com": "flickr.js",
  "archive.org": "archive.js",
  "dropbox.com": "dropbox.js",
  "loom.com": "loom.js",
  "vidyard.com": "vidyard.js",
  "wistia.com": "wistia.js",
  "canva.com": "canva.js",
  "floatplane.com": "floatplane.js",
  "patreon.com": "patreon.js",
  "steam.com": "steam.js",
  "steampowered.com": "steam.js",
  "medal.tv": "medal.js",
  "gfycat.com": "gfycat.js",
  "redgifs.com": "redgifs.js",
  "telegram.org": "telegram.js",
  "t.me": "telegram.js",
  "web.telegram.org": "telegram.js",
  "globo.com": "globo.js",
  "globoplay.com": "globo.js",

  "brightcove.com": "brightcove.js",
  "players.brightcove.net": "brightcove.js",
  "jwplayer.com": "jwplayer.js",
  "cdn.jwplayer.com": "jwplayer.js",
  "kaltura.com": "kaltura.js",

  "mlb.com": "mlb.js",
  "nba.com": "nba.js",
  "nfl.com": "nfl.js",
  "gamespot.com": "gamespot.js",
  "ign.com": "ign.js",
  "cspan.org": "cspan.js",

  "pornhub.com": "pornhub.js",
  "xhamster.com": "xhamster.js",
  "xvideos.com": "xvideos.js",
  "9gag.com": "ninegag.js",

  "discoveryplus.com": "discoveryplus.js",
  "abcnews.go.com": "abcnews.js",
  "vhx.tv": "vimeo-ott.js",
};

const DEDICATED_SITES = new Set([
  "youtube.com",
  "youtu.be",
  "twitter.com",
  "x.com",
  "instagram.com",
]);

const injectedTabs = new Map();

function findSpecialistForHost(hostname) {
  if (SITE_EXTRACTOR_MAP[hostname]) return SITE_EXTRACTOR_MAP[hostname];

  const noWww = hostname.replace(/^www\./, "");
  if (SITE_EXTRACTOR_MAP[noWww]) return SITE_EXTRACTOR_MAP[noWww];

  const parts = noWww.split(".");
  for (let i = 1; i < parts.length - 1; i++) {
    const parent = parts.slice(i).join(".");
    if (SITE_EXTRACTOR_MAP[parent]) return SITE_EXTRACTOR_MAP[parent];
  }
  return null;
}

function isDedicatedSite(hostname) {
  const noWww = hostname.replace(/^www\./, "");
  for (const d of DEDICATED_SITES) {
    if (noWww === d || noWww.endsWith("." + d)) return true;
  }
  return false;
}

async function injectSpecialist(tabId, scriptFile) {
  const prev = injectedTabs.get(tabId);
  if (prev === scriptFile) return;

  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: [`extractors/sites/${scriptFile}`],
      world: "MAIN",
      injectImmediately: false,
    });
    injectedTabs.set(tabId, scriptFile);
    console.log(`[BG] Specialist injected: ${scriptFile} → tab ${tabId}`);
  } catch (e) {
    if (
      !e.message?.includes("Cannot access") &&
      !e.message?.includes("No tab")
    ) {
      console.warn(
        `[BG] Specialist injection failed (${scriptFile}):`,
        e.message,
      );
    }
  }
}

chrome.webNavigation.onCommitted.addListener(
  (details) => {
    if (details.frameId !== 0) return;
    chrome.scripting
      .executeScript({
        target: { tabId: details.tabId, allFrames: false },
        files: ["extractors/sites/instagram-hook.js"],
        world: "MAIN",
        injectImmediately: true,
      })
      .catch(() => {});
  },
  { url: [{ hostSuffix: "instagram.com" }] },
);

chrome.webNavigation.onCompleted.addListener((details) => {
  if (details.frameId !== 0) return;

  try {
    const url = new URL(details.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    if (isDedicatedSite(url.hostname)) return;

    const scriptFile = findSpecialistForHost(url.hostname);
    if (scriptFile) {
      setTimeout(() => injectSpecialist(details.tabId, scriptFile), 300);
    }
  } catch (e) {}
});

chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId !== 0) return;

  try {
    const url = new URL(details.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    if (isDedicatedSite(url.hostname)) return;

    const scriptFile = findSpecialistForHost(url.hostname);
    if (scriptFile) {
      const prev = injectedTabs.get(details.tabId);
      if (prev !== scriptFile) {
        setTimeout(() => injectSpecialist(details.tabId, scriptFile), 300);
      }
    }
  } catch (e) {}
});

chrome.tabs.onRemoved.addListener((tabId) => {
  injectedTabs.delete(tabId);
});

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;

  const navTypes = ["typed", "auto_bookmark", "generated", "reload", "link"];
  if (navTypes.includes(details.transitionType)) {
    injectedTabs.delete(details.tabId);
  }
});

async function onSpecialistDetected(msg, tabId) {
  console.log("[BG] Specialist detected:", msg.protocol, "tab:", tabId);

  let formats = [];
  let videoId = null;
  let title = null;
  let thumbnail = null;
  let duration = null;
  let platform = null;

  if (msg.protocol === "MAGIC_M3U8") {
    const d = msg.payload || {};
    videoId = d.videoId || d.id || null;
    const videoUrl = d.url;
    const videoType = (d.type || "MP4").toUpperCase();
    const opts = d.options || {};
    title = opts.customTitle || opts.title || null;
    thumbnail = opts.thumbnail || null;
    platform = opts.platform || null;

    if (!videoUrl) return { success: false, error: "No video URL" };

    let mimeType = "video/mp4";
    if (videoType === "HLS" || videoType === "M3U8")
      mimeType = "application/x-mpegurl";
    else if (videoType === "DASH" || videoType === "MPD")
      mimeType = "application/dash+xml";
    else if (videoType === "WEBM") mimeType = "video/webm";
    else if (videoType === "FLV") mimeType = "video/x-flv";
    else if (videoType === "DRM_PROTECTED") mimeType = "drm/protected";

    if (
      opts.formats &&
      Array.isArray(opts.formats) &&
      opts.formats.length > 0
    ) {
      for (const f of opts.formats) {
        if (f.url) {
          formats.push({
            url: f.url,
            mimeType: f.mimeType || mimeType,
            quality: f.quality || "Direct",
            qualityLabel: f.qualityLabel || f.quality || "Alt",
            width: f.width || 0,
            height: f.height || 0,
            isVideo: f.isVideo !== false,
            isAudio: f.isAudio === true,
            isMuxed: f.isMuxed !== false,
            ext: f.ext || "mp4",
          });
        }
      }
    } else {
      formats.push({
        url: videoUrl,
        mimeType,
        quality: opts.quality || (videoType === "HLS" ? "auto" : "Direct"),
        qualityLabel: opts.qualityLabel || opts.quality || videoType,
        isVideo: true,
        isMuxed: true,
        ext: "mp4",
        isHLS: videoType === "HLS" || videoType === "M3U8",
        isDASH: videoType === "DASH" || videoType === "MPD",
        isDRM: videoType === "DRM_PROTECTED",
      });
    }
  } else if (msg.protocol === "LALHLIMPUII_JAHAU") {
    const d = msg.payload || {};
    platform = msg.siteId || null;
    const videos = d.videos || [];

    for (const v of videos) {
      if (!v.url) continue;
      videoId = videoId || v.id || v.videoId || null;
      title = title || v.title || null;
      thumbnail = thumbnail || v.thumbnail || null;
      duration = duration || v.duration || null;

      let mimeType = "video/mp4";
      const vType = (v.type || "").toLowerCase();
      if (vType === "hls" || vType === "m3u8" || v.url.includes(".m3u8"))
        mimeType = "application/x-mpegurl";
      else if (vType === "dash" || vType === "mpd" || v.url.includes(".mpd"))
        mimeType = "application/dash+xml";
      else if (vType === "webm") mimeType = "video/webm";

      formats.push({
        url: v.url,
        mimeType,
        quality: v.quality || "Direct",
        qualityLabel: v.qualityLabel || v.quality || "Direct",
        width: v.width || 0,
        height: v.height || 0,
        isVideo: v.isAudio ? false : true,
        isMuxed: true,
        ext: "mp4",
        isHLS: mimeType.includes("mpegurl"),
        isDASH: mimeType.includes("dash"),
        isDRM: v.drm === true,
      });
    }
  }

  if (formats.length === 0)
    return { success: false, error: "No formats extracted" };

  let syntheticItag = 90000;
  for (const f of formats) {
    if (!f.itag || f.itag === 0) {
      f.itag = syntheticItag++;
    }
  }

  if (!videoId) {
    videoId = `specialist_${platform || "unknown"}_${Date.now()}`;
  }

  const info = {
    formats,
    title: title || `Video from ${platform || "site"}`,
    thumbnail,
    duration,
    platform,
    source: "specialist",
  };

  tabData.set(tabId, { videoId, info, ts: Date.now() });
  persistTabData();

  chrome.action.setBadgeText({ text: "✓", tabId });
  chrome.action.setBadgeBackgroundColor({ color: "#4CAF50", tabId });

  if (tabId && !info.thumbnail) {
    captureMetadata(tabId).then((meta) => {
      if (!meta) return;
      let changed = false;
      if (!info.thumbnail && meta.thumbnail) {
        info.thumbnail = meta.thumbnail;
        changed = true;
      }
      if (info.title === `Video from ${platform || "site"}` && meta.title) {
        info.title = meta.title;
        changed = true;
      }
      if (!info.duration && meta.duration) {
        info.duration = meta.duration;
        changed = true;
      }
      if (changed) {
        tabData.set(tabId, { videoId, info, ts: Date.now() });
        persistTabData();
        console.log("[BG] Enriched specialist video with page metadata");
      }
    });
  }

  console.log(
    `[BG] Specialist stored ${formats.length} format(s) for tab ${tabId} (${platform})`,
  );
  return { success: true, info };
}

const SESSION_HEADER_BASE = 1000000;
let sessionHeaderCounter = 0;

async function addSessionHeaders(urlPattern, headers) {
  const ruleId = SESSION_HEADER_BASE + ++sessionHeaderCounter;

  const requestHeaders = Object.entries(headers)
    .filter(([, v]) => v != null && v !== "")
    .map(([name, value]) => ({
      header: name,
      operation: "set",
      value: String(value),
    }));

  if (requestHeaders.length === 0) return ruleId;

  const rule = {
    id: ruleId,
    priority: 2,
    action: { type: "modifyHeaders", requestHeaders },
    condition: {
      urlFilter: urlPattern,
      resourceTypes: ["xmlhttprequest", "media", "other"],
    },
  };

  await chrome.declarativeNetRequest.updateSessionRules({
    addRules: [rule],
  });

  console.log("[BG] Added session headers, ruleId:", ruleId);
  return ruleId;
}

async function removeSessionHeaders(ruleId) {
  if (!ruleId) return;
  await chrome.declarativeNetRequest
    .updateSessionRules({ removeRuleIds: [ruleId] })
    .catch(() => {});
  console.log("[BG] Removed session header rule:", ruleId);
}

async function handleWorkerDownload(msg) {
  const { url, type, filename, headers, tabId } = msg;

  if (!url) throw new Error("URL required for worker download");

  await ensureOffscreen();

  const downloadId =
    "dl_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6);

  let sessionRuleId = null;
  if (headers && Object.keys(headers).length > 0) {
    try {
      const urlHost = new URL(url).hostname;
      sessionRuleId = await addSessionHeaders("||" + urlHost + "/", headers);
    } catch (e) {
      console.warn("[BG] Failed to add session headers:", e.message);
    }
  }

  chrome.runtime.sendMessage(
    {
      target: "offscreen",
      action: "START_WORKER_DOWNLOAD",
      downloadId,
      url,
      type: type || "direct",
      filename: sanitize(filename || "video.mp4"),
      headers: headers || {},
      sessionRuleId,
    },
    (response) => {
      if (chrome.runtime.lastError) {
        console.error(
          "[BG] Worker start error:",
          chrome.runtime.lastError.message,
        );
      }
    },
  );

  chrome.storage.session.get("activeDownloads", (result) => {
    const downloads = result?.activeDownloads || {};
    downloads[downloadId] = {
      phase: "starting",
      message: "Initializing download...",
      percent: 0,
      filename: sanitize(filename || "video.mp4"),
      ts: Date.now(),
    };
    chrome.storage.session.set({ activeDownloads: downloads }).catch(() => {});
  });

  return { success: true, downloadId };
}

const NOTIF_TAG = "video_dl_";
let lastNotifTime = 0;
const NOTIF_THROTTLE_MS = 3000;

function notifyDownloadProgress(msg) {
  const now = Date.now();
  if (now - lastNotifTime < NOTIF_THROTTLE_MS) return;

  const percent = Math.round(msg.percent || 0);
  if (percent > 0 && percent < 100 && percent % 25 !== 0) return;

  lastNotifTime = now;

  chrome.notifications.create(
    NOTIF_TAG + msg.downloadId,
    {
      type: "progress",
      iconUrl: "icons/icon128.png",
      title: "Downloading Video",
      message: msg.filename || "video.mp4",
      progress: Math.min(percent, 100),
      silent: true,
    },
    () => {
      if (chrome.runtime.lastError) {
        chrome.notifications.create(
          NOTIF_TAG + msg.downloadId,
          {
            type: "basic",
            iconUrl: "icons/icon128.png",
            title: `Downloading: ${percent}%`,
            message: msg.filename || "video.mp4",
            silent: true,
          },
          () => {},
        );
      }
    },
  );
}

function notifyComplete(filename) {
  chrome.notifications.create(
    NOTIF_TAG + "complete_" + Date.now(),
    {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "Download Complete",
      message: filename || "video.mp4",
    },
    () => {},
  );

  setTimeout(() => {
    chrome.notifications.getAll((notifs) => {
      for (const id of Object.keys(notifs)) {
        if (id.startsWith(NOTIF_TAG)) {
          chrome.notifications.clear(id);
        }
      }
    });
  }, 5000);
}
