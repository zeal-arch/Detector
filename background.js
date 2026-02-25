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
const sniffedYouTubeUrls = new Map(); // tabId → Map(itag → {url, mime, clen, expire, ts})
const REFERER_RULE_ID = 1;
let activeMergeId = null;
let mergeKeepaliveTimer = null; // Keeps SW alive during merge

// ========== Auto-Update Checker (GitHub Releases) ==========
const UPDATE_CONFIG = {
  owner: "zeal-arch",
  repo: "Detector",
  currentVersion: chrome.runtime.getManifest().version,
  checkIntervalHours: 6,
  alarmName: "update-check",
};

/**
 * Compares two semver strings (e.g. "1.1.0" vs "1.2.0").
 * Returns true if remote is strictly newer than local.
 */
function isNewerVersion(remote, local) {
  const r = remote.replace(/^v/, "").split(".").map(Number);
  const l = local.split(".").map(Number);
  for (let i = 0; i < Math.max(r.length, l.length); i++) {
    const rp = r[i] || 0;
    const lp = l[i] || 0;
    if (rp > lp) return true;
    if (rp < lp) return false;
  }
  return false;
}

/**
 * Fetches the latest release from GitHub and stores update info if a newer
 * version is available. Stores result in chrome.storage.local so the popup
 * can display an update banner.
 */
async function checkForUpdate() {
  try {
    const url = `https://api.github.com/repos/${UPDATE_CONFIG.owner}/${UPDATE_CONFIG.repo}/releases/latest`;
    const resp = await fetch(url, {
      headers: { Accept: "application/vnd.github.v3+json" },
    });
    if (!resp.ok) return;

    const release = await resp.json();
    const latestVersion = (release.tag_name || "").replace(/^v/, "");

    if (
      latestVersion &&
      isNewerVersion(latestVersion, UPDATE_CONFIG.currentVersion)
    ) {
      await chrome.storage.local.set({
        updateAvailable: {
          version: latestVersion,
          url: release.html_url,
          notes: (release.body || "").slice(0, 300),
          publishedAt: release.published_at,
          checkedAt: Date.now(),
        },
      });
      // Set a global badge hint so users notice even without opening popup
      chrome.action.setBadgeText({ text: "NEW" });
      chrome.action.setBadgeBackgroundColor({ color: "#C6A6F1" });
    } else {
      // No update (or user already on latest) — clear any stale flag
      await chrome.storage.local.remove("updateAvailable");
    }
  } catch (e) {
    console.warn("[UpdateChecker] Failed to check for updates:", e);
  }
}

// Schedule periodic update checks using chrome.alarms
chrome.alarms.get(UPDATE_CONFIG.alarmName, (alarm) => {
  if (!alarm) {
    chrome.alarms.create(UPDATE_CONFIG.alarmName, {
      delayInMinutes: 1, // first check ~1 min after install/startup
      periodInMinutes: UPDATE_CONFIG.checkIntervalHours * 60,
    });
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === UPDATE_CONFIG.alarmName) {
    checkForUpdate();
  }
});

// Also check on service worker startup
checkForUpdate();

// ========== YouTube itag → format metadata lookup (IDM-style sniffing) ==========
// When YouTube's player.js fetches a videoplayback URL, cipher & N-sig are already
// applied. We capture those URLs and use this table to reconstruct format metadata.
const ITAG_MAP = {
  // Muxed (video + audio)
  18: {
    quality: "360p",
    w: 640,
    h: 360,
    fps: 30,
    ct: "mp4",
    vc: "avc1",
    ac: "mp4a",
    V: 1,
    A: 0,
    M: 1,
  },
  22: {
    quality: "720p",
    w: 1280,
    h: 720,
    fps: 30,
    ct: "mp4",
    vc: "avc1",
    ac: "mp4a",
    V: 1,
    A: 0,
    M: 1,
  },
  // Video-only MP4 (H.264)
  160: {
    quality: "144p",
    w: 256,
    h: 144,
    fps: 30,
    ct: "mp4",
    vc: "avc1",
    ac: null,
    V: 1,
    A: 0,
    M: 0,
  },
  133: {
    quality: "240p",
    w: 426,
    h: 240,
    fps: 30,
    ct: "mp4",
    vc: "avc1",
    ac: null,
    V: 1,
    A: 0,
    M: 0,
  },
  134: {
    quality: "360p",
    w: 640,
    h: 360,
    fps: 30,
    ct: "mp4",
    vc: "avc1",
    ac: null,
    V: 1,
    A: 0,
    M: 0,
  },
  135: {
    quality: "480p",
    w: 854,
    h: 480,
    fps: 30,
    ct: "mp4",
    vc: "avc1",
    ac: null,
    V: 1,
    A: 0,
    M: 0,
  },
  136: {
    quality: "720p",
    w: 1280,
    h: 720,
    fps: 30,
    ct: "mp4",
    vc: "avc1",
    ac: null,
    V: 1,
    A: 0,
    M: 0,
  },
  137: {
    quality: "1080p",
    w: 1920,
    h: 1080,
    fps: 30,
    ct: "mp4",
    vc: "avc1",
    ac: null,
    V: 1,
    A: 0,
    M: 0,
  },
  138: {
    quality: "4320p",
    w: 7680,
    h: 4320,
    fps: 30,
    ct: "mp4",
    vc: "avc1",
    ac: null,
    V: 1,
    A: 0,
    M: 0,
  },
  264: {
    quality: "1440p",
    w: 2560,
    h: 1440,
    fps: 30,
    ct: "mp4",
    vc: "avc1",
    ac: null,
    V: 1,
    A: 0,
    M: 0,
  },
  266: {
    quality: "2160p",
    w: 3840,
    h: 2160,
    fps: 30,
    ct: "mp4",
    vc: "avc1",
    ac: null,
    V: 1,
    A: 0,
    M: 0,
  },
  298: {
    quality: "720p60",
    w: 1280,
    h: 720,
    fps: 60,
    ct: "mp4",
    vc: "avc1",
    ac: null,
    V: 1,
    A: 0,
    M: 0,
  },
  299: {
    quality: "1080p60",
    w: 1920,
    h: 1080,
    fps: 60,
    ct: "mp4",
    vc: "avc1",
    ac: null,
    V: 1,
    A: 0,
    M: 0,
  },
  // Video-only WebM (VP9)
  278: {
    quality: "144p",
    w: 256,
    h: 144,
    fps: 30,
    ct: "webm",
    vc: "vp9",
    ac: null,
    V: 1,
    A: 0,
    M: 0,
  },
  242: {
    quality: "240p",
    w: 426,
    h: 240,
    fps: 30,
    ct: "webm",
    vc: "vp9",
    ac: null,
    V: 1,
    A: 0,
    M: 0,
  },
  243: {
    quality: "360p",
    w: 640,
    h: 360,
    fps: 30,
    ct: "webm",
    vc: "vp9",
    ac: null,
    V: 1,
    A: 0,
    M: 0,
  },
  244: {
    quality: "480p",
    w: 854,
    h: 480,
    fps: 30,
    ct: "webm",
    vc: "vp9",
    ac: null,
    V: 1,
    A: 0,
    M: 0,
  },
  247: {
    quality: "720p",
    w: 1280,
    h: 720,
    fps: 30,
    ct: "webm",
    vc: "vp9",
    ac: null,
    V: 1,
    A: 0,
    M: 0,
  },
  248: {
    quality: "1080p",
    w: 1920,
    h: 1080,
    fps: 30,
    ct: "webm",
    vc: "vp9",
    ac: null,
    V: 1,
    A: 0,
    M: 0,
  },
  271: {
    quality: "1440p",
    w: 2560,
    h: 1440,
    fps: 30,
    ct: "webm",
    vc: "vp9",
    ac: null,
    V: 1,
    A: 0,
    M: 0,
  },
  302: {
    quality: "720p60",
    w: 1280,
    h: 720,
    fps: 60,
    ct: "webm",
    vc: "vp9",
    ac: null,
    V: 1,
    A: 0,
    M: 0,
  },
  303: {
    quality: "1080p60",
    w: 1920,
    h: 1080,
    fps: 60,
    ct: "webm",
    vc: "vp9",
    ac: null,
    V: 1,
    A: 0,
    M: 0,
  },
  308: {
    quality: "1440p60",
    w: 2560,
    h: 1440,
    fps: 60,
    ct: "webm",
    vc: "vp9",
    ac: null,
    V: 1,
    A: 0,
    M: 0,
  },
  313: {
    quality: "2160p",
    w: 3840,
    h: 2160,
    fps: 30,
    ct: "webm",
    vc: "vp9",
    ac: null,
    V: 1,
    A: 0,
    M: 0,
  },
  315: {
    quality: "2160p60",
    w: 3840,
    h: 2160,
    fps: 60,
    ct: "webm",
    vc: "vp9",
    ac: null,
    V: 1,
    A: 0,
    M: 0,
  },
  // Video-only WebM VP9.2 HDR
  330: {
    quality: "144p60 HDR",
    w: 256,
    h: 144,
    fps: 60,
    ct: "webm",
    vc: "vp9.2",
    ac: null,
    V: 1,
    A: 0,
    M: 0,
  },
  331: {
    quality: "240p60 HDR",
    w: 426,
    h: 240,
    fps: 60,
    ct: "webm",
    vc: "vp9.2",
    ac: null,
    V: 1,
    A: 0,
    M: 0,
  },
  332: {
    quality: "360p60 HDR",
    w: 640,
    h: 360,
    fps: 60,
    ct: "webm",
    vc: "vp9.2",
    ac: null,
    V: 1,
    A: 0,
    M: 0,
  },
  333: {
    quality: "480p60 HDR",
    w: 854,
    h: 480,
    fps: 60,
    ct: "webm",
    vc: "vp9.2",
    ac: null,
    V: 1,
    A: 0,
    M: 0,
  },
  334: {
    quality: "720p60 HDR",
    w: 1280,
    h: 720,
    fps: 60,
    ct: "webm",
    vc: "vp9.2",
    ac: null,
    V: 1,
    A: 0,
    M: 0,
  },
  335: {
    quality: "1080p60 HDR",
    w: 1920,
    h: 1080,
    fps: 60,
    ct: "webm",
    vc: "vp9.2",
    ac: null,
    V: 1,
    A: 0,
    M: 0,
  },
  336: {
    quality: "1440p60 HDR",
    w: 2560,
    h: 1440,
    fps: 60,
    ct: "webm",
    vc: "vp9.2",
    ac: null,
    V: 1,
    A: 0,
    M: 0,
  },
  337: {
    quality: "2160p60 HDR",
    w: 3840,
    h: 2160,
    fps: 60,
    ct: "webm",
    vc: "vp9.2",
    ac: null,
    V: 1,
    A: 0,
    M: 0,
  },
  // Video-only MP4 (AV1)
  394: {
    quality: "144p",
    w: 256,
    h: 144,
    fps: 30,
    ct: "mp4",
    vc: "av01",
    ac: null,
    V: 1,
    A: 0,
    M: 0,
  },
  395: {
    quality: "240p",
    w: 426,
    h: 240,
    fps: 30,
    ct: "mp4",
    vc: "av01",
    ac: null,
    V: 1,
    A: 0,
    M: 0,
  },
  396: {
    quality: "360p",
    w: 640,
    h: 360,
    fps: 30,
    ct: "mp4",
    vc: "av01",
    ac: null,
    V: 1,
    A: 0,
    M: 0,
  },
  397: {
    quality: "480p",
    w: 854,
    h: 480,
    fps: 30,
    ct: "mp4",
    vc: "av01",
    ac: null,
    V: 1,
    A: 0,
    M: 0,
  },
  398: {
    quality: "720p",
    w: 1280,
    h: 720,
    fps: 60,
    ct: "mp4",
    vc: "av01",
    ac: null,
    V: 1,
    A: 0,
    M: 0,
  },
  399: {
    quality: "1080p",
    w: 1920,
    h: 1080,
    fps: 60,
    ct: "mp4",
    vc: "av01",
    ac: null,
    V: 1,
    A: 0,
    M: 0,
  },
  400: {
    quality: "1440p",
    w: 2560,
    h: 1440,
    fps: 60,
    ct: "mp4",
    vc: "av01",
    ac: null,
    V: 1,
    A: 0,
    M: 0,
  },
  401: {
    quality: "2160p",
    w: 3840,
    h: 2160,
    fps: 60,
    ct: "mp4",
    vc: "av01",
    ac: null,
    V: 1,
    A: 0,
    M: 0,
  },
  571: {
    quality: "4320p",
    w: 7680,
    h: 4320,
    fps: 60,
    ct: "mp4",
    vc: "av01",
    ac: null,
    V: 1,
    A: 0,
    M: 0,
  },
  // Video-only MP4 AV1 HDR
  694: {
    quality: "144p HDR",
    w: 256,
    h: 144,
    fps: 30,
    ct: "mp4",
    vc: "av01",
    ac: null,
    V: 1,
    A: 0,
    M: 0,
  },
  695: {
    quality: "240p HDR",
    w: 426,
    h: 240,
    fps: 30,
    ct: "mp4",
    vc: "av01",
    ac: null,
    V: 1,
    A: 0,
    M: 0,
  },
  696: {
    quality: "360p HDR",
    w: 640,
    h: 360,
    fps: 30,
    ct: "mp4",
    vc: "av01",
    ac: null,
    V: 1,
    A: 0,
    M: 0,
  },
  697: {
    quality: "480p HDR",
    w: 854,
    h: 480,
    fps: 30,
    ct: "mp4",
    vc: "av01",
    ac: null,
    V: 1,
    A: 0,
    M: 0,
  },
  698: {
    quality: "720p HDR",
    w: 1280,
    h: 720,
    fps: 60,
    ct: "mp4",
    vc: "av01",
    ac: null,
    V: 1,
    A: 0,
    M: 0,
  },
  699: {
    quality: "1080p HDR",
    w: 1920,
    h: 1080,
    fps: 60,
    ct: "mp4",
    vc: "av01",
    ac: null,
    V: 1,
    A: 0,
    M: 0,
  },
  700: {
    quality: "1440p HDR",
    w: 2560,
    h: 1440,
    fps: 60,
    ct: "mp4",
    vc: "av01",
    ac: null,
    V: 1,
    A: 0,
    M: 0,
  },
  701: {
    quality: "2160p HDR",
    w: 3840,
    h: 2160,
    fps: 60,
    ct: "mp4",
    vc: "av01",
    ac: null,
    V: 1,
    A: 0,
    M: 0,
  },
  702: {
    quality: "4320p HDR",
    w: 7680,
    h: 4320,
    fps: 60,
    ct: "mp4",
    vc: "av01",
    ac: null,
    V: 1,
    A: 0,
    M: 0,
  },
  // Audio-only MP4 (AAC)
  139: {
    quality: "48kbps",
    w: 0,
    h: 0,
    fps: 0,
    ct: "mp4",
    vc: null,
    ac: "mp4a",
    V: 0,
    A: 1,
    M: 0,
    abr: 48000,
  },
  140: {
    quality: "128kbps",
    w: 0,
    h: 0,
    fps: 0,
    ct: "mp4",
    vc: null,
    ac: "mp4a",
    V: 0,
    A: 1,
    M: 0,
    abr: 128000,
  },
  141: {
    quality: "256kbps",
    w: 0,
    h: 0,
    fps: 0,
    ct: "mp4",
    vc: null,
    ac: "mp4a",
    V: 0,
    A: 1,
    M: 0,
    abr: 256000,
  },
  256: {
    quality: "192kbps",
    w: 0,
    h: 0,
    fps: 0,
    ct: "mp4",
    vc: null,
    ac: "mp4a",
    V: 0,
    A: 1,
    M: 0,
    abr: 192000,
  },
  258: {
    quality: "384kbps",
    w: 0,
    h: 0,
    fps: 0,
    ct: "mp4",
    vc: null,
    ac: "mp4a",
    V: 0,
    A: 1,
    M: 0,
    abr: 384000,
  },
  327: {
    quality: "256kbps",
    w: 0,
    h: 0,
    fps: 0,
    ct: "mp4",
    vc: null,
    ac: "mp4a",
    V: 0,
    A: 1,
    M: 0,
    abr: 256000,
  },
  // Audio-only WebM (Vorbis)
  171: {
    quality: "128kbps",
    w: 0,
    h: 0,
    fps: 0,
    ct: "webm",
    vc: null,
    ac: "vorbis",
    V: 0,
    A: 1,
    M: 0,
    abr: 128000,
  },
  172: {
    quality: "192kbps",
    w: 0,
    h: 0,
    fps: 0,
    ct: "webm",
    vc: null,
    ac: "vorbis",
    V: 0,
    A: 1,
    M: 0,
    abr: 192000,
  },
  // Audio-only WebM (Opus)
  249: {
    quality: "50kbps",
    w: 0,
    h: 0,
    fps: 0,
    ct: "webm",
    vc: null,
    ac: "opus",
    V: 0,
    A: 1,
    M: 0,
    abr: 50000,
  },
  250: {
    quality: "70kbps",
    w: 0,
    h: 0,
    fps: 0,
    ct: "webm",
    vc: null,
    ac: "opus",
    V: 0,
    A: 1,
    M: 0,
    abr: 70000,
  },
  251: {
    quality: "160kbps",
    w: 0,
    h: 0,
    fps: 0,
    ct: "webm",
    vc: null,
    ac: "opus",
    V: 0,
    A: 1,
    M: 0,
    abr: 160000,
  },
  338: {
    quality: "480kbps",
    w: 0,
    h: 0,
    fps: 0,
    ct: "webm",
    vc: null,
    ac: "opus",
    V: 0,
    A: 1,
    M: 0,
    abr: 480000,
  },
};

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
          { sel: "meta[name='twitter:image']", attr: "content" },
          { sel: "video", attr: "poster" },
        ];
        let thumbnail = null;
        for (const d of selectors) {
          const el = document.querySelector(d.sel);
          if (el) {
            const val = el.getAttribute(d.attr);
            if (val) {
              // Skip generic site images (e.g. tmovie.tv uses a site screenshot as og:image)
              if (
                /postimg\.cc|logo\.png|favicon|assets\/logo|screenshot/i.test(
                  val,
                )
              )
                continue;
              thumbnail = val;
              break;
            }
          }
        }
        // Scrape page HTML for TMDB poster images (Next.js sites proxy imgs)
        if (!thumbnail) {
          try {
            const html = document.documentElement.innerHTML;
            const posterMatch = html.match(
              /https?:\/\/image\.tmdb\.org\/t\/p\/(?:original|w\d+)\/[A-Za-z0-9]+\.jpg/,
            );
            if (posterMatch) thumbnail = posterMatch[0];
            else {
              const anyTmdb = html.match(
                /https?:\/\/image\.tmdb\.org\/t\/p\/(?:original|w\d+)\/[A-Za-z0-9]+\.[a-z]+/,
              );
              if (anyTmdb) thumbnail = anyTmdb[0];
            }
          } catch (_) {}
        }
        const titleMeta = document.querySelector("meta[property='og:title']");
        const vid = document.querySelector("video");
        let duration = null;
        if (
          vid &&
          typeof vid.duration === "number" &&
          isFinite(vid.duration) &&
          vid.duration > 0
        ) {
          duration = vid.duration;
        }
        return {
          title: titleMeta?.content || document.title,
          thumbnail,
          duration,
        };
      },
    });
    if (results?.[0]?.result) {
      const res = results[0].result;
      // Keep duration as raw seconds (number) — popup's formatDuration handles display
      if (
        typeof res.duration !== "number" ||
        !isFinite(res.duration) ||
        res.duration <= 0
      ) {
        res.duration = null;
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
          const existing = downloads[msg.downloadId] || {};
          downloads[msg.downloadId] = {
            // Preserve video metadata and tabId from initial entry
            videoTitle: existing.videoTitle || null,
            videoThumbnail: existing.videoThumbnail || null,
            tabId: existing.tabId || null,
            // Update progress fields
            phase: msg.phase,
            message: msg.message,
            // -1 means "message-only update, keep existing percent"
            percent: msg.percent >= 0 ? msg.percent : existing.percent || 0,
            filename: msg.filename || existing.filename,
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
const VIDEASY_CDN_REFERER_RULE_ID = 4;
const FALSEPARADISE_CDN_REFERER_RULE_ID = 5;
const CHARLIEFREEMAN_CDN_REFERER_RULE_ID = 6;

chrome.declarativeNetRequest
  .updateDynamicRules({
    removeRuleIds: [
      REFERER_RULE_ID,
      INSTAGRAM_REFERER_RULE_ID,
      TWITTER_REFERER_RULE_ID,
      VIDEASY_CDN_REFERER_RULE_ID,
      FALSEPARADISE_CDN_REFERER_RULE_ID,
      CHARLIEFREEMAN_CDN_REFERER_RULE_ID,
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

      // videasy.net CDN (trueparadise.workers.dev) requires Referer + Origin
      {
        id: VIDEASY_CDN_REFERER_RULE_ID,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            {
              header: "Referer",
              operation: "set",
              value: "https://player.videasy.net/",
            },
            {
              header: "Origin",
              operation: "set",
              value: "https://player.videasy.net",
            },
          ],
        },
        condition: {
          urlFilter: "||trueparadise.workers.dev/",
          resourceTypes: ["xmlhttprequest", "media", "other"],
        },
      },

      // videasy.net CDN (falseparadise.workers.dev) — same header requirements
      {
        id: FALSEPARADISE_CDN_REFERER_RULE_ID,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            {
              header: "Referer",
              operation: "set",
              value: "https://player.videasy.net/",
            },
            {
              header: "Origin",
              operation: "set",
              value: "https://player.videasy.net",
            },
          ],
        },
        condition: {
          urlFilter: "||falseparadise.workers.dev/",
          resourceTypes: ["xmlhttprequest", "media", "other"],
        },
      },

      // videasy.net MP4 CDN (charliefreeman.workers.dev) — Yoru/4K MP4 delivery
      {
        id: CHARLIEFREEMAN_CDN_REFERER_RULE_ID,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            {
              header: "Referer",
              operation: "set",
              value: "https://player.videasy.net/",
            },
            {
              header: "Origin",
              operation: "set",
              value: "https://player.videasy.net",
            },
          ],
        },
        condition: {
          urlFilter: "||charliefreeman.workers.dev/",
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
const MERGE_ORIGIN_RULE_ID = 50001;

async function addMergeHeaders(videoUrl, audioUrl) {
  // YouTube CDN requires Origin + Referer headers from youtube.com for ALL
  // client types.  Without them the offscreen fetch sends
  // Origin: chrome-extension://... which yields HTTP 403.
  // Additionally, ANDROID_VR URLs need a matching User-Agent.

  const isYouTube =
    /googlevideo\.com\//i.test(videoUrl || "") ||
    /googlevideo\.com\//i.test(audioUrl || "");

  if (!isYouTube) {
    console.log("[BG] Non-YouTube merge — skipping header rules");
    return [];
  }

  const ruleIds = [];
  const rules = [];

  // --- Rule 1: Always set Origin + Referer for googlevideo.com ---
  rules.push({
    id: MERGE_ORIGIN_RULE_ID,
    priority: 3,
    action: {
      type: "modifyHeaders",
      requestHeaders: [
        {
          header: "Origin",
          operation: "set",
          value: "https://www.youtube.com",
        },
        {
          header: "Referer",
          operation: "set",
          value: "https://www.youtube.com/",
        },
      ],
    },
    condition: {
      urlFilter: "||googlevideo.com/",
      resourceTypes: ["xmlhttprequest", "media", "other"],
    },
  });
  ruleIds.push(MERGE_ORIGIN_RULE_ID);

  // --- Rule 2: ANDROID_VR also needs User-Agent spoofing ---
  const isVR =
    /[?&]c=ANDROID_VR/i.test(videoUrl || "") ||
    /[?&]c=ANDROID_VR/i.test(audioUrl || "");

  if (isVR) {
    rules.push({
      id: MERGE_UA_RULE_ID,
      priority: 4, // higher priority so UA also applies
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
    });
    ruleIds.push(MERGE_UA_RULE_ID);
  }

  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [MERGE_ORIGIN_RULE_ID, MERGE_UA_RULE_ID],
    addRules: rules,
  });
  console.log(
    `[BG] Added merge DNR rules: Origin/Referer${isVR ? " + ANDROID_VR UA" : ""}`,
  );
  return ruleIds;
}

async function removeMergeHeaders(ruleIds) {
  // Always attempt to remove both possible rule IDs to avoid stale rules
  const ids = Array.from(
    new Set([...(ruleIds || []), MERGE_ORIGIN_RULE_ID, MERGE_UA_RULE_ID]),
  );
  await chrome.declarativeNetRequest
    .updateSessionRules({ removeRuleIds: ids })
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
    case "CHECK_FOR_UPDATE":
      checkForUpdate()
        .then(() => respond({ ok: true }))
        .catch(() => respond({ ok: false }));
      return true;

    case "DISMISS_UPDATE":
      chrome.storage.local.remove("updateAvailable").then(() => {
        chrome.action.setBadgeText({ text: "" });
        respond({ ok: true });
      });
      return true;

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

    case "SET_TRUEPARADISE_HOSTS": {
      const hosts = Array.isArray(msg.hosts)
        ? [...new Set(msg.hosts.filter((h) => typeof h === "string" && h))]
        : [];
      chrome.storage.local
        .set({ trueparadiseHosts: hosts })
        .then(() => respond({ success: true, count: hosts.length }))
        .catch((e) => respond({ success: false, error: e.message }));
      return true;
    }

    case "GET_TRUEPARADISE_HOSTS":
      chrome.storage.local
        .get("trueparadiseHosts")
        .then((result) => respond({ hosts: result?.trueparadiseHosts || [] }))
        .catch(() => respond({ hosts: [] }));
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

    case "CANCEL_WORKER_DOWNLOAD":
      chrome.runtime.sendMessage(
        {
          target: "offscreen",
          action: "CANCEL_WORKER_DOWNLOAD",
          downloadId: msg.downloadId,
        },
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
      // Mark as cancelled in session storage
      if (msg.downloadId) {
        chrome.storage.session.get("activeDownloads", (result) => {
          const downloads = result?.activeDownloads || {};
          const existing = downloads[msg.downloadId] || {};
          downloads[msg.downloadId] = {
            ...existing,
            phase: "error",
            message: "Download cancelled",
            percent: 0,
            ts: Date.now(),
          };
          chrome.storage.session
            .set({ activeDownloads: downloads })
            .catch(() => {});
          // Clean up entry after 10s
          setTimeout(() => {
            chrome.storage.session.get("activeDownloads", (r) => {
              const d = r?.activeDownloads || {};
              delete d[msg.downloadId];
              chrome.storage.session
                .set({ activeDownloads: d })
                .catch(() => {});
            });
          }, 10000);
        });
      }
      return true;

    case "WORKER_PROGRESS":
      return false;

    case "OFFSCREEN_DOWNLOAD": {
      // Offscreen docs cannot use chrome.downloads — handle it here.
      const dlFilename = sanitize(msg.filename);
      chrome.downloads.download(
        { url: msg.url, filename: dlFilename, saveAs: true },
        (dlId) => {
          if (chrome.runtime.lastError) {
            console.error(
              "[BG] Offscreen download error:",
              chrome.runtime.lastError.message,
            );
            respond({
              success: false,
              error: chrome.runtime.lastError.message,
            });
            return;
          }
          console.log("[BG] Offscreen download started, id:", dlId);
          respond({ success: true, dlId });

          // Update session state to "saving" (NOT "complete" yet — the file
          // is still being written to disk by Chrome's download manager).
          chrome.storage.session.get("activeDownloads", (result) => {
            const downloads = result?.activeDownloads || {};
            const existing = downloads[msg.downloadId] || {};
            downloads[msg.downloadId] = {
              videoTitle: existing.videoTitle || null,
              videoThumbnail: existing.videoThumbnail || null,
              tabId: existing.tabId || null,
              phase: "saving",
              message: "Saving to disk...",
              percent: 98,
              filename: dlFilename,
              ts: Date.now(),
            };
            chrome.storage.session
              .set({ activeDownloads: downloads })
              .catch(() => {});
          });

          // Monitor download completion and tell offscreen to clean up
          const onChanged = (delta) => {
            if (delta.id !== dlId) return;
            if (
              delta.state &&
              (delta.state.current === "complete" ||
                delta.state.current === "interrupted")
            ) {
              chrome.downloads.onChanged.removeListener(onChanged);

              // NOW the download is truly complete (or failed) — update state
              const isComplete = delta.state.current === "complete";
              chrome.storage.session.get("activeDownloads", (result) => {
                const downloads = result?.activeDownloads || {};
                const existing = downloads[msg.downloadId] || {};
                downloads[msg.downloadId] = {
                  videoTitle: existing.videoTitle || null,
                  videoThumbnail: existing.videoThumbnail || null,
                  tabId: existing.tabId || null,
                  phase: isComplete ? "complete" : "error",
                  message: isComplete
                    ? "Download complete"
                    : "Download failed — network error",
                  percent: isComplete ? 100 : 0,
                  filename: dlFilename,
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

              if (isComplete) {
                notifyComplete(dlFilename);
              }

              // Notify offscreen to revoke blob URL and OPFS cleanup
              chrome.runtime
                .sendMessage({
                  target: "offscreen",
                  action: "DOWNLOAD_CLEANUP",
                  dlId,
                  state: delta.state.current,
                })
                .catch(() => {});
            }
          };
          chrome.downloads.onChanged.addListener(onChanged);

          // Safety net: remove listener after 30min
          setTimeout(
            () => {
              chrome.downloads.onChanged.removeListener(onChanged);
              chrome.runtime
                .sendMessage({
                  target: "offscreen",
                  action: "DOWNLOAD_CLEANUP",
                  dlId,
                  state: "timeout",
                })
                .catch(() => {});
            },
            30 * 60 * 1000,
          );
        },
      );
      return true; // async response
    }

    case "WORKER_COMPLETE":
      if (msg.downloadId) {
        chrome.storage.session.get("activeDownloads", (result) => {
          const downloads = result?.activeDownloads || {};
          const existing = downloads[msg.downloadId] || {};
          downloads[msg.downloadId] = {
            // Preserve video metadata and tabId from initial entry
            videoTitle: existing.videoTitle || null,
            videoThumbnail: existing.videoThumbnail || null,
            tabId: existing.tabId || null,
            // Update completion fields
            phase: msg.success ? "complete" : "error",
            message: msg.success ? "Download complete" : msg.error,
            percent: msg.success ? 100 : 0,
            filename: msg.filename || existing.filename,
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

    case "SPECIALIST_DURATION_UPDATE": {
      const tid = sender.tab?.id;
      if (tid && msg.duration > 0) {
        const cached = tabData.get(tid);
        if (cached?.info && !cached.info.lengthSeconds) {
          cached.info.lengthSeconds = msg.duration;
          tabData.set(tid, cached);
          persistTabData();
          console.log("[BG] Updated specialist duration:", msg.duration);
        }
      }
      return false;
    }

    case "SPECIALIST_THUMBNAIL_UPDATE": {
      const tid2 = sender.tab?.id;
      if (tid2 && msg.thumbnail) {
        const cached = tabData.get(tid2);
        if (cached?.info) {
          // Always replace with a TMDB image (it's movie-specific)
          const isTmdb = /image\.tmdb\.org/i.test(msg.thumbnail);
          const currentIsTmdb = /image\.tmdb\.org/i.test(
            cached.info.thumbnail || "",
          );
          if (isTmdb && !currentIsTmdb) {
            cached.info.thumbnail = msg.thumbnail;
            tabData.set(tid2, cached);
            persistTabData();
            console.log(
              "[BG] Updated specialist thumbnail:",
              msg.thumbnail.substring(0, 80),
            );
          }
        }
      }
      return false;
    }

    case "SPECIALIST_DETECTED":
      onSpecialistDetected(msg, sender.tab?.id)
        .then(respond)
        .catch((e) => respond({ success: false, error: e.message }));
      return true;

    case "IFRAME_STREAM_DETECTED":
      onIframeStreamDetected(msg, sender.tab?.id)
        .then(respond)
        .catch((e) => respond({ success: false, error: e.message }));
      return true;

    case "IFRAME_DURATION_DETECTED": {
      const tid = sender.tab?.id;
      if (
        tid &&
        msg.duration &&
        typeof msg.duration === "number" &&
        isFinite(msg.duration) &&
        msg.duration > 0
      ) {
        const cached = tabData.get(tid);
        if (cached && cached.info && !cached.info.lengthSeconds) {
          // Store raw seconds — popup's formatDuration handles display
          cached.info.lengthSeconds = msg.duration;
          tabData.set(tid, cached);
          persistTabData();
          console.log(
            "[BG] Updated duration from iframe hook:",
            msg.duration,
            "seconds from",
            msg.frameUrl || "unknown",
          );
        }
      }
      return false;
    }

    case "CHECK_SPECIALIST": {
      const scriptFile = findSpecialistForHost(msg.hostname || "");
      respond({ hasSpecialist: !!scriptFile, scriptFile: scriptFile || null });
      return false;
    }
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
    const info = await getFormats(msg.videoId, msg.pageData || {}, tabId);

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
  const info = await getFormats(videoId, {}, tabId);
  tabData.set(tabId, { videoId, info, ts: Date.now() });
  persistTabData();
  return info;
}

async function getFormats(videoId, pageData, tabId = null) {
  if (pendingRequests.has(videoId)) {
    return pendingRequests.get(videoId);
  }
  const promise = getFormatsInner(videoId, pageData, tabId);
  pendingRequests.set(videoId, promise);
  try {
    return await promise;
  } finally {
    pendingRequests.delete(videoId);
  }
}

async function getFormatsInner(videoId, pageData, tabId = null) {
  // ============ Common setup (shared by all tiers) ============
  // Tier priority (2026+ architecture):
  //   Tier 1: InnerTube API clients (android_vr, web) — most reliable
  //   Tier 2: Page scrape + AST solver (meriyah/astring) — resilient to formatting changes
  //   Tier S: Sniffed googlevideo.com URLs (IDM-style) — fully decrypted by YouTube's player
  //   Tier 3: inject.js resolvedFormats (regex-based) — fast but fragile fallback
  console.log(
    "[BG] getFormatsInner:",
    videoId,
    "| resolvedFormats:",
    pageData.resolvedFormats?.length || 0,
    "| playerUrl:",
    !!pageData.playerUrl,
    "| resolveError:",
    pageData.resolveError || "none",
  );

  let visitorData = pageData.visitorData || null;
  let playerUrl = pageData.playerUrl || null;
  let pagePlayerResp = pageData.playerResponse || null;
  let nSigCode = pageData.nSigCode || null;
  let cipherCode = pageData.cipherCode || null;
  let cipherArgName = pageData.cipherArgName || null;
  let cipherActionsFromPage = pageData.cipherActions || null;

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

  // Use cipher actions extracted by inject.js via direct global access
  if (cipherActionsFromPage && sig && !sig.actionList) {
    sig.actionList = cipherActionsFromPage;
    console.log(
      "[BG] Using cipher actions from inject.js (direct global):",
      cipherActionsFromPage.length,
      "ops",
    );
  }

  // ============ Tier 1: InnerTube API clients ============
  // android_vr returns plain URLs (no cipher needed), web needs cipher.
  // This is the most reliable tier — independent of page injection and regex.
  const order = ["android_vr", "web"];
  let lastErr = null;
  let allFormats = [];
  let successfulClients = [];
  let bestVideoDetails = null;
  let triedWebEmbedded = false;

  // Build a merged sig object that fills in nSigBundled / nSigCode from
  // pageData when the player-derived sig is missing those fields.
  const mergedSig =
    sig || nSigCode
      ? {
          ...sig,
          nSigCode: sig?.nSigCode ?? nSigCode ?? null,
          nSigBundled: sig?.nSigBundled ?? pageData.nSigBundled ?? null,
        }
      : null;

  for (const key of order) {
    try {
      console.log("[BG] Tier 1: Trying InnerTube client:", key);
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

        if (mergedSig?.nSigCode) {
          await applyNSig(info.formats, mergedSig);
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

          if (mergedSig?.nSigCode) {
            await applyNSig(ciphered.formats, mergedSig);
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

          if (mergedSig?.nSigCode) {
            await applyNSig(ciphered.formats, mergedSig);
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
      "[BG] ★ Tier 1: Merging formats from",
      successfulClients.length,
      "clients:",
      successfulClients.join(", "),
    );

    const mergedFormats = deduplicateFormats(allFormats);

    // Enrich Tier 1 formats with sniffed URLs (IDM-style)
    const resolveTabId1 = tabId || findTabIdForVideoId(videoId);
    if (resolveTabId1) {
      const enriched = enrichFormatsWithSniffed(mergedFormats, resolveTabId1);
      if (enriched > 0) {
        console.log(
          "[BG] Tier 1: Enriched",
          enriched,
          "format URLs from sniffed googlevideo.com requests",
        );
      }
    }

    const vd = bestVideoDetails || {};

    return {
      videoId: vd.videoId || videoId,
      title: vd.title || "YouTube Video",
      author: vd.author || "",
      lengthSeconds: parseInt(vd.lengthSeconds) || 0,
      thumbnail: vd.thumbnail?.thumbnails?.slice(-1)[0]?.url || "",
      formats: mergedFormats,
      clientUsed: successfulClients.join("+"),
      loggedIn: pageData.loggedIn ?? null,
    };
  }

  // ============ Tier 2: Page scrape + AST solver ============
  // Uses meriyah/astring to structurally parse player.js — resilient to
  // minifier changes (quoting style, variable names, etc.).
  console.log(
    "[BG] Tier 1 API clients exhausted (",
    lastErr || "no formats",
    "), trying Tier 2 (page scrape + AST solver)...",
  );
  try {
    const tier2Result = await pageScrapeWithCipher(
      videoId,
      pagePlayerResp,
      playerUrl,
      sig,
      lastErr,
      cipherCode,
      cipherArgName,
      pageData.loggedIn ?? null,
    );
    if (tier2Result && tier2Result.formats && tier2Result.formats.length > 0) {
      console.log(
        "[BG] ★ Tier 2: Page scrape + AST solver returned",
        tier2Result.formats.length,
        "formats",
      );

      // Enrich Tier 2 formats with sniffed URLs
      const resolveTabId2 = tabId || findTabIdForVideoId(videoId);
      if (resolveTabId2) {
        const enriched = enrichFormatsWithSniffed(
          tier2Result.formats,
          resolveTabId2,
        );
        if (enriched > 0) {
          console.log(
            "[BG] Tier 2: Enriched",
            enriched,
            "format URLs from sniffed googlevideo.com requests",
          );
        }
      }
      return tier2Result;
    }
    console.log("[BG] Tier 2 returned 0 formats, continuing...");
  } catch (tier2Err) {
    console.warn(
      "[BG] Tier 2 (page scrape + AST solver) failed:",
      tier2Err.message,
    );
  }

  // ============ Tier S: Sniffed URLs (IDM-style fallback) ============
  // Fully-working googlevideo.com URLs captured from YouTube's own player
  // network requests. Already have correct cipher + N-sig applied.
  const sniffTabId = tabId || findTabIdForVideoId(videoId);
  if (sniffTabId) {
    const sniffedFormats = buildSniffedFormats(sniffTabId);
    if (sniffedFormats.length > 0) {
      console.log(
        "[BG] ★ Tier S: Using",
        sniffedFormats.length,
        "sniffed googlevideo.com URLs (IDM-style bypass)",
      );

      const td = tabData.get(sniffTabId);
      const vd = pageData.playerResponse?.videoDetails || {};
      const title =
        vd.title || pageData.title || td?.info?.title || "YouTube Video";
      const author = vd.author || pageData.author || td?.info?.author || "";
      const lengthSeconds =
        parseInt(vd.lengthSeconds) ||
        pageData.duration ||
        td?.info?.lengthSeconds ||
        0;
      const thumbnail =
        vd.thumbnail?.thumbnails?.slice(-1)[0]?.url ||
        pageData.thumbnail ||
        td?.info?.thumbnail ||
        "";

      return {
        videoId,
        title,
        author,
        lengthSeconds,
        thumbnail,
        formats: sniffedFormats,
        clientUsed: "sniffed",
        loggedIn: pageData.loggedIn ?? null,
      };
    }
  }

  // ============ Tier 3: inject.js resolvedFormats (regex-based fallback) ============
  // inject.js runs in the page's MAIN world and may have already resolved
  // format URLs using regex-based cipher/N-sig extraction. This is the fastest
  // path but the most fragile — regex patterns break when YouTube's Closure
  // Compiler changes its output style.
  if (pageData.resolvedFormats && pageData.resolvedFormats.length > 0) {
    console.log(
      "[BG] ★ Tier 3: Using",
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

    // Apply N-sig transformation if inject.js didn't do it directly
    if (!pageData.directNSig) {
      const hasUntransformedN = pageData.resolvedFormats.some(
        (f) => f.url && /[?&]n=([^&]{15,})/.test(f.url),
      );

      if (hasUntransformedN) {
        const t3Sig = sig || (playerUrl ? null : null);
        const t3nSigCode = nSigCode || t3Sig?.nSigCode || null;
        const t3nSigBundled =
          pageData.nSigBundled || t3Sig?.nSigBundled || null;

        if (t3nSigCode) {
          console.log(
            "[BG] Tier 3: Applying N-sig transform to",
            pageData.resolvedFormats.length,
            "formats",
          );
          await applyNSig(
            pageData.resolvedFormats,
            t3Sig || { nSigCode: t3nSigCode, nSigBundled: t3nSigBundled },
          );
        } else {
          console.warn(
            "[BG] Tier 3: No N-sig code available — downloads may be throttled",
          );
        }
      }
    } else {
      console.log("[BG] Tier 3: N-sig already applied by inject.js (direct)");
    }

    // Enrich with sniffed URLs
    const resolveTabId3 = tabId || findTabIdForVideoId(videoId);
    if (resolveTabId3) {
      const enriched = enrichFormatsWithSniffed(
        pageData.resolvedFormats,
        resolveTabId3,
      );
      if (enriched > 0) {
        console.log(
          "[BG] Tier 3: Enriched",
          enriched,
          "format URLs from sniffed googlevideo.com requests",
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
      loggedIn: pageData.loggedIn ?? null,
    };
  }

  // All tiers exhausted
  console.error(
    "[BG] All extraction tiers failed for",
    videoId,
    "| lastErr:",
    lastErr,
  );
  throw new Error(lastErr || "All extraction tiers failed");
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

  const decodedParams = entries.map((e) => e.decoded);
  let results = null;
  let succeeded = false;

  // Try 1: Plain N-sig code (original extraction)
  try {
    results = await sandboxEval(sig.nSigCode, decodedParams);
    // Validate: check if at least one value actually changed
    const anyChanged = results.some(
      (r, i) => r && typeof r === "string" && r !== decodedParams[i],
    );
    if (anyChanged) {
      succeeded = true;
      console.log("[BG] N-sig transform succeeded (plain code)");
    } else {
      console.warn(
        "[BG] N-sig plain code returned unchanged values — trying bundled...",
      );
    }
  } catch (err) {
    console.warn(
      "[BG] N-sig plain code failed:",
      err.message,
      "— trying bundled...",
    );
  }

  // Try 2: yt-dlp bundled N-sig (includes all dependencies)
  if (!succeeded && sig.nSigBundled) {
    try {
      results = await sandboxEval(sig.nSigBundled, decodedParams);
      const anyChanged = results.some(
        (r, i) => r && typeof r === "string" && r !== decodedParams[i],
      );
      if (anyChanged) {
        succeeded = true;
        console.log("[BG] ★ N-sig transform succeeded (yt-dlp bundled code)");
      } else {
        console.warn("[BG] N-sig bundled code also returned unchanged values");
      }
    } catch (err2) {
      console.warn("[BG] N-sig bundled code also failed:", err2.message);
    }
  }

  if (!succeeded) {
    console.warn(
      "[BG] All N-sig transforms failed — downloads may be throttled. " +
        "Sniffed URLs (IDM-style) will be used if available.",
    );
    return;
  }

  // Apply successful results
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const r = results[i];
    if (r && typeof r === "string" && r !== e.decoded) {
      const fmt = formats.find((f) => f.itag === e.itag);
      if (fmt)
        fmt.url = fmt.url.replace("n=" + e.raw, "n=" + encodeURIComponent(r));
    }
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

// ═══════════════════════════════════════════════════════════════════════════
// yt-dlp-style full player.js solver
// Sends the ENTIRE ~1MB player.js to the sandbox, which uses meriyah (AST
// parser) + astring (code generator) + yt.solver.core.js to find the n-sig
// and cipher functions structurally, then executes the whole player.js to
// solve all challenges in one shot.  This is the same approach yt-dlp uses
// with Deno/Node — but we use the Chrome MV3 sandbox iframe instead.
// ═══════════════════════════════════════════════════════════════════════════

async function sandboxSolvePlayer(
  playerJs,
  playerUrl,
  nChallenges,
  sigChallenges,
) {
  await ensureOffscreen();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      console.warn("[BG] Player solver timed out (35s)");
      reject(new Error("Player solver timed out"));
    }, 35000);

    chrome.runtime.sendMessage(
      {
        target: "offscreen",
        action: "SOLVE_PLAYER",
        playerJs,
        playerUrl,
        nChallenges: nChallenges || [],
        sigChallenges: sigChallenges || [],
      },
      (response) => {
        clearTimeout(timeout);
        if (chrome.runtime.lastError) {
          console.warn(
            "[BG] Player solver message error:",
            chrome.runtime.lastError.message,
          );
          reject(
            new Error(
              "Player solver communication failed: " +
                chrome.runtime.lastError.message,
            ),
          );
          return;
        }
        if (response?.timedOut || response?.error) {
          console.warn("[BG] Player solver error:", response.error);
          reject(
            new Error("Player solver failed: " + (response.error || "unknown")),
          );
          return;
        }
        resolve({
          nResults: response?.nResults || {},
          sigResults: response?.sigResults || {},
          cached: response?.cached || false,
          elapsed: response?.elapsed || 0,
        });
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
  loggedIn,
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

  // === yt-dlp style full player.js solver (try first) ===
  let solverOk = false;
  if (sig?.playerSource) {
    // Collect challenges for the solver — include N params from cipher URLs too
    const nChallengeSet = new Set(nEntries.map((e) => e.decoded));
    for (const cEntry of cipherQueue) {
      const nm = /[?&]n=([^&]+)/i.exec(cEntry.url);
      if (nm) nChallengeSet.add(decodeURIComponent(nm[1]));
    }
    const nChallenges = [...nChallengeSet];
    const sigChallenges = cipherQueue.map((e) => e.s);

    if (nChallenges.length || sigChallenges.length) {
      console.log(
        "[BG] Trying full player.js solver:",
        nChallenges.length,
        "n-sig +",
        sigChallenges.length,
        "cipher challenges",
      );
      try {
        const solverResult = await sandboxSolvePlayer(
          sig.playerSource,
          sig.playerUrl || playerUrl,
          nChallenges,
          sigChallenges,
        );
        const { nResults, sigResults, cached, elapsed } = solverResult;
        console.log(
          "[BG] Full solver returned in",
          elapsed + "ms",
          cached ? "(cached)" : "",
          "| n-sig results:",
          Object.keys(nResults).length,
          "| cipher results:",
          Object.keys(sigResults).length,
        );

        // Apply cipher results from solver
        let cipherOk = 0;
        if (sigChallenges.length) {
          for (const { fmt, url, sp, s } of cipherQueue) {
            const sig2 = sigResults[s];
            if (!sig2 || typeof sig2 !== "string") continue;
            cipherOk++;

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
            if (nm) {
              nEntries.push({
                idx: formats.length,
                raw: nm[1],
                decoded: decodeURIComponent(nm[1]),
              });
              // Also add to nChallenges so solver result covers them
              const decoded = decodeURIComponent(nm[1]);
              if (!nResults[decoded]) {
                // This n wasn't in original challenges — can't solve it here,
                // but mark it for fallback. This shouldn't normally happen since
                // cipher-only streams also have n= params we already collected.
              }
            }
            formats.push(entry);
          }
        }

        // Apply N-sig results from solver (covers both original and cipher-added entries)
        let nSigOk = 0;
        for (const e of nEntries) {
          const r = nResults[e.decoded];
          if (r && typeof r === "string" && r !== e.decoded) {
            formats[e.idx].url = formats[e.idx].url.replace(
              "n=" + e.raw,
              "n=" + encodeURIComponent(r),
            );
            nSigOk++;
          }
        }

        // Check if solver produced enough results to consider it successful
        const cipherNeeded = sigChallenges.length;
        const nSigNeeded = nEntries.length;
        solverOk =
          (cipherNeeded === 0 || cipherOk >= cipherNeeded * 0.5) &&
          (nSigNeeded === 0 || nSigOk >= nSigNeeded * 0.5);

        console.log(
          "[BG] Full solver results: cipher",
          cipherOk + "/" + cipherNeeded,
          "| n-sig",
          nSigOk + "/" + nSigNeeded,
          "| solverOk:",
          solverOk,
        );
      } catch (solverErr) {
        console.warn("[BG] Full player.js solver failed:", solverErr.message);
        // Fall through to regex-based approach
      }
    }
  }

  // === Fallback: regex-based cipher + N-sig processing ===
  if (!solverOk) {
    if (cipherQueue.length && (cipherCode || sig?.cipherCode)) {
      const cc = cipherCode || sig.cipherCode;
      const ca = cipherArgName || sig?.cipherArgName || "a";
      console.log(
        "[BG] Tier 2 fallback: sandbox cipher eval for",
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
  }

  return {
    videoId: vd.videoId || videoId,
    title: vd.title || "YouTube Video",
    author: vd.author || "",
    lengthSeconds: parseInt(vd.lengthSeconds) || 0,
    thumbnail: vd.thumbnail?.thumbnails?.slice(-1)[0]?.url || "",
    formats,
    clientUsed: "page_scrape",
    loggedIn: loggedIn ?? null,
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

  // Also try to fetch the YouTube page HTML to find cipher helper
  // (2025+ architecture: helper defined in inline scripts, not in base.js)
  // The helper (e.g. eO) and N-sig wrapper (e.g. R8K) are only present on
  // watch pages, NOT on the homepage.  Try to find a videoId from cached
  // tab data so we fetch the right page.
  let pageHtml = null;
  try {
    let pageVideoId = null;
    for (const [, td] of tabData) {
      if (td?.videoId) {
        pageVideoId = td.videoId;
        break;
      }
    }
    const pageUrl = pageVideoId
      ? `https://www.youtube.com/watch?v=${pageVideoId}`
      : "https://www.youtube.com/";
    console.log("[BG] Fetching page HTML for cipher helper:", pageUrl);
    const pageResp = await fetch(pageUrl, { cache: "force-cache" });
    if (pageResp.ok) {
      pageHtml = await pageResp.text();
      console.log(
        "[BG] Page HTML loaded for cipher helper extraction:",
        pageHtml.length,
        "bytes",
      );
    }
  } catch (e) {
    console.warn(
      "[BG] Could not fetch page HTML for cipher helper:",
      e.message,
    );
  }

  const actionList = extractCipherActions(js, pageHtml);
  const nSigCode = extractNSigCode(js);

  // yt-dlp style: bundle N-sig with all its dependencies for robust sandbox eval
  let nSigBundled = null;
  if (nSigCode) {
    try {
      nSigBundled = bundleNSigWithDeps(js);
      if (nSigBundled && nSigBundled !== nSigCode) {
        console.log(
          "[BG] yt-dlp bundled N-sig available (" +
            nSigBundled.length +
            "ch vs " +
            nSigCode.length +
            "ch plain)",
        );
      } else {
        nSigBundled = null; // No benefit, skip
      }
    } catch (e) {
      console.warn("[BG] yt-dlp N-sig bundling failed:", e.message);
    }
  }

  let cipherCode = null;
  let cipherArgName = null;
  if (!actionList) {
    const extracted = extractRawCipherCode(js, pageHtml);
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
    nSigBundled,
    cipherCode,
    cipherArgName,
    sts,
    playerUrl,
    playerSource: js,
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
    nSigBundled ? "(bundled: " + nSigBundled.length + "ch)" : "",
    "| STS:",
    sts,
    "| PlayerSource:",
    js ? js.length + "ch" : "none",
  );
  return data;
}

// === Cipher function disambiguation helper ===
// YouTube often has multiple functions with the same short name (e.g. "is").
// The real cipher function: 2+ params, body > 100 chars, lookup array refs.
function findCipherFuncDefBG(js, funcName, lookupName) {
  const esc = escRe(funcName);
  const defRe = new RegExp(esc + "\\s*=\\s*function\\s*\\(([^)]*)\\)", "g");
  let dm;
  const candidates = [];

  while ((dm = defRe.exec(js)) !== null) {
    const params = dm[1]
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p);
    const braceIdx = js.indexOf("{", dm.index + dm[0].length - 1);
    if (braceIdx === -1) continue;
    const body = extractBraceBlock(js, braceIdx);
    if (!body) continue;

    candidates.push({
      params,
      body,
      bodyLen: body.length,
      hasLookup: lookupName ? body.indexOf(lookupName + "[") !== -1 : false,
      idx: dm.index,
    });
  }

  console.log(
    "[BG] Cipher '" + funcName + "' definitions found:",
    candidates.length,
    candidates.map(
      (c) =>
        "params=" +
        c.params.length +
        " body=" +
        c.bodyLen +
        " lookup=" +
        c.hasLookup,
    ),
  );

  // Priority 1: 2+ params with lookup array references, largest body
  let best = null;
  for (const c of candidates) {
    if (c.params.length >= 2 && c.hasLookup) {
      if (!best || c.bodyLen > best.bodyLen) best = c;
    }
  }
  // Priority 2: 2+ params, largest body > 100 chars
  if (!best) {
    for (const c of candidates) {
      if (c.params.length >= 2 && c.bodyLen > 100) {
        if (!best || c.bodyLen > best.bodyLen) best = c;
      }
    }
  }
  // Priority 3: largest body with lookup refs
  if (!best) {
    for (const c of candidates) {
      if (c.hasLookup && c.bodyLen > 100) {
        if (!best || c.bodyLen > best.bodyLen) best = c;
      }
    }
  }

  if (best) {
    console.log(
      "[BG] Cipher func def resolved:",
      funcName,
      "params=" + best.params.length,
      "body=" + best.bodyLen + "ch",
      "lookup=" + best.hasLookup,
    );
    return best;
  }

  console.warn(
    "[BG] No suitable cipher function definition found for:",
    funcName,
  );
  return null;
}

// === New-style dispatch cipher extraction (2025+) ===
// YouTube now uses a dispatch function with a lookup array and a helper
// object containing reverse/splice/swap methods, all referenced via
// array indices rather than literal property names.
// The helper object (e.g., eO) is defined in inline <script> tags on
// the YouTube page, NOT in player.js (base.js). We search both.
function extractDispatchCipherActions(
  js,
  cipherFuncName,
  dispatchValue,
  pageHtml,
) {
  // Step 1: Find lookup array: var NAME = "...".split("DELIM") with 50+ elements
  const lookupArrayRe =
    /(?:var\s+|[;,]\s*)([a-zA-Z0-9$_]+)\s*=\s*"([^"]{200,})"\s*\.\s*split\s*\(\s*"([^"]+)"\s*\)/g;
  let lookupArray = null,
    lookupName = null,
    lm;
  while ((lm = lookupArrayRe.exec(js)) !== null) {
    const parts = lm[2].split(lm[3]);
    if (parts.length > 50) {
      lookupArray = parts;
      lookupName = lm[1];
      break;
    }
  }
  if (!lookupArray || !lookupName) return null;

  // Step 2: Find cipher function definition (disambiguate short names)
  const cipherDef = findCipherFuncDefBG(js, cipherFuncName, lookupName);
  if (!cipherDef) return null;
  const funcBody = cipherDef.body;

  // Step 3: Find calls to helper object via lookup: OBJ[LOOKUP[IDX]](VAR, NUM)
  const lookupEsc = escRe(lookupName);
  const helperCallRe = new RegExp(
    `([a-zA-Z0-9$_]+)\\[${lookupEsc}\\[(\\d+)\\]\\]\\s*\\(\\s*([a-zA-Z0-9$_]+)\\s*,\\s*(\\d+)\\s*\\)`,
    "g",
  );
  const calls = [];
  let hm;
  while ((hm = helperCallRe.exec(funcBody)) !== null) {
    calls.push({
      obj: hm[1],
      methodName: lookupArray[parseInt(hm[2])],
      arg: parseInt(hm[4]),
    });
  }
  if (!calls.length) return null;

  // Step 4: Find helper object definition — search BOTH player.js AND page HTML
  const helperName = calls[0].obj;
  let helperBlock = null;

  // Try player.js first
  const helperDefMatch = js.match(
    new RegExp(`(?:var\\s+|[;,]\\s*)${escRe(helperName)}\\s*=\\s*\\{`),
  );
  if (helperDefMatch) {
    const helperBraceIdx = js.indexOf(
      "{",
      helperDefMatch.index + helperDefMatch[0].lastIndexOf("=") + 1,
    );
    helperBlock = extractBraceBlock(js, helperBraceIdx);
  }

  // If not found in player.js, try page HTML (inline scripts)
  if (!helperBlock && pageHtml) {
    console.log(
      "[BG] Cipher helper '" +
        helperName +
        "' not in player.js — searching page HTML",
    );
    const htmlHelperRe = new RegExp(
      `(?:var\\s+)?${escRe(helperName)}\\s*=\\s*\\{`,
    );
    const htmlMatch = htmlHelperRe.exec(pageHtml);
    if (htmlMatch) {
      const htmlBraceIdx = htmlMatch.index + htmlMatch[0].lastIndexOf("{");
      helperBlock = extractBraceBlock(pageHtml, htmlBraceIdx);
      if (helperBlock) {
        console.log(
          "[BG] Cipher helper found in page HTML:",
          helperBlock.length,
          "chars",
        );
      }
    }
  }

  if (!helperBlock) {
    console.warn(
      "[BG] Cipher helper '" +
        helperName +
        "' not found in player.js or page HTML",
    );
    return null;
  }

  // Step 5: Map method names to operation types by structural analysis
  const types = {};
  // Match all method patterns: traditional, shorthand, arrow
  const methodPatterns = [
    /([a-zA-Z0-9$_]+)\s*:\s*function\s*\([^)]*\)\s*\{/g,
    /([a-zA-Z0-9$_]+)\s*\([^)]*\)\s*\{/g,
    /([a-zA-Z0-9$_]+)\s*:\s*\([^)]*\)\s*=>\s*\{/g,
  ];
  for (const mre of methodPatterns) {
    let mm;
    while ((mm = mre.exec(helperBlock)) !== null) {
      const localBraceIdx = mm.index + mm[0].lastIndexOf("{");
      const methodBody = extractBraceBlock(helperBlock, localBraceIdx);
      if (!methodBody) continue;
      if (/\[\s*0\s*\]\s*=/.test(methodBody) && /\w+\s*%/.test(methodBody))
        types[mm[1]] = "swap";
      else if (
        /\.splice\s*\(/.test(methodBody) ||
        /\(0\s*,\s*\w+\)/.test(methodBody)
      )
        types[mm[1]] = "splice";
      else if (/\.reverse\s*\(/.test(methodBody)) types[mm[1]] = "reverse";
      else {
        // Likely a no-arg method (reverse variant) — log for debugging
        // rather than silently assuming reverse
        console.warn(
          "[BG] Unrecognized cipher method:",
          mm[1],
          "body:",
          methodBody.slice(0, 120),
        );
        types[mm[1]] = "reverse";
      }
    }
  }

  // Step 6: Build action list
  const actions = [];
  for (const call of calls) {
    const type = types[call.methodName];
    if (type) actions.push([type, type === "reverse" ? null : call.arg]);
  }
  if (actions.length > 0) {
    console.log(
      "[BG] Cipher via dispatch:",
      cipherFuncName + "(" + dispatchValue + ") →",
      actions
        .map((a) => a[0] + (a[1] != null ? "(" + a[1] + ")" : ""))
        .join(", "),
    );
    return actions;
  }
  return null;
}

function extractDispatchCipherRaw(js, cipherFuncName, dispatchValue, pageHtml) {
  // Find lookup array raw definition
  const lookupMatch = js.match(
    /var\s+([a-zA-Z0-9$_]+)\s*=\s*("([^"]{200,})")\s*\.\s*split\s*\(\s*"([^"]+)"\s*\)/,
  );
  if (!lookupMatch) return null;
  const lookupName = lookupMatch[1];
  const parts = lookupMatch[3].split(lookupMatch[4]);
  if (parts.length < 50) return null;

  // Find cipher function definition (disambiguate short names)
  const cipherDef = findCipherFuncDefBG(js, cipherFuncName, lookupName);
  if (!cipherDef) return null;
  const funcBody = cipherDef.body;
  const paramStr = cipherDef.params.join(", ");

  // Find helper object name from function body
  const lookupEsc = escRe(lookupName);
  const helperRefRe = new RegExp(`([a-zA-Z0-9$_]+)\\[${lookupEsc}\\[`);
  const helperRefMatch = funcBody.match(helperRefRe);
  if (!helperRefMatch) return null;
  const helperName = helperRefMatch[1];

  // Find helper object definition — search player.js first, then page HTML
  let helperBlock = null;
  const helperDefMatch = js.match(
    new RegExp(`(?:var\\s+|[;,]\\s*)${escRe(helperName)}\\s*=\\s*\\{`),
  );
  if (helperDefMatch) {
    const helperBraceIdx = js.indexOf(
      "{",
      helperDefMatch.index + helperDefMatch[0].lastIndexOf("=") + 1,
    );
    helperBlock = extractBraceBlock(js, helperBraceIdx);
  }

  // 2025+ architecture: helper may live in inline <script> in page HTML
  if (!helperBlock && pageHtml) {
    console.log(
      "[BG] Raw cipher helper '" +
        helperName +
        "' not in player.js — searching page HTML",
    );
    const htmlHelperRe = new RegExp(
      `(?:var\\s+)?${escRe(helperName)}\\s*=\\s*\\{`,
    );
    const htmlMatch = htmlHelperRe.exec(pageHtml);
    if (htmlMatch) {
      const htmlBraceIdx = htmlMatch.index + htmlMatch[0].lastIndexOf("{");
      helperBlock = extractBraceBlock(pageHtml, htmlBraceIdx);
      if (helperBlock) {
        console.log(
          "[BG] Raw cipher helper found in page HTML:",
          helperBlock.length,
          "chars",
        );
      }
    }
  }

  if (!helperBlock) return null;

  // Build self-contained code with a unique arg name
  const argName = "_sig_";
  const code =
    "var " +
    lookupName +
    "=" +
    lookupMatch[2] +
    '.split("' +
    lookupMatch[4] +
    '");\n' +
    "var " +
    helperName +
    "=" +
    helperBlock +
    ";\n" +
    "var " +
    cipherFuncName +
    "=function(" +
    paramStr +
    ")" +
    funcBody +
    ";\n" +
    "return " +
    cipherFuncName +
    "(" +
    dispatchValue +
    ", " +
    argName +
    ");";

  console.log("[BG] Raw dispatch cipher:", code.length, "chars");
  return { code, argName };
}

function extractCipherActions(js, pageHtml) {
  // === Try new-style dispatch cipher first (2025+) ===
  const dispatchCallMatch = js.match(
    /=\s*([a-zA-Z0-9$_]+)\s*\(\s*(\d+)\s*,\s*decodeURIComponent\s*\(\s*\w+\.\s*s\s*\)\s*\)/,
  );
  if (dispatchCallMatch) {
    const actions = extractDispatchCipherActions(
      js,
      dispatchCallMatch[1],
      parseInt(dispatchCallMatch[2]),
      pageHtml,
    );
    if (actions) return actions;
  }

  // === Legacy patterns (pre-2025) ===
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

function extractRawCipherCode(js, pageHtml) {
  // === Try new-style dispatch cipher first (2025+) ===
  const dispatchCallMatch = js.match(
    /=\s*([a-zA-Z0-9$_]+)\s*\(\s*(\d+)\s*,\s*decodeURIComponent\s*\(\s*\w+\.\s*s\s*\)\s*\)/,
  );
  if (dispatchCallMatch) {
    const raw = extractDispatchCipherRaw(
      js,
      dispatchCallMatch[1],
      dispatchCallMatch[2],
      pageHtml,
    );
    if (raw) return raw;
  }

  // === Legacy patterns (pre-2025) ===
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

  // === 2025+ patterns: lookup-array-based references ===
  // YouTube now uses l[33]="n", l[42]="get", l[20]="set" instead of literal strings
  // Pattern: WRAPPER[0](x), VAR[l[SET_IDX]](l[N_IDX], x) or VAR.set("n", x)
  const lookupArrayRe =
    /(?:var\s+|[;,]\s*)([a-zA-Z0-9$_]+)\s*=\s*"([^"]{200,})"\s*\.\s*split\s*\(\s*"([^"]+)"\s*\)/;
  const lookupMatch = js.match(lookupArrayRe);
  if (lookupMatch) {
    const lookupArray = lookupMatch[2].split(lookupMatch[3]);
    const nIdx = lookupArray.indexOf("n");
    const setIdx = lookupArray.indexOf("set");

    if (nIdx !== -1 && setIdx !== -1) {
      // Search for: WRAPPER[0](x) near l[nIdx] context
      const lookupName = lookupMatch[1];
      const wrapperRe = new RegExp(
        "([a-zA-Z0-9$_]+)\\[0\\]\\s*\\(\\s*(\\w+)\\s*\\)",
        "g",
      );
      let wm;
      while ((wm = wrapperRe.exec(js)) !== null) {
        const ctx = js.substring(
          Math.max(0, wm.index - 100),
          Math.min(js.length, wm.index + 200),
        );
        if (
          ctx.indexOf(lookupName + "[" + nIdx + "]") !== -1 ||
          ctx.indexOf('"n"') !== -1
        ) {
          fn = wm[1];
          arrIdx = 0;
          console.log(
            "[BG] N-sig wrapper found via lookup pattern:",
            fn,
            "[0]",
          );
          break;
        }
      }
    }
  }

  // === Legacy patterns (pre-2025) ===
  if (!fn) {
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
    // var/let/const function expression: var H = function(a) {
    new RegExp(
      `(?:var|let|const)\\s+${esc}\\s*=\\s*function\\s*\\(([^)]*)\\)\\s*\\{`,
      "g",
    ),
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

// ============================================================
// yt-dlp-style N-sig dependency bundler
// ============================================================
// When YouTube's N-sig function references helper functions and variables
// defined elsewhere in player.js (inside the IIFE), sandbox eval fails with
// "X is not defined" errors. This function extracts the N-sig function AND
// all its dependencies (helper functions, internal lookup arrays, constants)
// into a single self-contained code string that the sandbox can execute.
//
// This mirrors yt-dlp's _extract_n_function_code() approach, which:
// 1. Finds the N-sig function
// 2. Identifies free variables (references to IIFE-scoped identifiers)
// 3. Recursively extracts their definitions from player.js
// 4. Bundles everything into a standalone script
// ============================================================

function bundleNSigWithDeps(js) {
  // Step 1: Find N-sig function name the same way extractNSigCode does
  const nSigCode = extractNSigCode(js);
  if (!nSigCode) return null;

  // Step 2: Find the N-sig function name again (we need it for the dependency scan)
  let nSigFuncName = null;
  const lookupArrayRe =
    /(?:var\s+|[;,]\s*)([a-zA-Z0-9$_]+)\s*=\s*"([^"]{200,})"\s*\.\s*split\s*\(\s*"([^"]+)"\s*\)/;
  const lookupMatch = js.match(lookupArrayRe);

  // Try to find the function name from the lookup-based pattern first
  if (lookupMatch) {
    const lookupArray = lookupMatch[2].split(lookupMatch[3]);
    const nIdx = lookupArray.indexOf("n");
    const lookupName = lookupMatch[1];
    if (nIdx !== -1) {
      const wrapperRe = new RegExp(
        "([a-zA-Z0-9$_]+)\\[0\\]\\s*\\(\\s*(\\w+)\\s*\\)",
        "g",
      );
      let wm;
      while ((wm = wrapperRe.exec(js)) !== null) {
        const ctx = js.substring(
          Math.max(0, wm.index - 100),
          Math.min(js.length, wm.index + 200),
        );
        if (
          ctx.indexOf(lookupName + "[" + nIdx + "]") !== -1 ||
          ctx.indexOf('"n"') !== -1
        ) {
          // Found wrapper name, resolve to actual function name
          const wrapperName = wm[1];
          const arrMatch = js.match(
            new RegExp(
              `[,;\\n]\\s*${escRe(wrapperName)}\\s*=\\s*\\[([\\w$,\\s]+)\\]`,
            ),
          );
          if (arrMatch) {
            nSigFuncName = arrMatch[1].split(",")[0].trim();
          } else {
            nSigFuncName = wrapperName;
          }
          break;
        }
      }
    }
  }

  // Fallback: try to find it from the nSigCode by matching function definitions
  if (!nSigFuncName) {
    // The nSigCode string is "function(a){...}" — find which named function matches
    const nPatterns = [
      /\.get\("n"\)\)&&\(b=([a-zA-Z0-9$]+)(?:\[(\d+)\])?\([a-zA-Z0-9]\)/,
      /[=(,&|]([a-zA-Z0-9$]+)\(\w+\),\w+\.set\("n",/,
      /\.set\("n",\s*([a-zA-Z0-9$]+)\(\s*\w+\s*\)/,
    ];
    for (const re of nPatterns) {
      const m = js.match(re);
      if (m) {
        nSigFuncName = m[1];
        // Resolve array wrapper
        if (m[2] != null) {
          const arrMatch = js.match(
            new RegExp(
              `[,;\\n]\\s*${escRe(nSigFuncName)}\\s*=\\s*\\[([\\w$,\\s]+)\\]`,
            ),
          );
          if (arrMatch) {
            const items = arrMatch[1].split(",");
            nSigFuncName = items[parseInt(m[2])]?.trim() || nSigFuncName;
          }
        }
        break;
      }
    }
  }

  if (!nSigFuncName) {
    console.warn("[BG] yt-dlp bundler: Could not identify N-sig function name");
    return nSigCode; // Fall back to unbundled code
  }

  console.log(
    "[BG] yt-dlp bundler: N-sig function is",
    nSigFuncName,
    "— scanning dependencies...",
  );

  // Step 3: Find the N-sig function's definition position and body in player.js
  const funcBodyResult = findFunctionDefinition(js, nSigFuncName);
  if (!funcBodyResult) {
    console.warn(
      "[BG] yt-dlp bundler: Could not locate",
      nSigFuncName,
      "definition in player.js",
    );
    return nSigCode;
  }

  // Step 4: Collect all dependencies recursively
  // Build a set of JS builtins and known names to skip
  const BUILTINS = new Set([
    "undefined",
    "null",
    "true",
    "false",
    "NaN",
    "Infinity",
    "Math",
    "String",
    "Array",
    "Object",
    "Number",
    "Boolean",
    "RegExp",
    "Date",
    "JSON",
    "parseInt",
    "parseFloat",
    "isNaN",
    "isFinite",
    "encodeURIComponent",
    "decodeURIComponent",
    "atob",
    "btoa",
    "console",
    "window",
    "self",
    "globalThis",
    "this",
    "setTimeout",
    "clearTimeout",
    "setInterval",
    "clearInterval",
    "Promise",
    "Error",
    "TypeError",
    "RangeError",
    "SyntaxError",
    "Map",
    "Set",
    "WeakMap",
    "WeakSet",
    "Symbol",
    "Proxy",
    "Reflect",
    "arguments",
    "eval",
    "Function",
    "Uint8Array",
    "Int32Array",
    "Float64Array",
    "ArrayBuffer",
    "DataView",
    "TextEncoder",
    "TextDecoder",
    // JS keywords
    "var",
    "let",
    "const",
    "function",
    "return",
    "if",
    "else",
    "for",
    "while",
    "do",
    "switch",
    "case",
    "break",
    "continue",
    "try",
    "catch",
    "finally",
    "throw",
    "new",
    "delete",
    "typeof",
    "instanceof",
    "in",
    "of",
    "void",
    "with",
    "yield",
    "async",
    "await",
    "class",
    "extends",
    "super",
    "import",
    "export",
    "default",
    "from",
    "as",
  ]);

  const extracted = new Map(); // name → { code, startIdx, endIdx }
  const visited = new Set();
  const extractionOrder = [];

  // Recursive dependency extraction
  function extractDeps(funcName, depth) {
    if (depth > 15) return; // Prevent infinite recursion
    if (visited.has(funcName)) return;
    visited.add(funcName);

    const def = findFunctionDefinition(js, funcName);
    if (!def) {
      // Try to find as a variable/object definition instead
      const varDef = findVarDefinition(js, funcName);
      if (varDef) {
        extracted.set(funcName, varDef);
        extractionOrder.push(funcName);
        // Scan variable value for further dependencies
        scanAndExtractDeps(varDef.code, funcName, depth + 1);
      }
      return;
    }

    extracted.set(funcName, def);
    extractionOrder.push(funcName);

    // Scan function body for references to other functions/variables
    scanAndExtractDeps(def.body, funcName, depth + 1);
  }

  function scanAndExtractDeps(code, parentName, depth) {
    // Find all identifier references that could be IIFE-scoped dependencies
    // Pattern: identifiers used as function calls or property accesses
    const identRe = /\b([a-zA-Z$_][a-zA-Z0-9$_]*)\s*(?:\(|\[|\.\w)/g;
    let im;
    const candidates = new Set();
    while ((im = identRe.exec(code)) !== null) {
      const name = im[1];
      if (BUILTINS.has(name)) continue;
      if (name === parentName) continue; // self-reference
      if (name.length === 1 && /[a-z]/.test(name)) continue; // single lowercase = likely param
      candidates.add(name);
    }

    // Also find plain identifier assignments/references
    const assignRe = /\b([a-zA-Z$_][a-zA-Z0-9$_]{1,})\b/g;
    let am;
    while ((am = assignRe.exec(code)) !== null) {
      const name = am[1];
      if (BUILTINS.has(name)) continue;
      if (name === parentName) continue;
      // Only consider names that appear as function calls or assignments
      if (
        code.includes(name + "(") ||
        code.includes(name + "[") ||
        code.includes(name + ".")
      ) {
        candidates.add(name);
      }
    }

    for (const candidate of candidates) {
      if (!visited.has(candidate)) {
        extractDeps(candidate, depth);
      }
    }
  }

  // Start recursive extraction from the N-sig function
  extractDeps(nSigFuncName, 0);

  if (extracted.size <= 1) {
    // Only the function itself, no deps found — bundle won't help
    console.log(
      "[BG] yt-dlp bundler: No additional dependencies found — using plain extraction",
    );
    return nSigCode;
  }

  // Step 5: Build the bundled self-contained code
  const depDeclarations = [];
  for (const name of extractionOrder) {
    if (name === nSigFuncName) continue; // Main function goes last
    const dep = extracted.get(name);
    if (dep) depDeclarations.push(dep.code);
  }

  // The main N-sig function, wrapped so it can be called standalone
  const mainDef = extracted.get(nSigFuncName);
  const mainFuncCode = mainDef
    ? mainDef.code
    : `var ${nSigFuncName} = ${nSigCode};`;

  // Build the bundle:
  // (function(){
  //   var dep1 = ...;
  //   var dep2 = function(){...};
  //   var nSigFunc = function(a){...};
  //   return nSigFunc;
  // })()
  const bundled =
    "(function(){\n" +
    depDeclarations.join("\n") +
    "\n" +
    mainFuncCode +
    "\n" +
    "return " +
    nSigFuncName +
    ";\n" +
    "})()";

  console.log(
    "[BG] yt-dlp bundler: Bundled N-sig with",
    extracted.size - 1,
    "dependencies (",
    bundled.length,
    "chars)",
  );

  return bundled;
}

// Find a function definition in player.js by name.
// Returns { code, body, startIdx, endIdx } or null.
function findFunctionDefinition(js, name) {
  const esc = escRe(name);
  const patterns = [
    // var X = function(a) {
    new RegExp(
      `(?:var|let|const)\\s+${esc}\\s*=\\s*function\\s*\\(([^)]*)\\)\\s*\\{`,
      "g",
    ),
    // X = function(a) {
    new RegExp(
      `(?:^|[;,\\n])\\s*${esc}\\s*=\\s*function\\s*\\(([^)]*)\\)\\s*\\{`,
      "gm",
    ),
    // function X(a) {
    new RegExp(`function\\s+${esc}\\s*\\(([^)]*)\\)\\s*\\{`, "g"),
    // var X = (a) => {
    new RegExp(
      `(?:var|let|const)\\s+${esc}\\s*=\\s*\\(([^)]*)\\)\\s*=>\\s*\\{`,
      "g",
    ),
    // X = (a) => {
    new RegExp(
      `(?:^|[;,\\n])\\s*${esc}\\s*=\\s*\\(([^)]*)\\)\\s*=>\\s*\\{`,
      "gm",
    ),
    // var X = a => {
    new RegExp(
      `(?:var|let|const)\\s+${esc}\\s*=\\s*([a-zA-Z_$]\\w*)\\s*=>\\s*\\{`,
      "g",
    ),
    // X = a => {
    new RegExp(
      `(?:^|[;,\\n])\\s*${esc}\\s*=\\s*([a-zA-Z_$]\\w*)\\s*=>\\s*\\{`,
      "gm",
    ),
  ];

  for (const re of patterns) {
    let m;
    while ((m = re.exec(js)) !== null) {
      const braceIdx = m.index + m[0].lastIndexOf("{");
      const body = extractBraceBlock(js, braceIdx);
      if (!body) continue;
      // Skip very tiny matches (likely false positives)
      if (body.length < 10) continue;

      const params = m[1];
      const fullCode = `var ${name} = function(${params})${body};`;
      return {
        code: fullCode,
        body,
        params,
        startIdx: m.index,
        endIdx: braceIdx + body.length,
      };
    }
  }
  return null;
}

// Find a variable/constant/object definition in player.js by name.
// Returns { code } or null.
function findVarDefinition(js, name) {
  const esc = escRe(name);

  // Pattern 1: Object literal — var X = { ... }
  const objRe = new RegExp(
    `(?:var|let|const|[;,\\n])\\s*${esc}\\s*=\\s*\\{`,
    "gm",
  );
  let m = objRe.exec(js);
  if (m) {
    const braceIdx = m.index + m[0].lastIndexOf("{");
    const block = extractBraceBlock(js, braceIdx);
    if (block && block.length > 2) {
      return { code: `var ${name} = ${block};` };
    }
  }

  // Pattern 2: Array literal — var X = [ ... ]
  const arrRe = new RegExp(
    `(?:var|let|const|[;,\\n])\\s*${esc}\\s*=\\s*\\[`,
    "gm",
  );
  m = arrRe.exec(js);
  if (m) {
    const bracketIdx = m.index + m[0].lastIndexOf("[");
    // Extract bracket block (similar to brace block but for [])
    const block = extractBracketBlock(js, bracketIdx);
    if (block) {
      return { code: `var ${name} = ${block};` };
    }
  }

  // Pattern 3: Simple value — var X = EXPR;
  const valRe = new RegExp(
    `(?:var|let|const)\\s+${esc}\\s*=\\s*([^;{\\n]+);`,
    "gm",
  );
  m = valRe.exec(js);
  if (m) {
    const value = m[1].trim();
    // Skip if value is too long (likely a false match)
    if (value.length < 500) {
      return { code: `var ${name} = ${value};` };
    }
  }

  // Pattern 4: Comma-separated in var statement — var ..., X = EXPR, ...
  const commaRe = new RegExp(`[,]\\s*${esc}\\s*=\\s*([^,;{\\n]+)[,;]`, "gm");
  m = commaRe.exec(js);
  if (m) {
    const value = m[1].trim();
    if (value.length < 500) {
      return { code: `var ${name} = ${value};` };
    }
  }

  return null;
}

// Extract a balanced bracket block [...] from code starting at pos
function extractBracketBlock(code, pos) {
  if (code[pos] !== "[") return null;
  let d = 0,
    inStr = false,
    sc = "",
    esc = false;
  for (let i = pos; i < code.length && i < pos + 100000; i++) {
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
    if (c === "[") d++;
    if (c === "]") {
      d--;
      if (d === 0) return code.substring(pos, i + 1);
    }
  }
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
  const resumeTabId = findTabIdForVideoId(videoId);
  const info = await getFormats(videoId, {}, resumeTabId);
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
    videoTitle: mergeState.videoTitle || null,
    videoThumbnail: mergeState.videoThumbnail || null,
    isResume: true,
  });

  return result;
}

async function doMergedDownload(msg) {
  const {
    videoUrl,
    audioUrl,
    filename,
    videoItag,
    audioItag,
    videoId,
    videoTitle,
    videoThumbnail,
    isRetry403,
  } = msg;

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
        // Store video metadata for persistent display
        videoTitle: videoTitle || null,
        videoThumbnail: videoThumbnail || null,
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
            if (
              videoId &&
              videoItag &&
              audioItag &&
              !msg.isResume &&
              !msg.isRetry403
            ) {
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

    // ===============================================================
    // 403 Fallback — re-fetch fresh URLs with full tier cascade
    // (N-sig transform, yt-dlp bundled, sniffed IDM-style URLs)
    // ===============================================================
    if (
      !result.success &&
      result.error &&
      result.error.includes("403") &&
      videoId &&
      videoItag &&
      audioItag &&
      !msg.isRetry403
    ) {
      console.log(
        "[BG] ★ Download got 403 — retrying with fresh URLs",
        "(N-sig + sniffed fallback)...",
      );

      // Clean up for retry
      await removeMergeHeaders(mergeRuleIds);
      activeMergeId = null;
      stopMergeKeepalive();

      try {
        // Re-resolve formats through the full tier cascade:
        //   Tier 1 (InnerTube API) → Tier 2 (page scrape + AST) → Tier S (sniffed) → Tier 3 (inject.js regex)
        // Each tier applies N-sig transform (plain → yt-dlp bundled fallback)
        // and enriches with sniffed googlevideo.com URLs when available.
        const resumeTabId = findTabIdForVideoId(videoId);
        const info = await getFormats(videoId, {}, resumeTabId);

        if (!info?.formats?.length) {
          throw new Error("No formats available on retry");
        }

        // Try the same itags first
        let vFmt = info.formats.find(
          (f) => String(f.itag) === String(videoItag),
        );
        let aFmt = info.formats.find(
          (f) => String(f.itag) === String(audioItag),
        );

        // If exact itags unavailable, pick the best available alternatives
        if (!vFmt?.url) {
          vFmt = info.formats
            .filter((f) => f.isVideo && !f.isMuxed && f.url)
            .sort((a, b) => (b.height || 0) - (a.height || 0))[0];
          if (vFmt) {
            console.log(
              "[BG] 403 retry: original video itag not found, using itag",
              vFmt.itag,
              vFmt.qualityLabel || vFmt.quality,
            );
          }
        }
        if (!aFmt?.url) {
          aFmt = info.formats
            .filter((f) => f.isAudio && f.url)
            .sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0))[0];
          if (aFmt) {
            console.log(
              "[BG] 403 retry: original audio itag not found, using itag",
              aFmt.itag,
            );
          }
        }

        if (!vFmt?.url || !aFmt?.url) {
          throw new Error("Could not find working video+audio URLs on retry");
        }

        console.log(
          "[BG] 403 retry: got fresh URLs — video itag",
          vFmt.itag,
          "audio itag",
          aFmt.itag,
          "client:",
          vFmt.clientUsed || "unknown",
        );

        const retryResult = await doMergedDownload({
          videoUrl: vFmt.url,
          audioUrl: aFmt.url,
          filename,
          videoItag: vFmt.itag,
          audioItag: aFmt.itag,
          videoId,
          videoTitle,
          videoThumbnail,
          isRetry403: true, // Prevent infinite retry loop
        });
        return retryResult;
      } catch (retryErr) {
        console.error("[BG] 403 retry failed:", retryErr.message);
        chrome.storage.session
          .set({
            activeMerge: {
              mergeId,
              filename,
              videoId,
              videoItag,
              audioItag,
              status: "failed",
              error: "403 retry failed: " + retryErr.message,
              phase: "error",
              percent: 0,
            },
          })
          .catch(() => {});
        return {
          success: false,
          error: "403 retry failed: " + retryErr.message,
        };
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
  "[BG] YouTube Downloader service worker ready (4-tier architecture: API → AST → Sniffed → Regex)",
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

    // Skip tabs where a specialist extractor is already injected
    if (injectedTabs.has(details.tabId)) return;

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

    // Known proxy/CDN domains used by streaming sites
    const PROXY_STREAM_DOMAINS = [
      "vodvidl.site",
      "rabbitstream",
      "megacloud",
      "vidplay",
      "filemoon",
      "dokicloud",
      "rapid-cloud",
      "vidstreaming",
      "trueparadise.workers.dev",
      "tigerflare",
      "videasy.net",
    ];
    const isProxyDomain = PROXY_STREAM_DOMAINS.some((d) =>
      details.url.includes(d),
    );

    if (
      baseType === "application/vnd.apple.mpegurl" ||
      baseType === "application/x-mpegurl" ||
      baseType === "video/m3u8" ||
      details.url.match(/\.m3u8(\?|#|$)/i) ||
      (details.url.match(/m3u8/i) && isProxyDomain) ||
      (isProxyDomain &&
        /proxy|stream|video|manifest|playlist|master|hls/i.test(details.url))
    ) {
      streamType = "hls";
    } else if (
      baseType === "application/dash+xml" ||
      details.url.match(/\.mpd(\?|#|$)/i) ||
      (isProxyDomain && /dash|\.mpd/i.test(details.url))
    ) {
      streamType = "dash";
    } else if (
      isProxyDomain &&
      (baseType === "text/plain" ||
        baseType === "application/octet-stream" ||
        baseType === "binary/octet-stream" ||
        baseType === "application/binary")
    ) {
      // Proxy CDNs may serve HLS manifests with non-standard content types
      streamType = "hls";
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

    // Auto-merge HLS/DASH streams into specialist tabData when present
    if (
      (streamType === "hls" || streamType === "dash") &&
      (tabData.has(details.tabId) || injectedTabs.has(details.tabId))
    ) {
      mergeSniffedStreamIntoTabData(details.tabId, stream);
    }
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"],
);

// Helper: returns true when an origin string belongs to any YouTube domain
// (www.youtube.com, m.youtube.com, music.youtube.com, youtu.be, etc.).
function isYouTubeOrigin(origin) {
  if (!origin) return false;
  try {
    const host = new URL(origin).hostname;
    return (
      host === "youtu.be" ||
      host.endsWith(".youtube.com") ||
      host === "youtube.com"
    );
  } catch {
    return false;
  }
}

// ============ YouTube URL Sniffing (IDM-style) ============
// Captures fully-decrypted googlevideo.com/videoplayback URLs that YouTube's
// player.js generates. These URLs already have cipher & N-sig applied, so we
// bypass the fragile extraction logic entirely when cipher/N-sig breaks.
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (!details.url.includes("/videoplayback")) return;

    try {
      const url = new URL(details.url);
      const itag = parseInt(url.searchParams.get("itag"));
      if (!itag) return;

      // Capture for YouTube tabs.  Check tabData first (fast), then fall back
      // to the request's initiator origin so we capture URLs even before the
      // content script has fired VIDEO_DETECTED (the player starts fetching
      // media segments very early in the page lifecycle).
      if (!isYouTubeTab(details.tabId) && !isYouTubeOrigin(details.initiator))
        return;

      const mime = decodeURIComponent(url.searchParams.get("mime") || "");
      const clen = parseInt(url.searchParams.get("clen")) || 0;
      const dur = parseFloat(url.searchParams.get("dur")) || 0;
      const expire = parseInt(url.searchParams.get("expire")) || 0;

      // Build a clean full-file URL (strip range= so we can download the whole thing)
      const cleanUrl = new URL(details.url);
      cleanUrl.searchParams.delete("range");
      if (!cleanUrl.searchParams.has("ratebypass")) {
        cleanUrl.searchParams.set("ratebypass", "yes");
      }

      if (!sniffedYouTubeUrls.has(details.tabId)) {
        sniffedYouTubeUrls.set(details.tabId, new Map());
      }

      const tabSniffed = sniffedYouTubeUrls.get(details.tabId);
      tabSniffed.set(itag, {
        url: cleanUrl.toString(),
        mime,
        clen,
        dur,
        expire,
        ts: Date.now(),
      });

      console.log(
        `[YT-SNIFF] Captured itag ${itag} (${mime}) on tab ${details.tabId}`,
        `— ${tabSniffed.size} URLs total`,
      );
    } catch {
      // ignore parse errors
    }
  },
  { urls: ["*://*.googlevideo.com/*"] },
);

// Build format objects from sniffed YouTube URLs using ITAG_MAP metadata.
// Returns an array of format objects compatible with the existing format pipeline.
function buildSniffedFormats(tabId) {
  const tabSniffed = sniffedYouTubeUrls.get(tabId);
  if (!tabSniffed || tabSniffed.size === 0) return [];

  const formats = [];
  const now = Math.floor(Date.now() / 1000);

  for (const [itag, data] of tabSniffed) {
    // Skip expired URLs
    if (data.expire && data.expire < now) continue;

    const lk = ITAG_MAP[itag];

    // Reconstruct MIME type
    let mimeType = data.mime || "";
    if (!mimeType && lk) {
      mimeType = (lk.V ? "video/" : "audio/") + lk.ct;
    }
    const codecs = lk ? [lk.vc, lk.ac].filter(Boolean).join(", ") : "";
    if (codecs && !mimeType.includes("codecs")) {
      mimeType += `; codecs="${codecs}"`;
    }

    const isVideo = lk ? !!lk.V : mimeType.startsWith("video/");
    const isAudio = lk ? !!lk.A : mimeType.startsWith("audio/");

    formats.push({
      itag,
      url: data.url,
      mimeType,
      quality: lk?.quality || `itag-${itag}`,
      qualityLabel: lk?.quality || "",
      width: lk?.w || 0,
      height: lk?.h || 0,
      fps: lk?.fps || 0,
      bitrate: lk?.abr || 0,
      audioBitrate: lk?.abr || 0,
      audioQuality: isAudio ? "AUDIO_QUALITY_MEDIUM" : "",
      contentLength: data.clen || null,
      codecs,
      isVideo,
      isAudio,
      isMuxed: lk ? !!lk.M : false,
      clientUsed: "sniffed",
    });
  }

  return formats;
}

// Replace format URLs with sniffed ones where itag matches.
// This fixes formats that have correct metadata but broken URLs
// (e.g. cipher worked but N-sig failed, leaving throttled n= values).
function enrichFormatsWithSniffed(formats, tabId) {
  const tabSniffed = sniffedYouTubeUrls.get(tabId);
  if (!tabSniffed || tabSniffed.size === 0) return 0;

  const now = Math.floor(Date.now() / 1000);
  let replaced = 0;

  for (const fmt of formats) {
    const sniffed = tabSniffed.get(fmt.itag);
    if (!sniffed) continue;
    if (sniffed.expire && sniffed.expire < now) continue;

    // Replace URL with sniffed version (already has correct cipher + N-sig)
    fmt.url = sniffed.url;
    if (sniffed.clen && !fmt.contentLength) {
      fmt.contentLength = sniffed.clen;
    }
    replaced++;
  }

  return replaced;
}

// Helper: find tabId for a given videoId (for callers that don't have tabId)
function findTabIdForVideoId(videoId) {
  for (const [tabId, data] of tabData) {
    if (data.videoId === videoId) return tabId;
  }
  return null;
}

chrome.tabs.onRemoved.addListener((tabId) => {
  sniffedStreams.delete(tabId);
  sniffedYouTubeUrls.delete(tabId);
  contentHashes.delete(tabId);
});

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId === 0 && details.tabId >= 0) {
    sniffedStreams.delete(details.tabId);
    sniffedYouTubeUrls.delete(details.tabId);
    contentHashes.delete(details.tabId);
  }
});

// Import site-to-specialist mapping (single source of truth)
// Firefox MV3 loads this via the manifest's background.scripts array;
// Chrome MV3 only loads the service_worker entry, so we importScripts here.
if (typeof SITE_EXTRACTOR_MAP === "undefined") {
  importScripts("extractors/site-map.js");
}

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
      injectImmediately: true,
    });
    injectedTabs.set(tabId, scriptFile);
    console.log(`[BG] Specialist injected: ${scriptFile} → tab ${tabId}`);

    // Also inject network hooks into ALL frames (including cross-origin iframes)
    // so we can catch m3u8/mpd requests from embed players like videasy.net
    injectIframeHooks(tabId).catch(() => {});
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

/**
 * Inject network hooks + relay into ALL frames of a tab.
 * The MAIN-world hook intercepts XHR/fetch for m3u8/mpd URLs.
 * The ISOLATED-world relay forwards detected URLs to background.js.
 */
async function injectIframeHooks(tabId, frameId) {
  const target =
    frameId != null
      ? { tabId, frameIds: [frameId] }
      : { tabId, allFrames: true };
  try {
    // 1. Inject the generic network hook (MAIN world)
    await chrome.scripting.executeScript({
      target,
      files: ["hooks/generic-network-hook.js"],
      world: "MAIN",
      injectImmediately: false,
    });

    // 2. Inject a relay script (ISOLATED world)
    //    Listens for postMessages from the MAIN-world hook and sends to background
    await chrome.scripting.executeScript({
      target,
      world: "ISOLATED",
      func: function iframeStreamRelay() {
        if (window.__iframeStreamRelayLoaded) return;
        window.__iframeStreamRelayLoaded = true;

        window.addEventListener("message", (event) => {
          if (!event.data || event.source !== window) return;

          // Relay generic network hook detections
          if (event.data.type === "__generic_extractor__" && event.data.url) {
            try {
              chrome.runtime.sendMessage({
                action: "IFRAME_STREAM_DETECTED",
                url: event.data.url,
                direct: event.data.direct || false,
                mseDetected: event.data.mseDetected || false,
                hlsContent: event.data.hlsContent || false,
                proxyDetected: event.data.proxyDetected || false,
                blobUrl: event.data.blobUrl || null,
                frameUrl: window.location.href,
              });
            } catch {}
          }

          // Relay video duration from iframe hook
          if (
            event.data.type === "__generic_extractor_duration__" &&
            event.data.duration
          ) {
            try {
              chrome.runtime.sendMessage({
                action: "IFRAME_DURATION_DETECTED",
                duration: event.data.duration,
                frameUrl: event.data.frameUrl || window.location.href,
              });
            } catch {}
          }

          // Also relay MAGIC_M3U8_DETECTION from iframes
          if (
            event.data.type === "MAGIC_M3U8_DETECTION" &&
            event.data.source === "SITE_SPECIALIST"
          ) {
            try {
              chrome.runtime.sendMessage({
                action: "SPECIALIST_DETECTED",
                protocol: "MAGIC_M3U8",
                payload: event.data.data,
                pageUrl: window.location.href,
              });
            } catch {}
          }
        });
      },
    });

    console.log(
      `[BG] Iframe hooks injected into ${
        frameId != null ? `frame ${frameId} of` : "all frames of"
      } tab ${tabId}`,
    );
  } catch (e) {
    if (
      !e.message?.includes("Cannot access") &&
      !e.message?.includes("No tab")
    ) {
      console.debug(`[BG] Iframe hook injection note:`, e.message);
    }
  }
}

// Re-inject iframe hooks when new sub-frames load on specialist tabs
chrome.webNavigation.onCompleted.addListener((details) => {
  if (details.frameId === 0) return; // only sub-frames
  if (!injectedTabs.has(details.tabId)) return; // only specialist tabs
  // Inject only into the specific sub-frame that just navigated
  injectIframeHooks(details.tabId, details.frameId).catch(() => {});
});

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

// Inject specialist as early as possible (onCommitted fires before document_idle
// when the generic content scripts would run).  We also keep onCompleted as a
// fallback for sites whose specialist relies on a fully-loaded DOM.
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;

  try {
    const url = new URL(details.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    if (isDedicatedSite(url.hostname)) return;

    const scriptFile = findSpecialistForHost(url.hostname);
    if (scriptFile) {
      // No delay — inject immediately so it beats the generic content scripts
      injectSpecialist(details.tabId, scriptFile);
    }
  } catch (e) {}
});

chrome.webNavigation.onCompleted.addListener((details) => {
  if (details.frameId !== 0) return;

  try {
    const url = new URL(details.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    if (isDedicatedSite(url.hostname)) return;

    const scriptFile = findSpecialistForHost(url.hostname);
    if (scriptFile) {
      // Fallback: re-inject if onCommitted injection was too early or failed
      injectSpecialist(details.tabId, scriptFile);
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
        injectSpecialist(details.tabId, scriptFile);
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
    duration = opts.duration || d.duration || null;

    if (!videoUrl) return { success: false, error: "No video URL" };

    // Specialists can provide required HTTP headers (e.g. Referer for CDNs)
    const specialistHeaders = opts.headers || null;

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
            isHLS: f.isHLS === true,
            isDASH: f.isDASH === true,
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
    lengthSeconds: duration,
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
      if (!info.lengthSeconds && meta.duration) {
        info.lengthSeconds = meta.duration;
        changed = true;
      }
      if (changed) {
        tabData.set(tabId, { videoId, info, ts: Date.now() });
        persistTabData();
        console.log("[BG] Enriched specialist video with page metadata");
      }
    });
  }

  // Store specialist headers on each format so popup can pass them to the worker
  if (specialistHeaders) {
    for (const f of formats) {
      f.headers = specialistHeaders;
    }
  }

  // Set up DNR rules for the stream CDN BEFORE fetching the master playlist
  let specialistRuleId = null;
  if (specialistHeaders && Object.keys(specialistHeaders).length > 0) {
    try {
      const streamHost = new URL(formats[0]?.url || videoUrl).hostname;
      specialistRuleId = await addSessionHeaders(
        "||" + streamHost + "/",
        specialistHeaders,
      );
      console.log(
        "[BG] Added specialist CDN headers for",
        streamHost,
        "ruleId:",
        specialistRuleId,
      );
    } catch (e) {
      console.warn("[BG] Failed to add specialist CDN headers:", e.message);
    }
  }

  // For HLS formats, try to parse the master playlist to extract quality variants
  const hlsFormats = formats.filter((f) => f.isHLS && f.url);
  if (hlsFormats.length > 0) {
    for (const hlsFmt of hlsFormats) {
      try {
        const variants = await parseHLSMasterPlaylist(
          hlsFmt.url,
          specialistHeaders,
        );
        if (variants && variants.length > 1) {
          console.log(`[BG] Parsed ${variants.length} HLS quality variants`);
          // Remove the original "auto" HLS entry and replace with variants
          const hlsIdx = formats.indexOf(hlsFmt);
          if (hlsIdx >= 0) formats.splice(hlsIdx, 1);

          // Add auto/best quality entry first
          formats.unshift({
            url: hlsFmt.url,
            mimeType: hlsFmt.mimeType,
            quality: "auto",
            qualityLabel: "Auto (Best)",
            isVideo: true,
            isMuxed: true,
            ext: "mp4",
            isHLS: true,
            itag: syntheticItag++,
            headers: specialistHeaders || undefined,
          });

          // Add each variant as a separate format
          for (const v of variants) {
            formats.push({
              url: v.url,
              mimeType: "application/x-mpegurl",
              quality: v.quality,
              qualityLabel: v.qualityLabel,
              width: v.width || 0,
              height: v.height || 0,
              bitrate: v.bandwidth || 0,
              isVideo: true,
              isMuxed: true,
              ext: "mp4",
              isHLS: true,
              itag: syntheticItag++,
              headers: specialistHeaders || undefined,
            });
          }
        }
      } catch (e) {
        console.warn("[BG] Failed to parse HLS master playlist:", e.message);
      }
    }
    // Re-store with updated formats
    info.formats = formats;
    tabData.set(tabId, { videoId, info, ts: Date.now() });
    persistTabData();
  }

  console.log(
    `[BG] Specialist stored ${formats.length} format(s) for tab ${tabId} (${platform})`,
  );
  return { success: true, info };
}

/**
 * Fetch and parse an HLS master playlist to extract quality variant streams.
 * Returns an array of { url, quality, qualityLabel, width, height, bandwidth } or null.
 */
async function parseHLSMasterPlaylist(masterUrl, headers) {
  try {
    let resp;
    if (headers && Object.keys(headers).length > 0) {
      // Use DNR-backed fetch so forbidden headers (Referer, Origin) are
      // applied at the network level — plain fetch() silently drops them.
      resp = await fetchWithDNRHeaders(masterUrl, headers, {
        cache: "no-cache",
      });
    } else {
      resp = await fetch(masterUrl, { cache: "no-cache" });
    }
    if (!resp.ok) return null;
    const text = await resp.text();

    // Check if this is a master playlist (contains #EXT-X-STREAM-INF)
    if (!text.includes("#EXT-X-STREAM-INF")) return null;

    const lines = text.split("\n").map((l) => l.trim());
    const variants = [];
    const baseUrl = masterUrl.substring(0, masterUrl.lastIndexOf("/") + 1);
    // Preserve query parameters from master URL for relative variant URLs
    let masterQuery = "";
    try {
      const parsed = new URL(masterUrl);
      masterQuery = parsed.search || "";
    } catch {}

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.startsWith("#EXT-X-STREAM-INF:")) continue;

      // Parse attributes from the STREAM-INF line
      const attrs = line.substring("#EXT-X-STREAM-INF:".length);
      let bandwidth = 0;
      let width = 0;
      let height = 0;
      let resolution = "";
      let codecs = "";
      let name = "";

      const bwMatch = attrs.match(/BANDWIDTH=(\d+)/i);
      if (bwMatch) bandwidth = parseInt(bwMatch[1]);

      const resMatch = attrs.match(/RESOLUTION=(\d+)x(\d+)/i);
      if (resMatch) {
        width = parseInt(resMatch[1]);
        height = parseInt(resMatch[2]);
        resolution = `${width}x${height}`;
      }

      const codecMatch = attrs.match(/CODECS="([^"]+)"/i);
      if (codecMatch) codecs = codecMatch[1];

      const nameMatch = attrs.match(/NAME="([^"]+)"/i);
      if (nameMatch) name = nameMatch[1];

      // Next non-empty, non-comment line is the variant URL
      let variantUrl = "";
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j] && !lines[j].startsWith("#")) {
          variantUrl = lines[j];
          break;
        }
      }

      if (!variantUrl) continue;

      // Resolve the variant URL
      if (!variantUrl.startsWith("http")) {
        // Relative URL — resolve against master playlist base
        variantUrl = baseUrl + variantUrl;
        // Add master query params if the variant doesn't have its own
        if (masterQuery && !variantUrl.includes("?")) {
          variantUrl += masterQuery;
        }
      }

      const qualityLabel = height
        ? `${height}p`
        : name || `${Math.round(bandwidth / 1000)}kbps`;
      const quality = height
        ? `${height}p`
        : `${Math.round(bandwidth / 1000)}kbps`;

      variants.push({
        url: variantUrl,
        quality,
        qualityLabel: `${qualityLabel}${codecs ? " · " + (codecs.includes("avc1") ? "H.264" : codecs.includes("hevc") || codecs.includes("hvc1") ? "HEVC" : codecs.split(",")[0]) : ""}${bandwidth ? " · " + Math.round(bandwidth / 1000) + "kbps" : ""}`,
        width,
        height,
        bandwidth,
        codecs,
      });
    }

    // Sort by height descending (highest quality first)
    variants.sort(
      (a, b) => (b.height || b.bandwidth) - (a.height || a.bandwidth),
    );
    return variants.length > 0 ? variants : null;
  } catch (e) {
    console.warn("[BG] HLS master playlist parse error:", e.message);
    return null;
  }
}

/**
 * For proxy CDN URLs, try to discover quality variants:
 * 1. Probe the URL to see if it's actually an HLS master playlist
 * 2. Look for base64-encoded resolution path segments and synthesize variants
 * 3. Verify variant URLs with HEAD requests
 */
async function probeAndSynthesizeQualityVariants(
  url,
  info,
  existing,
  tabId,
  startItag,
) {
  let syntheticItag = startItag || 91000;

  // ── Step 1: Probe the URL for HLS content ──
  try {
    const probeResp = await fetch(url, {
      method: "GET",
      headers: { Range: "bytes=0-8192" },
    });
    if (probeResp.ok) {
      const probeText = await probeResp.text();
      const trimmed = probeText.trimStart();
      if (
        trimmed.startsWith("#EXTM3U") &&
        trimmed.includes("#EXT-X-STREAM-INF")
      ) {
        // It's a master playlist! Parse variants using existing function
        const variants = await parseHLSMasterPlaylist(url);
        if (variants && variants.length > 1) {
          console.log(
            `[BG] Proxy URL is HLS master: ${variants.length} quality variants`,
          );
          const updatedFormats = info.formats.filter(
            (f) => f.url !== url || f.quality !== "auto",
          );
          updatedFormats.unshift({
            url,
            mimeType: "application/x-mpegurl",
            quality: "auto",
            qualityLabel: "Auto (Best)",
            isVideo: true,
            isMuxed: true,
            ext: "mp4",
            isHLS: true,
            itag: syntheticItag++,
          });
          for (const v of variants) {
            updatedFormats.push({
              url: v.url,
              mimeType: "application/x-mpegurl",
              quality: v.quality,
              qualityLabel: v.qualityLabel,
              width: v.width || 0,
              height: v.height || 0,
              bitrate: v.bandwidth || 0,
              isVideo: true,
              isMuxed: true,
              ext: "mp4",
              isHLS: true,
              itag: syntheticItag++,
            });
          }
          info.formats = updatedFormats;
          tabData.set(tabId, {
            videoId: existing.videoId,
            info,
            ts: Date.now(),
          });
          persistTabData();
          console.log(
            `[BG] Expanded to ${info.formats.length} formats via HLS probe`,
          );
          return; // done, no need for further synthesis
        }
      }
    }
  } catch (e) {
    console.log("[BG] Proxy URL probe failed:", e.message);
  }

  // ── Step 2: Base64-encoded resolution pattern synthesis ──
  // Many pirate CDN workers encode the resolution in a base64 path segment.
  // e.g. /MTA4MA==/ = base64("1080"), /NzIw/ = base64("720"), etc.
  const QUALITY_VARIANTS = [
    { b64: "MTA4MA==", height: 1080, label: "1080p" },
    { b64: "NzIw", height: 720, label: "720p" },
    { b64: "NDgw", height: 480, label: "480p" },
    { b64: "MzYw", height: 360, label: "360p" },
    { b64: "MjQw", height: 240, label: "240p" },
    { b64: "MTQ0MA==", height: 1440, label: "1440p" },
    { b64: "MjE2MA==", height: 2160, label: "4K" },
  ];

  // URL-safe base64 variants (= replaced with nothing or -)
  const QUALITY_VARIANTS_URLSAFE = QUALITY_VARIANTS.map((v) => ({
    ...v,
    b64safe: v.b64.replace(/=/g, ""),
  }));

  // Find which quality is in the current URL
  let foundVariant = null;
  let foundSegment = null; // the raw path segment containing the base64

  try {
    const urlObj = new URL(url);
    const pathSegments = urlObj.pathname.split("/");
    for (const seg of pathSegments) {
      if (!seg) continue;
      const decoded = seg.replace(/-/g, "+").replace(/_/g, "/");
      for (const qv of QUALITY_VARIANTS_URLSAFE) {
        if (seg === qv.b64 || seg === qv.b64safe || decoded === qv.b64) {
          foundVariant = qv;
          foundSegment = seg;
          break;
        }
      }
      if (foundVariant) break;

      // Also try direct atob decode to check for numeric resolution
      try {
        const raw = atob(decoded + "=".repeat((4 - (decoded.length % 4)) % 4));
        const num = parseInt(raw, 10);
        if (num > 0 && [240, 360, 480, 720, 1080, 1440, 2160].includes(num)) {
          foundVariant = QUALITY_VARIANTS.find((v) => v.height === num) || {
            b64: seg,
            height: num,
            label: num + "p",
          };
          foundSegment = seg;
          break;
        }
      } catch {}
    }
  } catch {}

  if (!foundVariant || !foundSegment) {
    console.log("[BG] No base64 quality pattern found in proxy URL");
    return;
  }

  console.log(
    `[BG] Found base64 quality in URL: ${foundVariant.label} (segment: ${foundSegment})`,
  );

  // Generate variant URLs by replacing the detected segment
  const variantResults = [];
  const candidateVariants = QUALITY_VARIANTS_URLSAFE.filter(
    (v) => v.height !== foundVariant.height,
  );

  // Determine the encoding style used (padded vs unpadded)
  const usePadded = foundSegment.includes("=");

  for (const cv of candidateVariants) {
    const replaceSeg = usePadded ? cv.b64 : cv.b64safe;
    const variantUrl = url.replace(foundSegment, replaceSeg);
    if (variantUrl === url) continue;

    // Verify variant exists with a HEAD request (fast, no body download)
    try {
      const headResp = await fetch(variantUrl, { method: "HEAD" });
      if (headResp.ok || headResp.status === 206) {
        variantResults.push({
          url: variantUrl,
          height: cv.height,
          label: cv.label,
        });
        console.log(`[BG] Verified quality variant: ${cv.label}`);
      }
    } catch {
      // skip unavailable variant
    }
  }

  if (variantResults.length === 0) {
    console.log("[BG] No additional quality variants verified");
    return;
  }

  // Add verified variants to formats
  // Replace the single "auto" format with quality-specific formats
  const nonAutoFormats = info.formats.filter(
    (f) => f.url !== url && f.quality !== "auto",
  );

  // Add auto (best) entry pointing to the original URL
  const updatedFormats = [
    {
      url,
      mimeType: "video/mp4",
      quality: "auto",
      qualityLabel: `Auto (${foundVariant.label})`,
      isVideo: true,
      isMuxed: true,
      ext: "mp4",
      isHLS: false,
      itag: syntheticItag++,
    },
  ];

  // Add the detected quality as explicit entry
  updatedFormats.push({
    url,
    mimeType: "video/mp4",
    quality: foundVariant.label,
    qualityLabel: foundVariant.label,
    width: Math.round((foundVariant.height * 16) / 9),
    height: foundVariant.height,
    isVideo: true,
    isMuxed: true,
    ext: "mp4",
    isHLS: false,
    itag: syntheticItag++,
  });

  // Add verified variants
  for (const vr of variantResults) {
    updatedFormats.push({
      url: vr.url,
      mimeType: "video/mp4",
      quality: vr.label,
      qualityLabel: vr.label,
      width: Math.round((vr.height * 16) / 9),
      height: vr.height,
      isVideo: true,
      isMuxed: true,
      ext: "mp4",
      isHLS: false,
      itag: syntheticItag++,
    });
  }

  // Sort by height descending
  updatedFormats.sort((a, b) => {
    if (a.quality === "auto") return -1;
    if (b.quality === "auto") return 1;
    return (b.height || 0) - (a.height || 0);
  });

  // Keep non-auto formats from before (e.g. any other detected streams)
  info.formats = [...updatedFormats, ...nonAutoFormats];
  tabData.set(tabId, { videoId: existing.videoId, info, ts: Date.now() });
  persistTabData();

  console.log(
    `[BG] Synthesized ${variantResults.length + 1} quality variants (total ${info.formats.length} formats)`,
  );
}

/**
 * Handle video stream detected from an iframe relay.
 * Merges the found stream into the specialist's tabData if available.
 */
async function onIframeStreamDetected(msg, tabId) {
  if (!tabId || tabId < 0) return { success: false };

  const url = msg.url;
  if (!url || typeof url !== "string") return { success: false };

  const isM3u8 = /\.m3u8(\?|#|$)/i.test(url) || /m3u8/i.test(url);
  const isMpd = /\.mpd(\?|#|$)/i.test(url);
  const isDirect = msg.direct || false;
  const isHlsContent = msg.hlsContent || false;
  const isProxyDetected = msg.proxyDetected || false;

  // Accept if URL pattern matches, or if response body confirmed HLS, or if proxy domain detected
  if (!isM3u8 && !isMpd && !isDirect && !isHlsContent && !isProxyDetected)
    return { success: false };

  console.log(
    `[BG] Iframe stream detected on tab ${tabId} from ${msg.frameUrl || "unknown"}: ${url.substring(0, 120)}`,
  );

  // Treat hlsContent and proxyDetected as HLS
  const streamType =
    isM3u8 || isHlsContent || isProxyDetected
      ? "hls"
      : isMpd
        ? "dash"
        : "direct";

  // Try to merge into existing specialist tabData
  const existing = tabData.get(tabId);
  if (existing) {
    const info = existing.info;
    const formats = info.formats || [];

    // Check if this URL is already stored
    const normalizedUrl = url.split("?")[0];
    const alreadyExists = formats.some(
      (f) => f.url && f.url.split("?")[0] === normalizedUrl,
    );
    if (alreadyExists) return { success: true, alreadyKnown: true };

    // Remove image-only formats (from generic extractor) if we found a real video
    const videoFormats = formats.filter(
      (f) => f.isVideo !== false && !f.isImage,
    );
    const imageFormats = formats.filter((f) => f.isImage);

    // Filter out EMBED-type formats (iframe page URLs, not actual video streams)
    // when we now have a real stream URL from the iframe hook
    const realVideoFormats = videoFormats.filter((f) => {
      if (!f.url) return true;
      // Remove formats that are embed page URLs (not actual streams)
      if (
        f.qualityLabel === "EMBED" ||
        f.quality === "EMBED" ||
        /\/embed\//i.test(f.url)
      ) {
        try {
          const fHost = new URL(f.url).hostname;
          const EMBED_HOSTS = [
            "vidsrc.cc",
            "vidsrc.me",
            "vidsrc.to",
            "vidsrc.in",
            "vidsrc.net",
            "vidsrc.xyz",
            "2embed.cc",
            "autoembed.cc",
            "multiembed.mov",
            "embed.su",
            "superembed.stream",
          ];
          if (EMBED_HOSTS.some((h) => fHost === h || fHost.endsWith("." + h))) {
            console.log(
              "[BG] Removing EMBED page format:",
              f.url.substring(0, 80),
            );
            return false;
          }
        } catch {}
      }
      return true;
    });

    let syntheticItag = 90000 + formats.length;

    const newFormat = {
      url,
      mimeType: isM3u8
        ? "application/x-mpegurl"
        : isMpd
          ? "application/dash+xml"
          : "video/mp4",
      quality: "auto",
      qualityLabel: isM3u8 ? "HLS" : isMpd ? "DASH" : "Direct",
      isVideo: true,
      isMuxed: true,
      ext: "mp4",
      isHLS: isM3u8,
      isDASH: isMpd,
      itag: syntheticItag++,
    };

    // If we had only image formats, replace them; otherwise add
    if (realVideoFormats.length === 0 && imageFormats.length > 0) {
      info.formats = [newFormat];
    } else {
      info.formats = [...realVideoFormats, newFormat];
    }

    info.source = "specialist+iframe";
    tabData.set(tabId, { videoId: existing.videoId, info, ts: Date.now() });
    persistTabData();

    chrome.action.setBadgeText({ text: "✓", tabId });
    chrome.action.setBadgeBackgroundColor({ color: "#4CAF50", tabId });

    // Try to parse HLS quality variants
    if (isM3u8) {
      try {
        const variants = await parseHLSMasterPlaylist(url);
        if (variants && variants.length > 1) {
          console.log(
            `[BG] Parsed ${variants.length} quality variants from iframe m3u8`,
          );
          const updatedFormats = info.formats.filter(
            (f) => f.url !== url || f.quality !== "auto",
          );
          updatedFormats.unshift({
            url,
            mimeType: "application/x-mpegurl",
            quality: "auto",
            qualityLabel: "Auto (Best)",
            isVideo: true,
            isMuxed: true,
            ext: "mp4",
            isHLS: true,
            itag: syntheticItag++,
          });
          for (const v of variants) {
            updatedFormats.push({
              url: v.url,
              mimeType: "application/x-mpegurl",
              quality: v.quality,
              qualityLabel: v.qualityLabel,
              width: v.width || 0,
              height: v.height || 0,
              bitrate: v.bandwidth || 0,
              isVideo: true,
              isMuxed: true,
              ext: "mp4",
              isHLS: true,
              itag: syntheticItag++,
            });
          }
          info.formats = updatedFormats;
          tabData.set(tabId, {
            videoId: existing.videoId,
            info,
            ts: Date.now(),
          });
          persistTabData();
        }
      } catch (e) {
        console.warn("[BG] Failed to parse iframe HLS master:", e.message);
      }
    }

    // For proxy-detected URLs (not already m3u8), probe the URL to check
    // if it is actually an HLS manifest, and try quality variant synthesis
    if (isProxyDetected && !isM3u8) {
      try {
        await probeAndSynthesizeQualityVariants(
          url,
          info,
          existing,
          tabId,
          syntheticItag,
        );
      } catch (e) {
        console.log("[BG] Proxy variant synthesis note:", e.message || e);
      }
    }

    console.log(
      `[BG] Merged iframe stream into specialist data: ${info.formats.length} format(s)`,
    );
    return { success: true };
  }

  // No existing specialist data — create new entry
  const info = {
    formats: [
      {
        url,
        mimeType: isM3u8
          ? "application/x-mpegurl"
          : isMpd
            ? "application/dash+xml"
            : "video/mp4",
        quality: "auto",
        qualityLabel: isM3u8 ? "HLS" : isMpd ? "DASH" : "Direct",
        isVideo: true,
        isMuxed: true,
        ext: "mp4",
        isHLS: isM3u8,
        isDASH: isMpd,
        itag: 90000,
      },
    ],
    title: "Video",
    source: "iframe_detection",
  };

  try {
    const meta = await captureMetadata(tabId);
    if (meta?.title) info.title = meta.title;
    if (meta?.thumbnail) info.thumbnail = meta.thumbnail;
  } catch {}

  const videoId = `iframe_${tabId}_${Date.now()}`;
  tabData.set(tabId, { videoId, info, ts: Date.now() });
  persistTabData();

  chrome.action.setBadgeText({ text: "✓", tabId });
  chrome.action.setBadgeBackgroundColor({ color: "#4CAF50", tabId });

  console.log(`[BG] Created new entry from iframe stream on tab ${tabId}`);
  return { success: true };
}

/**
 * Merge a webRequest-sniffed HLS/DASH stream into specialist tabData.
 */
function mergeSniffedStreamIntoTabData(tabId, stream) {
  const existing = tabData.get(tabId);
  if (!existing) return false;

  const info = existing.info;
  const formats = info.formats || [];

  const normalizedUrl = stream.url.split("?")[0];
  const alreadyExists = formats.some(
    (f) => f.url && f.url.split("?")[0] === normalizedUrl,
  );
  if (alreadyExists) return false;

  const isHLS = stream.type === "hls";
  const isDASH = stream.type === "dash";

  const videoFormats = formats.filter((f) => f.isVideo !== false && !f.isImage);
  const hadOnlyImages =
    videoFormats.length === 0 && formats.some((f) => f.isImage);

  const newFormat = {
    url: stream.url,
    mimeType: isHLS
      ? "application/x-mpegurl"
      : isDASH
        ? "application/dash+xml"
        : stream.contentType || "video/mp4",
    quality: "auto",
    qualityLabel: isHLS ? "HLS" : isDASH ? "DASH" : "Direct",
    isVideo: true,
    isMuxed: true,
    ext: "mp4",
    isHLS,
    isDASH,
    itag: 90000 + formats.length,
  };

  if (hadOnlyImages) {
    info.formats = [newFormat];
  } else {
    formats.push(newFormat);
    info.formats = formats;
  }

  info.source = (info.source || "specialist") + "+sniffed";
  tabData.set(tabId, { videoId: existing.videoId, info, ts: Date.now() });
  persistTabData();

  console.log(
    `[BG] Merged sniffed ${stream.type} stream into specialist data for tab ${tabId}`,
  );

  // Parse HLS quality variants asynchronously
  if (isHLS) {
    parseHLSMasterPlaylist(stream.url)
      .then((variants) => {
        if (!variants || variants.length <= 1) return;
        const current = tabData.get(tabId);
        if (!current) return;
        const curInfo = current.info;
        const curFormats = curInfo.formats.filter(
          (f) => f.url !== stream.url || f.quality !== "auto",
        );
        let itag = 90000 + curFormats.length + 100;

        curFormats.unshift({
          url: stream.url,
          mimeType: "application/x-mpegurl",
          quality: "auto",
          qualityLabel: "Auto (Best)",
          isVideo: true,
          isMuxed: true,
          ext: "mp4",
          isHLS: true,
          itag: itag++,
        });

        for (const v of variants) {
          curFormats.push({
            url: v.url,
            mimeType: "application/x-mpegurl",
            quality: v.quality,
            qualityLabel: v.qualityLabel,
            width: v.width || 0,
            height: v.height || 0,
            bitrate: v.bandwidth || 0,
            isVideo: true,
            isMuxed: true,
            ext: "mp4",
            isHLS: true,
            itag: itag++,
          });
        }

        curInfo.formats = curFormats;
        tabData.set(tabId, {
          videoId: current.videoId,
          info: curInfo,
          ts: Date.now(),
        });
        persistTabData();
        console.log(
          `[BG] Expanded sniffed HLS to ${variants.length} quality variants`,
        );
      })
      .catch(() => {});
  }

  return true;
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
  const { url, type, filename, headers, tabId, videoTitle, videoThumbnail } =
    msg;

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
      // Store video metadata for persistent display
      videoTitle: videoTitle || null,
      videoThumbnail: videoThumbnail || null,
      // Store tabId so popup can identify same-tab downloads
      tabId: tabId || null,
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
