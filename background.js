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
const SIG_CACHE_MAX = 3; // Max cached player versions — each stores cipher/nsig data + full playerSource (~1.2MB)
const pendingRequests = new Map();
const sniffedStreams = new Map();
const contentHashes = new Map();
const mergeProgress = new Map();
const sniffedYouTubeUrls = new Map(); // tabId → Map(itag → {url, mime, clen, expire, ts})
const REFERER_RULE_ID = 1;
let activeMergeId = null;
let pendingMergeRemoveTimer = null; // Timer ID for delayed activeMerge storage cleanup
let mergeKeepaliveTimer = null; // Keeps SW alive during merge
let workerKeepaliveTimer = null; // Keeps SW alive during worker downloads
let activeWorkerCount = 0; // Track how many worker downloads are in flight
let workerHealthCheckTimer = null; // Periodic offscreen health check during downloads
let formatKeepaliveTimer = null; // Keeps SW alive during format resolution
let activeFormatCount = 0; // Track concurrent getFormats() calls

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

// Update check is handled by the alarm (delayInMinutes: 1 on first run)
// — no separate top-level call needed to avoid double-check on startup.

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

// Import dependencies via importScripts (service worker only — Chrome MV3).
// Firefox MV3 uses the "scripts" array in manifest.json to load these
// files as background page scripts, so importScripts() is unavailable.
// Chrome MV3 ignores the "scripts" array and uses service_worker only.
if (typeof importScripts === "function") {
  importScripts("lib/drm-detection.js");
  importScripts("lib/compat.js");
  importScripts("lib/widevine-proto.js");
  importScripts("lib/mp4-parser.js");
  importScripts("lib/cenc-decryptor.js");
  importScripts("lib/manifest-parser-drm.js");
  importScripts("lib/remote-cdm.js");
  importScripts("lib/drm-handler.js");
  importScripts("extractors/site-map.js");
}

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
          const existing = downloads[msg.downloadId] || {};
          downloads[msg.downloadId] = {
            // Preserve video metadata from initial entry
            videoTitle: existing.videoTitle || null,
            videoThumbnail: existing.videoThumbnail || null,
            // Update progress fields
            phase: msg.phase,
            message: msg.message,
            percent: msg.percent,
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

// ─── Debounced persistTabData ───────────────────────────────────
// Returns a Promise that resolves when the storage write completes.
// Debounces rapid writes (500ms trailing) to reduce storage I/O while
// ensuring the final state is always persisted.  The returned Promise
// resolves when the ACTUAL write is done (not just queued).

// ── Quota-aware helpers (S25 fix) ──────────────────────────────
// chrome.storage.session has a hard 10 MB quota (QUOTA_BYTES = 10,485,760).
// Serializing 50+ YouTube tabs can exceed this limit.  These helpers
// estimate the serialized size and trim stale entries before writing.
const SESSION_QUOTA_BYTES = 10_485_760;
const SESSION_QUOTA_SAFE = Math.floor(SESSION_QUOTA_BYTES * 0.8); // 80% watermark

/**
 * Estimate the JSON-stringified byte length of an object.
 * Uses a fast approach — stringify a representative sample if the Map is very
 * large, otherwise stringify the whole thing.
 */
function _estimateTabDataSize(obj) {
  try {
    return JSON.stringify(obj).length;
  } catch {
    return SESSION_QUOTA_BYTES; // assume worst-case if serialization fails
  }
}

/**
 * Trim tabData entries until the serialized payload fits under the safe
 * watermark.  Eviction order (S50 enhancement):
 *   1. Tabs that no longer exist in Chrome (stale entries from closed tabs)
 *   2. Tabs without active downloads, sorted by age (oldest first)
 *   3. Compress format arrays for tabs older than 10 minutes
 *   4. As last resort, warn user and evict even recent tabs
 * Mutates tabData in-place and returns the trimmed serialized object.
 */
async function _trimTabDataForQuota() {
  let obj = {};
  for (const [tabId, data] of tabData) obj[tabId] = data;
  let size = _estimateTabDataSize(obj);

  if (size <= SESSION_QUOTA_SAFE) return obj;

  const sizeMB = (size / 1024 / 1024).toFixed(1);
  const quotaMB = (SESSION_QUOTA_SAFE / 1024 / 1024).toFixed(1);
  console.warn(
    `[S50] tabDataCache size ${sizeMB}MB exceeds safe watermark ${quotaMB}MB. ` +
      `Trimming from ${tabData.size} entries.`,
  );

  // S50 Phase 1: Remove entries for tabs that no longer exist
  try {
    const openTabs = await chrome.tabs.query({});
    const openTabIds = new Set(openTabs.map((t) => t.id));
    const staleCount = [...tabData.keys()].filter(
      (tid) => !openTabIds.has(tid),
    ).length;
    for (const tabId of [...tabData.keys()]) {
      if (!openTabIds.has(tabId)) {
        tabData.delete(tabId);
      }
    }
    if (staleCount > 0) {
      console.log(`[S50] Removed ${staleCount} stale tab entries`);
    }
    obj = {};
    for (const [tabId, data] of tabData) obj[tabId] = data;
    size = _estimateTabDataSize(obj);
    if (size <= SESSION_QUOTA_SAFE) return obj;
  } catch (e) {
    console.warn("[S50] Tab query during quota trim failed:", e?.message);
  }

  // S50 Phase 2: Compress format arrays for tabs older than 10 minutes
  // Keep only itag, url, quality, contentLength — drop codec info, DASH details
  const TEN_MINUTES = 600000;
  const now = Date.now();
  let compressedCount = 0;
  for (const [tabId, data] of tabData) {
    if (data.ts && now - data.ts > TEN_MINUTES && data.formats?.length) {
      const essential = data.formats.map((f) => ({
        itag: f.itag,
        url: f.url,
        quality: f.quality,
        contentLength: f.contentLength,
        mimeType: f.mimeType?.split(";")[0], // Drop codecs
      }));
      data.formats = essential;
      data._compressed = true;
      compressedCount++;
    }
  }
  if (compressedCount > 0) {
    console.log(`[S50] Compressed ${compressedCount} old tab format arrays`);
    obj = {};
    for (const [tabId, data] of tabData) obj[tabId] = data;
    size = _estimateTabDataSize(obj);
    if (size <= SESSION_QUOTA_SAFE) return obj;
  }

  // S50 Phase 3: Evict oldest tabs without active downloads
  const activeDownloadTabIds = new Set(
    [...activeDownloads.values()].map((d) => d.tabId).filter(Boolean),
  );
  const entries = [...tabData.entries()];

  // Separate active vs inactive, sort inactive by age (oldest first)
  const inactive = entries
    .filter(([tid]) => !activeDownloadTabIds.has(tid))
    .sort((a, b) => (a[1]?.ts || 0) - (b[1]?.ts || 0));

  for (const [tabId] of inactive) {
    if (tabData.size <= 10) break; // Keep at least 10 entries
    tabData.delete(tabId);
    obj = {};
    for (const [tid, data] of tabData) obj[tid] = data;
    size = _estimateTabDataSize(obj);
    if (size <= SESSION_QUOTA_SAFE) break;
  }

  const evictedCount = entries.length - tabData.size;
  if (evictedCount > 0) {
    console.log(`[S50] Evicted ${evictedCount} inactive tabs`);
  }

  // S50 Phase 4: If still over quota, warn user and evict even active tabs
  if (size > SESSION_QUOTA_SAFE && tabData.size > 10) {
    console.warn(
      `[S50] Still over quota (${(size / 1024 / 1024).toFixed(1)}MB) after trimming. ` +
        `Warning user and performing emergency eviction.`,
    );

    // Notify user that we're running out of storage
    try {
      chrome.notifications.create({
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon128.png"),
        title: "Storage Limit Reached",
        message: `Too many tabs (${tabData.size}) are using extension storage. Oldest tabs will be cleared to prevent data loss. Consider closing unused video tabs.`,
        priority: 1,
      });
    } catch (e) {
      console.warn("[S50] Notification failed:", e?.message);
    }

    // Emergency: evict oldest 50% of remaining entries
    const allEntries = [...tabData.entries()].sort(
      (a, b) => (a[1]?.ts || 0) - (b[1]?.ts || 0),
    );
    const toRemove = Math.max(1, Math.floor(allEntries.length / 2));
    for (let i = 0; i < toRemove && tabData.size > 1; i++) {
      tabData.delete(allEntries[i][0]);
    }
    obj = {};
    for (const [tid, data] of tabData) obj[tid] = data;
    size = _estimateTabDataSize(obj);
    console.log(
      `[S50] Emergency eviction removed ${toRemove} tabs, final size: ${(size / 1024 / 1024).toFixed(1)}MB`,
    );
  }

  return obj;
}

let _persistTimer = null;
let _persistResolvers = [];

function persistTabData() {
  return new Promise((resolve) => {
    _persistResolvers.push(resolve);
    if (_persistTimer) clearTimeout(_persistTimer);
    _persistTimer = setTimeout(async () => {
      _persistTimer = null;
      const resolvers = _persistResolvers;
      _persistResolvers = [];

      try {
        const obj = await _trimTabDataForQuota();

        await chrome.storage.session.set({ tabDataCache: obj });
        for (const r of resolvers) r(true);
      } catch (err) {
        console.warn("[BG] persistTabData write failed:", err?.message);
        // On quota error, attempt emergency trim and single retry
        if (
          err?.message?.includes?.("QUOTA_BYTES") ||
          err?.message?.includes?.("quota")
        ) {
          try {
            console.warn(
              "[BG] Quota error detected — emergency trim and retry",
            );
            // Force aggressive trim by deleting half the entries
            const entries = [...tabData.entries()].sort(
              (a, b) => (a[1]?.ts || 0) - (b[1]?.ts || 0),
            );
            const toRemove = Math.ceil(entries.length / 2);
            for (let i = 0; i < toRemove && tabData.size > 1; i++) {
              tabData.delete(entries[i][0]);
            }
            const retryObj = {};
            for (const [tabId, data] of tabData) retryObj[tabId] = data;
            await chrome.storage.session.set({ tabDataCache: retryObj });
            for (const r of resolvers) r(true);
            return;
          } catch (retryErr) {
            console.error(
              "[BG] Emergency persist retry also failed:",
              retryErr?.message,
            );
          }
        }
        for (const r of resolvers) r(false);
      }
    }, 500);
  });
}

// Immediate persist for critical paths — bypasses debounce
async function persistTabDataNow() {
  if (_persistTimer) {
    clearTimeout(_persistTimer);
    _persistTimer = null;
  }
  const resolvers = _persistResolvers;
  _persistResolvers = [];

  try {
    const obj = await _trimTabDataForQuota();

    await chrome.storage.session.set({ tabDataCache: obj });
    for (const r of resolvers) r(true);
  } catch (err) {
    console.warn("[BG] persistTabDataNow write failed:", err?.message);
    // On quota error, attempt emergency trim and single retry
    if (
      err?.message?.includes?.("QUOTA_BYTES") ||
      err?.message?.includes?.("quota")
    ) {
      try {
        console.warn("[BG] Quota error detected — emergency trim and retry");
        const entries = [...tabData.entries()].sort(
          (a, b) => (a[1]?.ts || 0) - (b[1]?.ts || 0),
        );
        const toRemove = Math.ceil(entries.length / 2);
        for (let i = 0; i < toRemove && tabData.size > 1; i++) {
          tabData.delete(entries[i][0]);
        }
        const retryObj = {};
        for (const [tabId, data] of tabData) retryObj[tabId] = data;
        await chrome.storage.session.set({ tabDataCache: retryObj });
        for (const r of resolvers) r(true);
        return;
      } catch (retryErr) {
        console.error(
          "[BG] Emergency persist retry also failed:",
          retryErr?.message,
        );
      }
    }
    for (const r of resolvers) r(false);
  }
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
    // Block concurrent merges immediately — set activeMergeId before async resume
    activeMergeId = merge.mergeId || "resuming";
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
        activeMergeId = null; // Unblock merge slot after failed resume
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
      activeMergeId = null; // No resume data — unblock merge slot
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

// ─── Cleanup stale activeDownloads from previous SW lifetime ───────
// If the SW died mid-download, entries stay in session storage forever
// since the 15s cleanup timer never fires. Mark them as failed.
chrome.storage.session.get("activeDownloads", (result) => {
  const downloads = result?.activeDownloads;
  if (!downloads || Object.keys(downloads).length === 0) return;

  let cleaned = 0;
  const MAX_STALE_AGE_MS = 5 * 60 * 1000; // 5 minutes
  const now = Date.now();

  for (const [id, dl] of Object.entries(downloads)) {
    // If the download was "starting" or "downloading" and is stale,
    // mark it as failed so the UI reflects the correct state
    if (
      (dl.phase === "starting" || dl.phase === "downloading") &&
      now - (dl.ts || 0) > MAX_STALE_AGE_MS
    ) {
      downloads[id] = {
        ...dl,
        phase: "error",
        message: "Download interrupted (service worker restarted)",
        ts: now,
      };
      cleaned++;
    }
  }

  if (cleaned > 0) {
    chrome.storage.session.set({ activeDownloads: downloads }).catch(() => {});
    console.log(
      "[BG] Marked",
      cleaned,
      "stale activeDownloads as failed after SW restart",
    );
  }
});

// ─── Clean stale DNR session rules from previous SW lifetime ───────
// Session header rules (id >= SESSION_HEADER_BASE) persist across SW
// restarts but sessionHeaderCounter resets to 0, causing ID collisions.
// Only clear rules if no active downloads are in flight (surviving
// offscreen workers may still depend on these header rules).
(async () => {
  try {
    // Check for in-progress downloads before clearing rules
    const dlResult = await chrome.storage.session.get("activeDownloads");
    const activeDownloads = dlResult?.activeDownloads || {};
    const inFlightCount = Object.values(activeDownloads).filter(
      (d) => d.phase === "starting" || d.phase === "downloading",
    ).length;

    const rules = await chrome.declarativeNetRequest?.getSessionRules?.();
    if (rules && rules.length > 0) {
      const staleIds = rules
        .filter((r) => r.id >= 1000000) // SESSION_HEADER_BASE
        .map((r) => r.id);
      if (staleIds.length > 0) {
        if (inFlightCount > 0) {
          console.log(
            "[BG]",
            inFlightCount,
            "active downloads in flight — deferring DNR rule cleanup.",
            "Rules preserved:",
            staleIds.length,
          );
          // Bump the counter past existing rule IDs to avoid collisions
          // without deleting rules that active downloads need
          const maxId = Math.max(...staleIds);
          sessionHeaderCounter = maxId - 1000000 + 1;
        } else {
          await chrome.declarativeNetRequest?.updateSessionRules?.({
            removeRuleIds: staleIds,
          });
          console.log(
            "[BG] Cleaned",
            staleIds.length,
            "stale session header rules from previous SW lifetime",
          );
        }
      }
    }
  } catch (e) {
    // declarativeNetRequest may not be available (Firefox)
  }
})();

// ─── S31/S37 fix: Extension Update Handling ────────────────────────────
// Chrome can auto-update extensions mid-download, killing all contexts.
// Defer updates if downloads, merges, or format resolution are active.

/**
 * Check if there are any active downloads, merges, or format resolutions in progress.
 * @returns {Promise<{hasActive: boolean, count: number, formatCount: number}>}
 */
async function hasActiveDownloads() {
  try {
    const dlResult = await chrome.storage.session.get("activeDownloads");
    const activeDownloads = dlResult?.activeDownloads || {};
    const count = Object.values(activeDownloads).filter(
      (d) =>
        d.phase === "starting" ||
        d.phase === "downloading" ||
        d.phase === "merging",
    ).length;

    // S37 fix: Also check for active format resolution (cipher/N-sig parsing)
    // activeFormatCount tracks concurrent getFormats() calls that may be
    // parsing 1+ MB player.js in the offscreen sandbox (takes 10-35 seconds)
    const formatCount = activeFormatCount;

    return {
      hasActive: count > 0 || formatCount > 0,
      count,
      formatCount,
    };
  } catch (err) {
    console.error("[BG] hasActiveDownloads error:", err);
    return { hasActive: false, count: 0, formatCount: 0 };
  }
}

// Listen for extension updates — defer if downloads or format resolution are active
chrome.runtime.onUpdateAvailable.addListener((details) => {
  console.log("[BG] Extension update available:", details.version);

  hasActiveDownloads().then(({ hasActive, count, formatCount }) => {
    if (hasActive) {
      const reasons = [];
      if (count > 0) reasons.push(`${count} download(s)`);
      if (formatCount > 0) reasons.push(`${formatCount} format resolution(s)`);

      console.warn(
        `[BG] Deferring extension update — ${reasons.join(", ")} in progress`,
      );
      // Do NOT call chrome.runtime.reload() — let operations finish naturally
      // Chrome will auto-update after the SW goes idle
    } else {
      console.log(
        "[BG] No active downloads or format resolution — allowing extension update",
      );
      chrome.runtime.reload();
    }
  });
});

// Save download state before service worker suspension
chrome.runtime.onSuspend.addListener(() => {
  console.warn("[BG] Service worker suspending — marking in-flight downloads");

  // Synchronous path only — onSuspend doesn't wait for async operations
  chrome.storage.session.get("activeDownloads", (result) => {
    const downloads = result?.activeDownloads || {};
    let marked = 0;

    for (const [id, dl] of Object.entries(downloads)) {
      if (
        dl.phase === "starting" ||
        dl.phase === "downloading" ||
        dl.phase === "merging"
      ) {
        downloads[id] = {
          ...dl,
          interrupted: true,
          interruptedAt: Date.now(),
        };
        marked++;
      }
    }

    if (marked > 0) {
      chrome.storage.session.set({ activeDownloads: downloads });
      console.log(
        `[BG] Marked ${marked} downloads as interrupted before suspend`,
      );
    }
  });
});

// Enhanced restoration: show user notification for interrupted downloads
chrome.storage.session.get("activeDownloads", (result) => {
  const downloads = result?.activeDownloads;
  if (!downloads) return;

  const interrupted = Object.values(downloads).filter((d) => d.interrupted);
  if (interrupted.length > 0) {
    console.log(
      `[BG] Found ${interrupted.length} interrupted download(s) from previous session`,
    );

    // Show notification to user
    if (chrome.notifications) {
      const message =
        interrupted.length === 1
          ? "1 download was interrupted by an extension update or restart"
          : `${interrupted.length} downloads were interrupted by an extension update or restart`;

      chrome.notifications.create("interrupted-downloads", {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
        title: "Downloads Interrupted",
        message: message,
        priority: 1,
      });
    }

    // Mark them as failed so cleanup can proceed
    const now = Date.now();
    for (const [id, dl] of Object.entries(downloads)) {
      if (dl.interrupted) {
        downloads[id] = {
          ...dl,
          phase: "error",
          message: "Download interrupted by extension update or restart",
          ts: now,
        };
      }
    }

    chrome.storage.session.set({ activeDownloads: downloads }).catch(() => {});
  }
});

// ─── Initialize DRM bypass pipeline ────────────────────────────────
// DRMHandler registers its own onMessage listener for EME_* messages.
// It runs alongside (not instead of) the Detector's existing listener.
// Store the promise so that DRM message handlers can await readiness.
let drmInitReady = Promise.resolve();
if (typeof DRMHandler !== "undefined" && DRMHandler.init) {
  drmInitReady = DRMHandler.init().catch((e) => {
    console.error("[BG] DRM handler init failed:", e);
  });
}

const INSTAGRAM_REFERER_RULE_ID = 2;
const TWITTER_REFERER_RULE_ID = 3;

// ─── Pirate CDN Referer/Origin rules ───
// Many pirate streaming CDNs reject requests with missing or chrome-extension:// Referer/Origin.
// Each CDN domain gets a DNR rule so segment downloads succeed.
// Rule IDs 4-30 are reserved for pirate CDNs.
const PIRATE_CDN_RULES = [
  // { id, cdnPattern (urlFilter or regexFilter), referer, origin }
  { id: 4, cdn: "||rabbitstream.net/", ref: "https://rabbitstream.net/" },
  { id: 5, cdn: "||megacloud.tv/", ref: "https://megacloud.tv/" },
  { id: 6, cdn: "||vidplay.online/", ref: "https://vidplay.online/" },
  { id: 7, cdn: "||filemoon.sx/", ref: "https://filemoon.sx/" },
  { id: 8, cdn: "||streamtape.com/", ref: "https://streamtape.com/" },
  { id: 9, cdn: "||doodstream.com/", ref: "https://doodstream.com/" },
  { id: 10, cdn: "||mixdrop.co/", ref: "https://mixdrop.co/" },
  { id: 11, cdn: "||voe.sx/", ref: "https://voe.sx/" },
  { id: 12, cdn: "||streamwish.to/", ref: "https://streamwish.to/" },
  { id: 13, cdn: "||vidhide.com/", ref: "https://vidhide.com/" },
  { id: 14, cdn: "||filelions.to/", ref: "https://filelions.to/" },
  { id: 15, cdn: "||vidguard.to/", ref: "https://vidguard.to/" },
  { id: 16, cdn: "||rapid-cloud.co/", ref: "https://rapid-cloud.co/" },
  { id: 17, cdn: "||dokicloud.one/", ref: "https://dokicloud.one/" },
  { id: 18, cdn: "||mp4upload.com/", ref: "https://mp4upload.com/" },
  { id: 19, cdn: "||upstream.to/", ref: "https://upstream.to/" },
  { id: 20, cdn: "||vidoza.net/", ref: "https://vidoza.net/" },
  { id: 21, cdn: "||streamsb.net/", ref: "https://streamsb.net/" },
  { id: 22, cdn: "||embedrise.com/", ref: "https://embedrise.com/" },
  { id: 23, cdn: "||lulustream.com/", ref: "https://lulustream.com/" },
];

// ─── CORS response header injection ───
// Rule ID 31: Inject Access-Control-Allow-Origin: * on pirate CDN responses
// so segment fetches from the extension context don't get blocked by CORS.
const CORS_INJECT_RULE_ID = 31;

// ─── CSP / X-Frame-Options stripping ───
// Rule IDs 32-33: Remove restrictive headers that block iframe inspection
// and cross-origin resource loading.
const CSP_STRIP_RULE_ID = 32;
const XFRAME_STRIP_RULE_ID = 33;

chrome.declarativeNetRequest
  ?.updateDynamicRules({
    removeRuleIds: [
      REFERER_RULE_ID,
      INSTAGRAM_REFERER_RULE_ID,
      TWITTER_REFERER_RULE_ID,
      ...PIRATE_CDN_RULES.map((r) => r.id),
      CORS_INJECT_RULE_ID,
      CSP_STRIP_RULE_ID,
      XFRAME_STRIP_RULE_ID,
    ],
    addRules: [
      // ─── YouTube ───
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

      // ─── Instagram ───
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

      // ─── Twitter/X ───
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

      // ─── Pirate CDN Referer/Origin rules ───
      // Each pirate CDN gets Referer + Origin set to its own domain.
      // CDNs reject requests where Referer is chrome-extension:// or empty.
      ...PIRATE_CDN_RULES.map((r) => ({
        id: r.id,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            { header: "Referer", operation: "set", value: r.ref },
            {
              header: "Origin",
              operation: "set",
              value: r.ref.replace(/\/$/, ""),
            },
          ],
        },
        condition: {
          urlFilter: r.cdn,
          resourceTypes: ["xmlhttprequest", "media", "other"],
        },
      })),

      // ─── CORS bypass: inject permissive response headers ───
      // Pirate CDNs often don't set CORS headers. This rule adds
      // Access-Control-Allow-Origin: * so extension fetches succeed.
      {
        id: CORS_INJECT_RULE_ID,
        priority: 1,
        action: {
          type: "modifyHeaders",
          responseHeaders: [
            {
              header: "Access-Control-Allow-Origin",
              operation: "set",
              value: "*",
            },
            {
              header: "Access-Control-Allow-Methods",
              operation: "set",
              value: "GET, POST, OPTIONS",
            },
            {
              header: "Access-Control-Allow-Headers",
              operation: "set",
              value: "*",
            },
          ],
        },
        condition: {
          // Match common pirate CDN domains that serve .ts/.m3u8/.mp4 segments
          requestDomains: [
            "rabbitstream.net",
            "megacloud.tv",
            "vidplay.online",
            "filemoon.sx",
            "streamtape.com",
            "doodstream.com",
            "mixdrop.co",
            "voe.sx",
            "streamwish.to",
            "vidhide.com",
            "filelions.to",
            "vidguard.to",
            "rapid-cloud.co",
            "dokicloud.one",
            "mp4upload.com",
            "upstream.to",
            "vidoza.net",
            "streamsb.net",
            "embedrise.com",
            "lulustream.com",
          ],
          resourceTypes: ["xmlhttprequest", "media", "other"],
        },
      },

      // ─── CSP stripping: remove Content-Security-Policy ───
      // Many pirate player iframes set strict CSP that blocks extension injection.
      // Stripping CSP allows content scripts to execute in embedded player frames.
      {
        id: CSP_STRIP_RULE_ID,
        priority: 1,
        action: {
          type: "modifyHeaders",
          responseHeaders: [
            { header: "Content-Security-Policy", operation: "remove" },
            {
              header: "Content-Security-Policy-Report-Only",
              operation: "remove",
            },
          ],
        },
        condition: {
          requestDomains: [
            "rabbitstream.net",
            "megacloud.tv",
            "vidplay.online",
            "filemoon.sx",
            "doodstream.com",
            "voe.sx",
            "streamwish.to",
            "vidhide.com",
            "filelions.to",
            "vidguard.to",
            "rapid-cloud.co",
            "dokicloud.one",
            "embedrise.com",
            "lulustream.com",
            "2embed.cc",
            "vidsrc.me",
            "flixhq.to",
            "sflix.se",
            "fmovies.to",
          ],
          resourceTypes: ["sub_frame", "main_frame"],
        },
      },

      // ─── X-Frame-Options / COEP / COOP stripping ───
      // Remove headers that prevent iframe embedding of pirate player pages.
      {
        id: XFRAME_STRIP_RULE_ID,
        priority: 1,
        action: {
          type: "modifyHeaders",
          responseHeaders: [
            { header: "X-Frame-Options", operation: "remove" },
            { header: "Cross-Origin-Embedder-Policy", operation: "remove" },
            { header: "Cross-Origin-Opener-Policy", operation: "remove" },
          ],
        },
        condition: {
          requestDomains: [
            "rabbitstream.net",
            "megacloud.tv",
            "vidplay.online",
            "filemoon.sx",
            "doodstream.com",
            "voe.sx",
            "streamwish.to",
            "vidhide.com",
            "filelions.to",
            "vidguard.to",
            "rapid-cloud.co",
            "2embed.cc",
            "vidsrc.me",
          ],
          resourceTypes: ["sub_frame", "main_frame"],
        },
      },
    ],
  })
  .catch((e) => console.warn("[BG] DNR rule error:", e.message));

console.log(
  `[BG] DNR rules installed: 3 platform CDNs + ${PIRATE_CDN_RULES.length} pirate CDNs + CORS inject + CSP/XFO strip`,
);

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
    await chrome.declarativeNetRequest.updateSessionRules?.({
      addRules: [rule],
    });
    return await fetch(url, fetchOptions);
  } finally {
    await chrome.declarativeNetRequest
      .updateSessionRules?.({
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

  await chrome.declarativeNetRequest.updateSessionRules?.({
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
    ?.updateSessionRules({ removeRuleIds: ids })
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

// ─── Generic cookie forwarding ───
// For any site (not just YouTube), extract cookies from the browser's cookie store
// so the extension can make authenticated CDN requests. This is how a real browser
// session already passed Cloudflare/DDoS-Guard challenges — we inherit that trust.
async function getCookieHeaderForUrl(url) {
  try {
    const u = new URL(url);
    return new Promise((resolve) => {
      chrome.cookies.getAll({ domain: u.hostname }, (cookies) => {
        if (!cookies || cookies.length === 0) {
          // Try parent domain (e.g., .streamtape.com for cdn.streamtape.com)
          const parts = u.hostname.split(".");
          if (parts.length > 2) {
            const parentDomain = "." + parts.slice(-2).join(".");
            chrome.cookies.getAll({ domain: parentDomain }, (parentCookies) => {
              if (!parentCookies || parentCookies.length === 0) {
                resolve("");
              } else {
                resolve(
                  parentCookies.map((c) => c.name + "=" + c.value).join("; "),
                );
              }
            });
          } else {
            resolve("");
          }
          return;
        }
        resolve(cookies.map((c) => c.name + "=" + c.value).join("; "));
      });
    });
  } catch {
    return "";
  }
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

    case "INJECT_EME_INTERCEPTOR":
      // Fallback injection for Trusted Types sites where bridge.js
      // cannot set script.src due to CSP enforcement.
      // Uses chrome.scripting.executeScript with world:"MAIN".
      if (sender.tab?.id) {
        chrome.scripting
          .executeScript({
            target: { tabId: sender.tab.id, allFrames: false },
            files: ["content/eme-interceptor.js"],
            world: "MAIN",
          })
          .then(() => {
            console.log(
              "[BG] EME interceptor injected via scripting API (Trusted Types fallback) on tab",
              sender.tab.id,
            );
            respond({ success: true });
          })
          .catch((e) => {
            console.warn(
              "[BG] EME interceptor fallback injection failed:",
              e.message,
            );
            respond({ success: false, error: e.message });
          });
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
      // Extension-origin blob URLs (blob:chrome-extension://...) are accessible
      // from the service worker via chrome.downloads.download directly — no need
      // for tab injection. The offscreen document creates the blob in the same
      // extension origin, so the service worker can read it.
      (async () => {
        try {
          const downloadId = await chrome.downloads.download({
            url: msg.blobUrl,
            filename: msg.filename || "video.mp4",
            saveAs: true,
          });
          console.log("[BG] Blob download started, id:", downloadId);
          respond({ success: true, downloadId });
        } catch (e) {
          console.error("[BG] Blob download failed:", e.message);
          respond({ success: false, error: e.message });
        }
      })();
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

    case "REFRESH_YOUTUBE_URLS":
      // S35 fix: Worker detected YouTube URL expiry, refresh format URLs
      handleRefreshYouTubeUrls(msg)
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
        // Worker download finished — release keepalive
        stopWorkerKeepalive();

        chrome.storage.session.get("activeDownloads", (result) => {
          const downloads = result?.activeDownloads || {};
          const existing = downloads[msg.downloadId] || {};
          downloads[msg.downloadId] = {
            // Preserve video metadata from initial entry
            videoTitle: existing.videoTitle || null,
            videoThumbnail: existing.videoThumbnail || null,
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

    case "ADD_KEY_HOST_HEADERS": {
      const keyHosts = msg.hosts || [];
      const keyHeaders = msg.headers || {};
      if (keyHosts.length === 0 || Object.keys(keyHeaders).length === 0) {
        respond({ ruleIds: [] });
        return true;
      }
      Promise.all(
        keyHosts.map((host) =>
          addSessionHeaders("||" + host + "/", keyHeaders).catch(() => null),
        ),
      ).then((ids) => {
        respond({ ruleIds: ids.filter(Boolean) });
      });
      return true;
    }

    case "CHECK_SPECIALIST": {
      const host = (msg.hostname || "").toLowerCase();
      const script = host ? findSpecialistForHost(host) : null;
      respond({ hasSpecialist: !!script, scriptFile: script });
      return true;
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

    case "BLOB_VIDEO_DETECTED": {
      // Blob video detected via MSE/URL.createObjectURL — add to sniffedStreams
      // with isBlobUrl flag so popup knows it requires page-context download
      const blobTabId = sender.tab?.id;
      if (blobTabId && blobTabId >= 0 && msg.blobUrl) {
        const stream = {
          url: msg.blobUrl,
          type: "direct",
          contentType: msg.blobType || "video/mp4",
          size: msg.blobSize || 0,
          ts: Date.now(),
          isBlobUrl: true,
        };
        if (!sniffedStreams.has(blobTabId)) {
          sniffedStreams.set(blobTabId, []);
        }
        const streams = sniffedStreams.get(blobTabId);
        // Deduplicate blob URLs
        if (!streams.some((s) => s.url === msg.blobUrl)) {
          streams.push(stream);
          console.log(
            `[BG] Blob video added to sniffed streams on tab ${blobTabId}: ${msg.blobType}`,
          );
          chrome.action.setBadgeText({ text: "●", tabId: blobTabId });
          chrome.action.setBadgeBackgroundColor({
            color: "#2196F3",
            tabId: blobTabId,
          });
        }
        respond({ success: true });
      } else {
        respond({ success: false });
      }
      return true;
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

  // S44 fix: Detect concurrent downloads of same video from multiple tabs
  if (msg.videoId) {
    const samevideotabs = [];
    for (const [tid, data] of tabData) {
      if (data.videoId === msg.videoId && tid !== tabId) {
        samevideotabs.push(tid);
      }
    }
    if (samevideotabs.length > 0) {
      console.warn(
        `[S44] Same video (${msg.videoId}) detected in ${samevideotabs.length + 1} tabs ` +
          `(${[tabId, ...samevideotabs].join(", ")}). ` +
          "Sniffed URLs are isolated per-tab, but simultaneous downloads may cause codec mismatches.",
      );
    }
  }

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

    // Merge new formats into existing tabData rather than overwriting
    // This prevents losing formats when multiple VIDEO_DETECTED arrive
    // (e.g. generic extractor detects multiple <video> sources on same page)
    const existing = tabData.get(tabId);
    if (existing?.info?.formats?.length > 0 && info?.formats?.length > 0) {
      const existingUrls = new Set(existing.info.formats.map((f) => f.url));
      for (const fmt of info.formats) {
        if (!existingUrls.has(fmt.url)) {
          existing.info.formats.push(fmt);
        }
      }
      // Preserve richer metadata (title, thumbnail, duration)
      if (info.title && info.title !== "Video")
        existing.info.title = info.title;
      if (info.thumbnail) existing.info.thumbnail = info.thumbnail;
      if (info.lengthSeconds) existing.info.lengthSeconds = info.lengthSeconds;
      if (info.drmDetected) {
        existing.info.drmDetected = info.drmDetected;
        existing.info.drmType = info.drmType;
        existing.info.drmSources = info.drmSources;
        existing.info.drmConfidence = info.drmConfidence;
      }
      existing.ts = Date.now();
      tabData.set(tabId, existing);
    } else {
      tabData.set(tabId, { videoId: msg.videoId, info, ts: Date.now() });
    }
    // Critical path — await immediate persist to ensure data survives SW restart
    await persistTabDataNow();

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
        // S55: Validate restored data structure to prevent crashes from corrupted profile
        const restoredData = stored.tabDataCache[tabId];
        if (isValidTabData(restoredData)) {
          cached = restoredData;
          tabData.set(tabId, cached);
        } else {
          console.warn(
            `[BG] S55: Corrupted tabData cache for tab ${tabId} — skipping restoration`,
            restoredData,
          );
          // Don't use cached data; will re-fetch formats
        }
      }
    } catch (err) {
      console.warn("[BG] S55: Failed to restore tabDataCache:", err.message);
    }
  }

  if (cached?.info && (!videoId || cached.videoId === videoId)) {
    return cached.info;
  }
  if (!videoId) return { error: "No video ID" };
  const info = await getFormats(videoId, {}, tabId);
  tabData.set(tabId, { videoId, info, ts: Date.now() });
  await persistTabDataNow();
  return info;
}

/**
 * S55: Validates tabData structure to prevent crashes from corrupted browser profile.
 * Expected structure: { videoId: string, info: { formats: array, ... }, ts: number }
 */
function isValidTabData(data) {
  if (!data || typeof data !== "object") return false;
  if (!data.videoId || typeof data.videoId !== "string") return false;
  if (!data.info || typeof data.info !== "object") return false;

  const info = data.info;
  // Critical fields that must exist
  if (!Array.isArray(info.formats)) return false;
  if (typeof info.videoId !== "string") return false;

  // Validate each format has required fields
  for (const fmt of info.formats) {
    if (!fmt || typeof fmt !== "object") return false;
    // Each format must have url, itag, and mimeType at minimum
    if (typeof fmt.url !== "string" || !fmt.url) return false;
    if (typeof fmt.itag !== "number" && typeof fmt.itag !== "string")
      return false;
    if (typeof fmt.mimeType !== "string") return false;
  }

  return true;
}

async function getFormats(videoId, pageData, tabId = null) {
  if (pendingRequests.has(videoId)) {
    return pendingRequests.get(videoId);
  }
  startFormatKeepalive();
  const promise = getFormatsInner(videoId, pageData, tabId);
  pendingRequests.set(videoId, promise);
  try {
    return await promise;
  } finally {
    pendingRequests.delete(videoId);
    stopFormatKeepalive();
  }
}

async function getFormatsInner(videoId, pageData, tabId = null) {
  // ============ Tier 1: InnerTube API (android_vr → web → web_embedded) ============
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
  let nSigFailed = false;

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

        if (mergedSig?.nSigCode || mergedSig?.playerSource) {
          const nSigOk = await applyNSig(info.formats, mergedSig);
          if (nSigOk === false) nSigFailed = true;
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

          if (mergedSig?.nSigCode || mergedSig?.playerSource) {
            const nSigOk = await applyNSig(ciphered.formats, mergedSig);
            if (nSigOk === false) nSigFailed = true;
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

          if (mergedSig?.nSigCode || mergedSig?.playerSource) {
            const nSigOk = await applyNSig(ciphered.formats, mergedSig);
            if (nSigOk === false) nSigFailed = true;
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

    // Enrich Tier 1 formats with sniffed URLs (IDM-style)
    const resolveTabId2 = tabId || findTabIdForVideoId(videoId);
    if (resolveTabId2) {
      const enriched = enrichFormatsWithSniffed(
        mergedFormats,
        resolveTabId2,
        videoId,
      );
      if (enriched > 0) {
        console.log(
          "[BG] Tier 1: Enriched",
          enriched,
          "format URLs from sniffed googlevideo.com requests",
        );
      }
    }

    const vd = bestVideoDetails || {};

    // S54 fix: Detect live streams in Tier 1
    const isLive = vd.isLiveContent === true || vd.isLive === true;
    const isLiveDvr = vd.isLiveDvrEnabled === true;

    if (isLive) {
      console.log(
        "[S54] Live stream detected (Tier 1):",
        videoId,
        "DVR:",
        isLiveDvr,
      );
    }

    return {
      videoId: vd.videoId || videoId,
      title: vd.title || "YouTube Video",
      author: vd.author || "",
      lengthSeconds: parseInt(vd.lengthSeconds) || 0,
      isLive: isLive || false, // S54: Track live status
      isLiveDvr: isLiveDvr || false, // S54: Track if DVR enabled
      thumbnail: vd.thumbnail?.thumbnails?.slice(-1)[0]?.url || "",
      formats: mergedFormats,
      clientUsed: successfulClients.join("+"),
      loggedIn: pageData.loggedIn ?? null,
      nSigFailed: nSigFailed || false,
    };
  }

  // ============ Tier 2: inject.js pre-deciphered formats (fallback) ============
  console.log(
    "[BG] Tier 1 (API) returned 0 formats, trying Tier 2 (inject.js page-deciphered)...",
  );

  if (pageData.resolvedFormats && pageData.resolvedFormats.length > 0) {
    console.log(
      "[BG] ★ Tier 2: Using",
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

    // Apply N-sig transformation — inject.js may have already applied it
    // via direct global access (2025+ architecture). If directNSig is true,
    // the URLs already have correct N-sig values.
    if (!pageData.directNSig) {
      const hasUntransformedN = pageData.resolvedFormats.some(
        (f) => f.url && /[?&]n=([^&]{15,})/.test(f.url),
      );

      if (hasUntransformedN) {
        let nSigCode = pageData.nSigCode || null;
        let nSigBundled = pageData.nSigBundled || null;
        // Reuse sig from Tier 1 if available; if not, load it now
        // (sig is already declared at the top of the function)

        // Try to load signature data from player.js (background can fetch without CSP issues)
        const playerUrl = pageData.playerUrl || null;
        if (playerUrl && !sig) {
          try {
            sig = await loadSignatureData(playerUrl);
            console.log(
              "[BG] Tier 2: Loaded sig data for n-sig transform — nSig:",
              sig?.nSigCode ? "yes" : "none",
              sig?.nSigBundled ? "(bundled)" : "",
            );
          } catch (e) {
            console.warn("[BG] Tier 2: Failed to load sig data:", e.message);
          }
        }

        // Merge with sig data (whether from Tier 1 or just loaded)
        if (sig) {
          nSigCode = nSigCode || sig.nSigCode || null;
          nSigBundled = nSigBundled || sig.nSigBundled || null;
        }

        if (nSigCode || sig?.playerSource) {
          console.log(
            "[BG] Tier 2: Applying N-sig transform to",
            pageData.resolvedFormats.length,
            "formats",
            nSigCode ? "(regex code)" : "(full solver only)",
          );
          const nSigOk = await applyNSig(
            pageData.resolvedFormats,
            sig || { nSigCode, nSigBundled },
          );
          if (nSigOk === false) {
            pageData.nSigFailed = true;
          }
        } else {
          console.warn(
            "[BG] Tier 2: No N-sig code or player source available — downloads may be throttled",
          );
          pageData.nSigFailed = true;
        }
      }
    } else {
      console.log("[BG] Tier 2: N-sig already applied by inject.js (direct)");
    }

    // Enrich Tier 2 formats with sniffed URLs (IDM-style) — replaces any
    // URLs where cipher/N-sig may have been applied incorrectly with the
    // fully-decrypted URLs captured from YouTube's own player requests.
    const resolveTabId = tabId || findTabIdForVideoId(videoId);
    if (resolveTabId) {
      const enriched = enrichFormatsWithSniffed(
        pageData.resolvedFormats,
        resolveTabId,
        videoId,
      );
      if (enriched > 0) {
        console.log(
          "[BG] Tier 2: Enriched",
          enriched,
          "format URLs from sniffed googlevideo.com requests",
        );
      }
    }

    const vd = pageData.playerResponse?.videoDetails || {};

    // S54 fix: Detect live streams to track live-to-VOD transitions
    const isLive = vd.isLiveContent === true || vd.isLive === true;
    const isLiveDvr = vd.isLiveDvrEnabled === true;

    if (isLive) {
      console.log(
        "[S54] Live stream detected (Tier 2):",
        videoId,
        "DVR:",
        isLiveDvr,
      );
    }

    return {
      videoId: vd.videoId || videoId,
      title: vd.title || pageData.title || "Video",
      author: vd.author || pageData.author || "",
      lengthSeconds: parseInt(vd.lengthSeconds) || pageData.duration || 0,
      isLive: isLive || false, // S54: Track live status
      isLiveDvr: isLiveDvr || false, // S54: Track if DVR enabled
      thumbnail:
        vd.thumbnail?.thumbnails?.slice(-1)[0]?.url || pageData.thumbnail || "",
      formats: pageData.resolvedFormats,
      clientUsed: pageData.formatSource || "page_deciphered",
      loggedIn: pageData.loggedIn ?? null,
      nSigFailed: pageData.nSigFailed || false,
    };
  }

  // ============ Tier S: Sniffed URLs (IDM-style fallback) ============
  // If cipher/N-sig extraction AND API clients all failed, but the user has
  // already played the video, we have captured fully-working googlevideo.com
  // URLs from the player's own network requests. Use these as a last resort.
  const sniffTabId = tabId || findTabIdForVideoId(videoId);
  if (sniffTabId) {
    const sniffedFormats = buildSniffedFormats(sniffTabId, videoId);
    if (sniffedFormats.length > 0) {
      console.log(
        "[BG] ★ Tier S: Using",
        sniffedFormats.length,
        "sniffed googlevideo.com URLs (IDM-style bypass)",
      );

      // Try to get video metadata from pageData or tabData
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

  console.log("[BG] API clients exhausted, trying Tier 3 (page scrape)...");
  return pageScrapeWithCipher(
    videoId,
    pagePlayerResp,
    playerUrl,
    sig,
    lastErr,
    cipherCode,
    cipherArgName,
    pageData.loggedIn ?? null,
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

  // S45 fix: Detect Cloudflare bot challenge HTML responses
  if (
    html.includes("<!DOCTYPE") &&
    (html.includes("Checking your browser") ||
      html.includes("challenge-platform") ||
      html.includes("cf-browser-verification") ||
      html.includes("DDoS protection by Cloudflare"))
  ) {
    console.error(
      "[S45] Cloudflare bot challenge detected in page fetch. " +
        "Site is blocking extension's fetch(). User must complete challenge in browser first.",
    );
    throw new Error(
      "Cloudflare bot protection blocked request. Visit the site in browser to complete challenge.",
    );
  }

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
  if (!sig?.nSigCode && !sig?.nSigBundled && !sig?.playerSource) return;

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

  // yt-dlp-style N-sig result validation: if result.endsWith(challenge),
  // the JS function threw an exception and YouTube appended the original
  // value to an error string — this means the transform FAILED.
  function validateNSigResults(res, params) {
    const invalidIdx = res.findIndex(
      (r, i) =>
        typeof r === "string" &&
        r.endsWith(params[i]) &&
        r.length > params[i].length,
    );
    if (invalidIdx !== -1) {
      console.warn(
        `[BG] N-sig result invalid (endsWith challenge): "${res[invalidIdx]}" for challenge "${params[invalidIdx]}"`,
      );
      return false;
    }
    const anyChanged = res.some(
      (r, i) => r && typeof r === "string" && r !== params[i],
    );
    return anyChanged;
  }

  // Try 1: Plain N-sig code (original extraction)
  if (sig.nSigCode) {
    try {
      results = await sandboxEval(sig.nSigCode, decodedParams);
      if (validateNSigResults(results, decodedParams)) {
        succeeded = true;
        console.log("[BG] N-sig transform succeeded (plain code)");
      } else {
        console.warn(
          "[BG] N-sig plain code returned unchanged/invalid values — trying bundled...",
        );
      }
    } catch (err) {
      console.warn(
        "[BG] N-sig plain code failed:",
        err.message,
        "— trying bundled...",
      );
    }
  }

  // Try 2: yt-dlp bundled N-sig (includes all dependencies)
  if (!succeeded && sig.nSigBundled) {
    try {
      results = await sandboxEval(sig.nSigBundled, decodedParams);
      if (validateNSigResults(results, decodedParams)) {
        succeeded = true;
        console.log("[BG] ★ N-sig transform succeeded (yt-dlp bundled code)");
      } else {
        console.warn(
          "[BG] N-sig bundled code also returned unchanged/invalid values",
        );
      }
    } catch (err2) {
      console.warn("[BG] N-sig bundled code also failed:", err2.message);
    }
  }

  // Try 3: Full player.js solver (AST-based, sends entire player.js to sandbox)
  // This is the nuclear option — if regex extraction failed because YouTube
  // changed base.js patterns, the full solver uses structural AST analysis
  // (meriyah parser) to find N-sig functions, just like yt-dlp does.
  // The sandbox has the FULL player.js context so wrapper functions like
  // Y$K = {return g.transform(a)} resolve naturally — no pre-bundling needed.
  if (!succeeded && sig.playerSource) {
    try {
      console.log(
        "[BG] N-sig regex failed — trying full player.js solver (AST-based)...",
      );
      const solverResult = await sandboxSolvePlayer(
        sig.playerSource,
        sig.playerUrl || "",
        decodedParams, // N-sig challenges
        [], // No cipher challenges needed here
      );
      const { nResults, elapsed } = solverResult;
      const solvedCount = Object.keys(nResults).length;
      console.log(
        "[BG] Full solver returned",
        solvedCount,
        "N-sig results in",
        elapsed + "ms",
      );

      if (solvedCount > 0) {
        // Build results array matching decodedParams order
        results = decodedParams.map((p) => nResults[p] || p);
        if (validateNSigResults(results, decodedParams)) {
          succeeded = true;
          console.log(
            "[BG] ★★ N-sig transform succeeded (full player.js solver)",
          );
        } else {
          console.warn(
            "[BG] Full solver returned invalid results (endsWith check failed)",
          );
        }
      }
    } catch (err3) {
      console.warn("[BG] Full player.js solver also failed:", err3.message);
    }
  }

  // Try 4: Player variant fallback — yt-dlp uses alternate player.js builds
  // (TV, TCC, TCE, ES6, etc.) which may have different N-sig structures.
  // If the main player.js solver failed, try the TV player variant.
  if (!succeeded && sig.playerUrl) {
    const variantMap = {
      tv: "tv-player-ias.vflset/tv-player-ias.js",
      tce: "player_ias_tce.vflset/en_US/base.js",
      tcc: "player_ias_tcc.vflset/en_US/base.js",
      es6: "player_es6.vflset/en_US/base.js",
    };
    // Extract player version from current URL: /s/player/{version}/
    const versionMatch = sig.playerUrl.match(/\/s\/player\/([a-zA-Z0-9_-]+)\//);
    if (versionMatch) {
      const playerVersion = versionMatch[1];
      // Determine which variant we already tried
      const currentVariant = sig.playerUrl.includes("tv-player")
        ? "tv"
        : sig.playerUrl.includes("_tce")
          ? "tce"
          : sig.playerUrl.includes("_tcc")
            ? "tcc"
            : "main";

      for (const [variantName, variantPath] of Object.entries(variantMap)) {
        if (variantName === currentVariant) continue; // Skip variant we already tried
        const variantUrl = `https://www.youtube.com/s/player/${playerVersion}/${variantPath}`;
        try {
          console.log(
            `[BG] Trying player variant: ${variantName} (${variantUrl})`,
          );
          const resp = await fetch(variantUrl, { cache: "default" });
          if (!resp.ok) {
            console.log(
              `[BG] Variant ${variantName} returned HTTP ${resp.status}`,
            );
            continue;
          }
          const variantJs = await resp.text();
          if (!variantJs || variantJs.length < 5000) continue;

          const solverResult = await sandboxSolvePlayer(
            variantJs,
            variantUrl,
            decodedParams,
            [],
          );
          const { nResults, elapsed } = solverResult;
          const solvedCount = Object.keys(nResults).length;
          console.log(
            `[BG] Variant ${variantName} solver returned ${solvedCount} results in ${elapsed}ms`,
          );
          if (solvedCount > 0) {
            results = decodedParams.map((p) => nResults[p] || p);
            if (validateNSigResults(results, decodedParams)) {
              succeeded = true;
              console.log(
                `[BG] ★★★ N-sig transform succeeded (variant: ${variantName})`,
              );
              break;
            }
          }
        } catch (varErr) {
          console.warn(`[BG] Variant ${variantName} failed:`, varErr.message);
        }
      }
    }
  }

  if (!succeeded) {
    console.warn(
      "[BG] All N-sig transforms failed — downloads may be throttled. " +
        "Sniffed URLs (IDM-style) will be used if available.",
    );

    // S42 fix: Detect experimental player issues
    console.error(
      "[S42] N-sig extraction failed completely. Possible causes:\n" +
        "  1. YouTube experimental player with new algorithm\n" +
        "  2. Function signature changed (requires different arity)\n" +
        "  3. New ES syntax not supported by parser\n" +
        "Downloads will be throttled to 50 KB/s without N-sig transform.",
    );

    return false; // Signal failure to caller
  }

  // Apply successful results (O(1) lookup by itag)
  const itagMap = new Map();
  for (const f of formats) if (f.itag != null) itagMap.set(f.itag, f);
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const r = results[i];
    if (r && typeof r === "string" && r !== e.decoded) {
      const fmt = itagMap.get(e.itag);
      if (fmt)
        fmt.url = fmt.url.replace("n=" + e.raw, "n=" + encodeURIComponent(r));
    }
  }
  return true; // N-sig transform succeeded
}

async function ensureOffscreen() {
  // Offscreen API is Chrome-only; Firefox uses background pages directly
  if (typeof compat !== "undefined" && !compat.hasOffscreen) return;

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

  // S28 fix: if the offscreen exists but is hung (stuck in libav/sandbox),
  // the PONG never arrives.  The timeout must REJECT so callers know the
  // offscreen is unhealthy, rather than silently resolving and sending work
  // to a document that will never respond.
  const healthy = await Promise.race([
    new Promise((resolve) => {
      const handler = (e) => {
        if (e.data?.type === "PONG") {
          bcIn.removeEventListener("message", handler);
          resolve(true);
        }
      };
      bcIn.addEventListener("message", handler);
      bcOut.postMessage({ type: "PING" });
    }),
    new Promise((resolve) => setTimeout(() => resolve(false), 3000)),
  ]);

  if (!healthy) {
    console.warn(
      "[BG] Offscreen document unresponsive (no PONG within 3s) — recreating",
    );
    try {
      await chrome.offscreen.closeDocument();
    } catch {}
    try {
      await chrome.offscreen.createDocument({
        url: "offscreen/offscreen.html",
        reasons: ["IFRAME_SCRIPTING", "BLOBS", "WORKERS"],
        justification: "Recreated after unresponsive offscreen doc (S28 fix)",
      });
    } catch (e) {
      if (!e.message?.includes("Only a single offscreen")) throw e;
    }
    // Wait briefly for the fresh document to initialize
    await new Promise((r) => setTimeout(r, 500));
  }
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
    if (nm && (sig?.nSigCode || sig?.playerSource)) {
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
    try {
      if (cipherQueue.length && (cipherCode || sig?.cipherCode)) {
        const cc = cipherCode || sig.cipherCode;
        const ca = cipherArgName || sig?.cipherArgName || "a";
        console.log(
          "[BG] Tier 3 fallback: sandbox cipher eval for",
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
          if (nm) {
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
    } catch (fallbackErr) {
      console.warn(
        "[BG] Tier 3 regex fallback failed:",
        fallbackErr.message,
        "— returning formats with throttled N-sig",
      );
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
    if (Date.now() < c.expiresAt) {
      // S39 fix: Log player version for debugging multi-version issues
      const versionMatch = playerUrl.match(/\/player\/(\w+)\//);
      console.log(
        "[BG] Using cached sig for player version:",
        versionMatch?.[1] || "unknown",
      );
      return c;
    }
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
      nSigBundled = bundleNSigWithDeps(js, nSigCode);
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

  // S39 fix: Log when multiple player.js versions are cached
  const versions = new Set();
  for (const key of sigCache.keys()) {
    const match = key.match(/\/player\/(\w+)\//);
    if (match) versions.add(match[1]);
  }
  if (versions.size > 1) {
    console.warn(
      `[S39] Multiple player.js versions cached (${versions.size}): YouTube A/B testing detected`,
      Array.from(versions),
    );
  }

  // ── sigCache eviction (S26 fix) ──────────────────────────────
  // 1. Proactively purge expired entries (not just on get)
  const now = Date.now();
  for (const [key, val] of sigCache) {
    if (now >= val.expiresAt) {
      sigCache.delete(key);
      console.log("[BG] sigCache: evicted expired entry:", key);
    }
  }
  // 2. Enforce max cache size — evict oldest (earliest expiresAt) entries
  while (sigCache.size > SIG_CACHE_MAX) {
    let oldestKey = null;
    let oldestExpire = Infinity;
    for (const [key, val] of sigCache) {
      if (val.expiresAt < oldestExpire) {
        oldestExpire = val.expiresAt;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      sigCache.delete(oldestKey);
      console.log(
        "[BG] sigCache: evicted oldest entry (size cap " + SIG_CACHE_MAX + "):",
        oldestKey,
      );
    } else {
      break;
    }
  }

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
      else if (/\w+\[.+?\]\s*\(/.test(methodBody)) {
        // Lookup-array-based call (e.g. {b[f[35]]()}) — reverse variant
        types[mm[1]] = "reverse";
      } else {
        // Genuinely unrecognized method — default to reverse, log for debugging
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

  // Resolve array wrapper: if fn="eMK" and arrIdx=0, find eMK=[X,Y,Z] and use X
  if (arrIdx !== null) {
    // Try multiple patterns for array assignment
    const arrayPatterns = [
      // Standard: ;eMK=[X,Y,Z]
      new RegExp(`[,;\\n]\\s*${escRe(fn)}\\s*=\\s*\\[([\\w$,\\s]+)\\]`),
      // Var declaration: var eMK=[X,Y,Z]
      new RegExp(
        `(?:var|let|const)\\s+${escRe(fn)}\\s*=\\s*\\[([\\w$,\\s]+)\\]`,
      ),
      // Start of line: eMK=[X,Y,Z]
      new RegExp(`^\\s*${escRe(fn)}\\s*=\\s*\\[([\\w$,\\s]+)\\]`, "m"),
    ];

    let resolved = false;
    for (const pattern of arrayPatterns) {
      const am = js.match(pattern);
      if (am) {
        const items = am[1].split(",").map((i) => i.trim());
        if (items[arrIdx]) {
          const oldFn = fn;
          fn = items[arrIdx];
          console.log(`[BG] N-sig array resolved: ${oldFn}[${arrIdx}] → ${fn}`);
          resolved = true;
          break;
        }
      }
    }

    if (!resolved) {
      console.warn(
        `[BG] N-sig array resolution failed for ${fn}[${arrIdx}] - pattern not found`,
      );
      return null;
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
    // 2026 patterns: object property functions
    // obj={H:function(a){...}}
    new RegExp(`${esc}\\s*:\\s*function\\s*\\(([^)]*)\\)\\s*\\{`, "g"),
    // obj={H(a){...}} or obj={H:(a)=>{...}}
    new RegExp(`${esc}\\s*:\\s*\\(([^)]*)\\)\\s*=>\\s*\\{`, "g"),
    new RegExp(`${esc}\\s*\\(([^)]*)\\)\\s*\\{`, "g"),
  ];

  let matchCount = 0;
  for (const re of defPatterns) {
    let sm;
    while ((sm = re.exec(js)) !== null) {
      matchCount++;
      const braceIdx = sm.index + sm[0].lastIndexOf("{");
      let body = extractBraceBlock(js, braceIdx);
      if (!body) continue;

      // 2026 fix: Handle wrapper functions (e.g., Y$K calls g.realFunc)
      // If body is small (< 150) but looks like a wrapper, extract the real function
      let resolvedParams = null;
      if (body.length < 150) {
        // Pattern 1: Wrapper calls object method: {return g.someFunc(a)}
        let wrapperMatch = body.match(
          /\{\s*return\s+([a-zA-Z0-9$_]+)\.([a-zA-Z0-9$_]+)\s*\(\s*[^)]*\s*\)\s*;?\s*\}/,
        );

        if (wrapperMatch) {
          const objName = wrapperMatch[1];
          const methodName = wrapperMatch[2];
          console.log(
            `[BG] N-sig ${fn} is wrapper → ${objName}.${methodName}, body: ${body}`,
          );

          // Find the object definition closest to the wrapper (not first in file).
          // Single-letter names like 'g' match hundreds of times in minified JS,
          // so we find the LAST definition before the wrapper function.
          const objDefRe = new RegExp(
            `(?:var|let|const)\\s+${escRe(objName)}\\s*=\\s*\\{`,
            "g",
          );
          let objDefMatch = null;
          let _odm;
          let matchesBeforeWrapper = 0;
          let matchesAfterWrapper = 0;
          while ((_odm = objDefRe.exec(js)) !== null) {
            if (_odm.index > sm.index) {
              matchesAfterWrapper++;
              break;
            }
            matchesBeforeWrapper++;
            objDefMatch = _odm;
          }
          console.log(
            `[BG] N-sig object ${objName} search: ${matchesBeforeWrapper} matches before wrapper @ ${sm.index}, ${matchesAfterWrapper} after`,
          );
          if (objDefMatch) {
            console.log(
              `[BG] N-sig using ${objName} definition @ ${objDefMatch.index} (${sm.index - objDefMatch.index} chars before wrapper)`,
            );
            const objBraceIdx =
              objDefMatch.index + objDefMatch[0].lastIndexOf("{");
            const objBody = extractBraceBlock(js, objBraceIdx);

            if (objBody) {
              console.log(
                `[BG] N-sig object ${objName} body extracted: ${objBody.length}ch, searching for method ${methodName}`,
              );
              // Extract the specific method from the object
              // Try multiple method definition patterns
              const methodPatterns = [
                new RegExp(
                  `${escRe(methodName)}\\s*:\\s*function\\s*\\(([^)]*)\\)\\s*\\{`,
                ),
                new RegExp(`${escRe(methodName)}\\s*\\(([^)]*)\\)\\s*\\{`), // ES6 shorthand
                new RegExp(
                  `${escRe(methodName)}\\s*:\\s*\\(([^)]*)\\)\\s*=>\\s*\\{`,
                ), // Arrow function
              ];

              let methodMatch = null;
              for (const methodPattern of methodPatterns) {
                methodMatch = objBody.match(methodPattern);
                if (methodMatch) {
                  console.log(
                    `[BG] N-sig found method ${methodName} using pattern: ${methodPattern}`,
                  );
                  const methodBraceIdx =
                    objBody.indexOf(methodMatch[0]) +
                    methodMatch[0].lastIndexOf("{");
                  const methodBody = extractBraceBlock(objBody, methodBraceIdx);
                  if (methodBody && methodBody.length >= 150) {
                    // Return self-contained code with object definition
                    const code =
                      `var ${objName}=${objBody};` +
                      `return ${objName}.${methodName}(${sm[1]});`;
                    console.log(
                      `[BG] N-sig wrapper resolved: ${objName}.${methodName} (${code.length}ch)`,
                    );
                    return `function(${sm[1]}){${code}}`;
                  } else {
                    console.log(
                      `[BG] N-sig method ${methodName} too small: ${methodBody ? methodBody.length : 0}ch`,
                    );
                  }
                  break;
                }
              }
              if (!methodMatch) {
                console.warn(
                  `[BG] N-sig method ${methodName} not found in object ${objName}. Object preview: ${objBody.slice(0, 500)}...`,
                );
              }
            } else {
              console.warn(
                `[BG] N-sig object ${objName} body extraction failed at index ${objDefMatch.index}`,
              );
            }
          } else {
            console.warn(`[BG] N-sig object ${objName} not found in player.js`);
          }
        }

        // Pattern 2: Wrapper calls standalone function: {return someFunc(a)}
        // Note: Must NOT match object methods (already handled above)
        if (!wrapperMatch) {
          wrapperMatch = body.match(
            /\{\s*return\s+(?!\w+\.)([a-zA-Z0-9$_]+)\s*\(\s*[^)]*\s*\)\s*;?\s*\}/,
          );
        }

        // Pattern 3: Wrapper calls array element: {return g[0](a)}
        if (!wrapperMatch) {
          wrapperMatch = body.match(
            /\{\s*return\s+([a-zA-Z0-9$_]+)\[(\d+)\]\s*\(\s*[^)]*\s*\)\s*;?\s*\}/,
          );
          if (wrapperMatch) {
            const arrName = wrapperMatch[1];
            const arrIdx = parseInt(wrapperMatch[2]);
            console.log(
              `[BG] N-sig ${fn} is array wrapper → ${arrName}[${arrIdx}]`,
            );

            // Resolve array: find arrName = [X, Y, Z] and get element at arrIdx
            const arrDefPatterns = [
              new RegExp(
                `[,;\\n]\\s*${escRe(arrName)}\\s*=\\s*\\[([\\w$,\\s]+)\\]`,
              ),
              new RegExp(
                `(?:var|let|const)\\s+${escRe(arrName)}\\s*=\\s*\\[([\\w$,\\s]+)\\]`,
              ),
            ];
            let resolvedFuncName = null;
            for (const ap of arrDefPatterns) {
              const am = js.match(ap);
              if (am) {
                const items = am[1].split(",").map((i) => i.trim());
                if (items[arrIdx]) {
                  resolvedFuncName = items[arrIdx];
                  break;
                }
              }
            }
            if (resolvedFuncName) {
              console.log(
                `[BG] N-sig array ${arrName}[${arrIdx}] → ${resolvedFuncName}`,
              );
              // Now use findFunctionDefinition to resolve the actual function
              const arrFuncDef = findFunctionDefinition(js, resolvedFuncName);
              if (
                arrFuncDef &&
                arrFuncDef.body &&
                arrFuncDef.body.length >= 150
              ) {
                console.log(
                  `[BG] N-sig array wrapper resolved: ${resolvedFuncName} (${arrFuncDef.body.length}ch)`,
                );
                body = arrFuncDef.body;
                resolvedParams = arrFuncDef.params;
              } else {
                console.warn(
                  `[BG] N-sig array target ${resolvedFuncName} not found or too small`,
                );
              }
            } else {
              console.warn(`[BG] N-sig array ${arrName} definition not found`);
            }
            // Clear wrapperMatch so Pattern 2 fallback below doesn't re-trigger
            wrapperMatch = null;
          }
        }

        // Pattern 4: Multi-statement wrapper: {a=someFunc(a);return a} or {var b=g.f(a);return b}
        if (!wrapperMatch && body.length < 150) {
          const multiMatch = body.match(
            /\{\s*(?:var\s+)?\w+\s*=\s*(?:([a-zA-Z0-9$_]+)\.([a-zA-Z0-9$_]+)|(?!\w+\.)([a-zA-Z0-9$_]+))\s*\(\s*[^)]*\s*\)\s*;\s*return\s+\w+\s*;?\s*\}/,
          );
          if (multiMatch) {
            if (multiMatch[1] && multiMatch[2]) {
              // Object method: a = g.transform(a); return a
              // Re-use Pattern 1 logic — set up wrapperMatch-like state
              const objName = multiMatch[1];
              const methodName = multiMatch[2];
              console.log(
                `[BG] N-sig ${fn} is multi-stmt wrapper → ${objName}.${methodName}`,
              );
              // Fake a Pattern 1 match to let the code above handle it on retry
              // Instead, directly replicate the object resolution here
              const objDefRe2 = new RegExp(
                `(?:var|let|const)\\s+${escRe(objName)}\\s*=\\s*\\{`,
                "g",
              );
              let objDefMatch2 = null,
                _odm2;
              while ((_odm2 = objDefRe2.exec(js)) !== null) {
                if (_odm2.index > sm.index) break;
                objDefMatch2 = _odm2;
              }
              if (objDefMatch2) {
                const objBraceIdx2 =
                  objDefMatch2.index + objDefMatch2[0].lastIndexOf("{");
                const objBody2 = extractBraceBlock(js, objBraceIdx2);
                if (objBody2) {
                  const mp = [
                    new RegExp(
                      `${escRe(methodName)}\\s*:\\s*function\\s*\\(([^)]*)\\)\\s*\\{`,
                    ),
                    new RegExp(`${escRe(methodName)}\\s*\\(([^)]*)\\)\\s*\\{`),
                  ];
                  for (const mre of mp) {
                    const mm = objBody2.match(mre);
                    if (mm) {
                      const mbi =
                        objBody2.indexOf(mm[0]) + mm[0].lastIndexOf("{");
                      const mb = extractBraceBlock(objBody2, mbi);
                      if (mb && mb.length >= 150) {
                        const code = `var ${objName}=${objBody2};return ${objName}.${methodName}(${sm[1]});`;
                        console.log(
                          `[BG] N-sig multi-stmt wrapper resolved: ${objName}.${methodName} (${code.length}ch)`,
                        );
                        return `function(${sm[1]}){${code}}`;
                      }
                      break;
                    }
                  }
                }
              }
            } else if (multiMatch[3]) {
              // Standalone function: a = someFunc(a); return a
              console.log(
                `[BG] N-sig ${fn} is multi-stmt standalone wrapper → ${multiMatch[3]}`,
              );
              wrapperMatch = [multiMatch[0], multiMatch[3]];
              // Fall through to Pattern 2 resolution below
            }
          }
        }

        if (wrapperMatch && wrapperMatch[1]) {
          const realFuncName = wrapperMatch[1];
          // Skip if we already handled object method pattern
          if (!wrapperMatch[0].includes(".")) {
            console.log(
              `[BG] N-sig ${fn} is standalone wrapper → ${realFuncName}`,
            );

            // Find the real function definition — use proximity search
            // (last match BEFORE the wrapper, not first in file)
            const realFnEsc = escRe(realFuncName);
            const realFnPatterns = [
              new RegExp(
                `(?:^|[;,\\n])\\s*${realFnEsc}\\s*=\\s*function\\s*\\(([^)]*)\\)\\s*\\{`,
                "gm",
              ),
              new RegExp(
                `function\\s+${realFnEsc}\\s*\\(([^)]*)\\)\\s*\\{`,
                "g",
              ),
              new RegExp(
                `(?:var|let|const)\\s+${realFnEsc}\\s*=\\s*function\\s*\\(([^)]*)\\)\\s*\\{`,
                "g",
              ),
            ];

            let bestMatch = null;
            for (const realRe of realFnPatterns) {
              let rm;
              while ((rm = realRe.exec(js)) !== null) {
                const realBraceIdx = rm.index + rm[0].lastIndexOf("{");
                const realBody = extractBraceBlock(js, realBraceIdx);
                if (realBody && realBody.length >= 150) {
                  // Prefer the last match before the wrapper (closest preceding def),
                  // fall back to first match after if none exist before
                  if (!bestMatch) {
                    bestMatch = {
                      index: rm.index,
                      body: realBody,
                      params: rm[1],
                    };
                  } else if (
                    rm.index <= sm.index &&
                    rm.index > bestMatch.index
                  ) {
                    // Closer before the wrapper — always better
                    bestMatch = {
                      index: rm.index,
                      body: realBody,
                      params: rm[1],
                    };
                  } else if (
                    bestMatch.index > sm.index &&
                    rm.index < bestMatch.index
                  ) {
                    // Both after wrapper — pick the closer one
                    bestMatch = {
                      index: rm.index,
                      body: realBody,
                      params: rm[1],
                    };
                  }
                }
              }
            }
            if (bestMatch) {
              console.log(
                `[BG] N-sig resolved ${realFuncName}: ${bestMatch.body.length}ch (${bestMatch.index < sm.index ? "before" : "after"} wrapper @ ${sm.index - bestMatch.index} chars)`,
              );
              body = bestMatch.body;
              resolvedParams = bestMatch.params;
            } else {
              console.warn(
                `[BG] N-sig standalone function ${realFuncName} not resolved`,
              );
            }
          }
        }

        // Still too small after wrapper check
        if (body.length < 150) {
          console.log(
            `[BG] N-sig candidate ${fn} skipped: too small (${body.length}ch)`,
          );
          continue;
        }
      }

      // 2026 fix: YouTube N-sig functions evolved - relax validation
      // New: accept any function 150+ chars with basic complexity indicators

      // Accept if any of these complexity indicators are present:
      const hasTryCatch = /try\s*\{/.test(body);
      const hasArrayIndex = /\[\s*\d+\s*\]/.test(body);
      const hasStringOps = /\.split\(|\.join\(|\.slice\(/.test(body);
      const hasLoops = /for\s*\(|while\s*\(/.test(body);
      const isLargeEnough = body.length >= 300;

      if (
        !hasTryCatch &&
        !hasArrayIndex &&
        !hasStringOps &&
        !hasLoops &&
        !isLargeEnough
      ) {
        console.log(
          `[BG] N-sig candidate ${fn} skipped: no complexity indicators (${body.length}ch)`,
        );
        continue;
      }

      const params = resolvedParams || sm[1];
      let code = `function(${params})${body}`;

      const arg0 = params.split(",")[0].trim();
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
        "| try/catch:",
        hasTryCatch,
        "| array[]:",
        hasArrayIndex,
      );
      return code;
    }
  }

  console.warn(
    `[BG] N-sig function definition not found or too small for: ${fn} (checked ${matchCount} potential matches)`,
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

function bundleNSigWithDeps(js, preExtractedNSigCode) {
  // Step 1: Use pre-extracted code if available, otherwise extract (avoid duplicate work)
  const nSigCode = preExtractedNSigCode || extractNSigCode(js);
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
    // NOTE: We intentionally only match identifiers followed by (, [, or .prop
    // to avoid pulling in local variables/params as false dependencies.
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

  // Collect ALL candidates across all patterns, then pick the best one
  // (largest body). Short minified names can match multiple definitions;
  // returning the first hit could pick a tiny unrelated function.
  let best = null;
  for (const re of patterns) {
    let m;
    while ((m = re.exec(js)) !== null) {
      const braceIdx = m.index + m[0].lastIndexOf("{");
      const body = extractBraceBlock(js, braceIdx);
      if (!body) continue;
      // Skip very tiny matches (likely false positives)
      if (body.length < 10) continue;

      if (!best || body.length > best.body.length) {
        best = {
          params: m[1],
          body,
          startIdx: m.index,
          endIdx: braceIdx + body.length,
        };
      }
    }
  }
  if (best) {
    const fullCode = `var ${name} = function(${best.params})${best.body};`;
    return {
      code: fullCode,
      body: best.body,
      params: best.params,
      startIdx: best.startIdx,
      endIdx: best.endIdx,
    };
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
// Service Worker Keepalive during worker downloads
// Same pattern as merge keepalive — counts active workers and
// starts/stops one shared interval.
// ============================================================
function startWorkerKeepalive() {
  activeWorkerCount++;
  if (!workerKeepaliveTimer) {
    workerKeepaliveTimer = setInterval(chrome.runtime.getPlatformInfo, 25000);
    console.log("[BG] Worker download keepalive started");
  }
  startWorkerHealthCheck();
}

function stopWorkerKeepalive() {
  activeWorkerCount = Math.max(0, activeWorkerCount - 1);
  if (activeWorkerCount === 0 && workerKeepaliveTimer) {
    clearInterval(workerKeepaliveTimer);
    workerKeepaliveTimer = null;
    console.log("[BG] Worker download keepalive stopped");
  }
  if (activeWorkerCount === 0 && workerHealthCheckTimer) {
    clearInterval(workerHealthCheckTimer);
    workerHealthCheckTimer = null;
  }
}

// ============================================================
// Offscreen Health Check during Worker Downloads
// If Chrome kills the offscreen document under memory pressure,
// WORKER_COMPLETE never arrives and the download hangs forever.
// Periodically verify offscreen is still alive; if dead, mark
// all in-flight worker downloads as failed.
// ============================================================
function startWorkerHealthCheck() {
  if (workerHealthCheckTimer) return;
  workerHealthCheckTimer = setInterval(async () => {
    if (activeWorkerCount === 0) {
      clearInterval(workerHealthCheckTimer);
      workerHealthCheckTimer = null;
      return;
    }
    try {
      const contexts = await chrome.runtime.getContexts?.({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
      });
      if (contexts && contexts.length === 0) {
        console.warn(
          "[BG] Offscreen document died during worker downloads — cleaning up",
        );
        clearInterval(workerHealthCheckTimer);
        workerHealthCheckTimer = null;
        activeWorkerCount = 0;
        if (workerKeepaliveTimer) {
          clearInterval(workerKeepaliveTimer);
          workerKeepaliveTimer = null;
        }
        // Mark all in-flight worker downloads as failed
        chrome.storage.session.get("activeDownloads", (result) => {
          const downloads = result?.activeDownloads || {};
          let changed = false;
          for (const [id, dl] of Object.entries(downloads)) {
            if (
              dl.phase === "starting" ||
              dl.phase === "downloading" ||
              dl.phase === "transmuxing" ||
              dl.phase === "merging"
            ) {
              downloads[id] = {
                ...dl,
                phase: "error",
                message: "Download interrupted (offscreen document was killed)",
                ts: Date.now(),
              };
              changed = true;
            }
          }
          if (changed) {
            chrome.storage.session
              .set({ activeDownloads: downloads })
              .catch(() => {});
          }
        });
      }
    } catch {
      // getContexts not supported (Firefox) — skip check
    }
  }, 10000); // Check every 10 seconds
}

// ============================================================
// Service Worker Keepalive during format resolution
// getFormats → getFormatsInner → sandboxSolvePlayer can take
// 10-35 seconds.  Without a keepalive Chrome's 30-second idle
// timer can kill the SW mid-Promise.
// ============================================================
function startFormatKeepalive() {
  activeFormatCount++;
  if (!formatKeepaliveTimer) {
    formatKeepaliveTimer = setInterval(chrome.runtime.getPlatformInfo, 25000);
    console.log("[BG] Format resolution keepalive started");
  }
}

function stopFormatKeepalive() {
  activeFormatCount = Math.max(0, activeFormatCount - 1);
  if (activeFormatCount === 0 && formatKeepaliveTimer) {
    clearInterval(formatKeepaliveTimer);
    formatKeepaliveTimer = null;
    console.log("[BG] Format resolution keepalive stopped");
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

  // Cancel any pending delayed removal from a previous merge's finally block
  if (pendingMergeRemoveTimer) {
    clearTimeout(pendingMergeRemoveTimer);
    pendingMergeRemoveTimer = null;
  }

  // Claim the merge slot BEFORE any async work to prevent concurrent merges
  const mergeId = Date.now().toString();
  activeMergeId = mergeId;

  try {
    await ensureOffscreen();
  } catch (e) {
    activeMergeId = null;
    throw e;
  }

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
        async (response) => {
          clearTimeout(timeout);
          if (chrome.runtime.lastError) {
            const errMsg = chrome.runtime.lastError.message;
            console.error("[BG] Merge message error:", errMsg);

            // S38 fix: Detect memory pressure (OOM kills offscreen)
            const isOOM =
              errMsg.includes("message port closed") ||
              errMsg.includes("Could not establish connection");

            if (isOOM) {
              try {
                const allTabs = await chrome.tabs.query({});
                const tabCount = allTabs.length;

                if (tabCount > 100) {
                  console.warn(
                    `[S38] High tab count detected (${tabCount}) — likely memory pressure caused OOM`,
                  );
                  resolve({
                    success: false,
                    error: `Merge failed due to memory pressure. You have ${tabCount} tabs open. Close unused tabs and try again.`,
                    isOOM: true,
                    tabCount,
                  });
                  return;
                }
              } catch (e) {
                console.warn("[S38] Failed to check tab count:", e.message);
              }
            }

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
        //   Tier 1 (InnerTube API) → Tier 2 (inject.js) → Tier S (sniffed) → Tier 3 (scrape)
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
    const finishedMergeId = mergeId;
    activeMergeId = null;
    stopMergeKeepalive();

    // Delayed removal — but guarded: only remove if no new merge has started
    pendingMergeRemoveTimer = setTimeout(() => {
      pendingMergeRemoveTimer = null;
      chrome.storage.session.get("activeMerge", (result) => {
        // Only remove if the stored merge is the one WE just finished
        if (result?.activeMerge?.mergeId === finishedMergeId) {
          chrome.storage.session.remove("activeMerge").catch(() => {});
        }
      });
    }, 10000);
  }
}

async function doDownload(url, filename) {
  filename = sanitize(filename);

  // S51 fix: Warn about potential IDM/JDownloader race conditions
  // These tools often intercept googlevideo.com URLs, leading to duplicate downloads
  if (url.includes("googlevideo.com")) {
    console.warn("[S51] Downloading from googlevideo.com.");
  }

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

// S47 fix: Monitor chrome.downloads for filesystem quota failures
// When the OS filesystem is full, chrome.downloads.download() initiates
// successfully but fails mid-write with FILE_FAILED error. The extension
// reports "success" but the file doesn't exist. Listen to onChanged to
// detect this and notify the user.
const downloadFailureTracker = new Map(); // downloadId -> {filename, notified}

chrome.downloads.onChanged.addListener((delta) => {
  // Only care about downloads that transition to interrupted state
  if (delta.state && delta.state.current === "interrupted") {
    // Check if it's a FILE_FAILED error (quota/permissions)
    if (delta.error && delta.error.current) {
      const errorCode = delta.error.current;

      // FILE_FAILED typically means: disk full, quota exceeded, or permission denied
      if (errorCode === "FILE_FAILED") {
        chrome.downloads.search({ id: delta.id }, (downloads) => {
          if (downloads && downloads.length > 0) {
            const dl = downloads[0];
            const filename = dl.filename || "unknown file";

            // Only notify once per download
            if (!downloadFailureTracker.has(delta.id)) {
              downloadFailureTracker.set(delta.id, {
                filename,
                notified: true,
              });

              console.error(
                `[BG] Download ${delta.id} failed with FILE_FAILED: ${filename} (likely disk full or quota exceeded)`,
              );

              if (chrome.notifications) {
                chrome.notifications.create(`download-failed-${delta.id}`, {
                  type: "basic",
                  iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
                  title: "Download Failed: Disk Full",
                  message: `File: ${filename}\n\nYour system drive may be out of space. Free up disk space and try again.`,
                  priority: 2,
                });
              }
            }
          }
        });
      }

      // Other potential errors to log for debugging
      if (errorCode !== "USER_CANCELED") {
        console.warn(`[BG] Download ${delta.id} interrupted: ${errorCode}`);
      }
    }
  }

  // Clean up tracker for completed downloads
  if (delta.state && delta.state.current === "complete") {
    downloadFailureTracker.delete(delta.id);
  }
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

// S43 fix: Check for orphaned downloads after crash/force-kill
// After Chrome crashes or force-kill, OPFS data survives but activeDownloads
// in memory is lost. Notify user to clean up orphaned data.
(async () => {
  try {
    const result = await chrome.storage.session.get("activeDownloads");
    const downloads = result?.activeDownloads || {};

    // Count downloads that were in progress (not complete/error)
    const orphaned = Object.entries(downloads).filter(
      ([id, dl]) =>
        dl.phase === "starting" ||
        dl.phase === "downloading" ||
        dl.phase === "merging",
    );

    if (orphaned.length > 0) {
      console.warn(
        `[BG] Found ${orphaned.length} orphaned download(s) from previous session (may have left OPFS data)`,
      );

      // Estimate potential orphaned data size (rough heuristic: 1-2 GB per large download)
      const estimatedSize = orphaned.length * 1.5; // GB

      if (chrome.notifications) {
        chrome.notifications.create("opfs-orphaned-data", {
          type: "basic",
          iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
          title: "Orphaned Download Data Detected",
          message: `${orphaned.length} download(s) were interrupted by a crash or force-kill. ~${estimatedSize.toFixed(1)} GB of temporary data may remain in storage. Open extension popup and use "Clear Storage" to clean up.`,
          priority: 1,
          buttons: [{ title: "Got it" }],
        });
      }

      // Mark them as error state for proper cleanup tracking
      const now = Date.now();
      for (const [id, dl] of orphaned) {
        downloads[id] = {
          ...dl,
          phase: "error",
          message: "Download interrupted (crash/force-kill)",
          ts: now,
          orphaned: true, // Flag for potential OPFS cleanup
        };
      }

      await chrome.storage.session.set({ activeDownloads: downloads });
    }
  } catch (e) {
    console.warn("[BG] Orphan detection failed:", e.message);
  }
})();

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

    // Known proxy/CDN domains used by streaming sites
    // Synced with generic-network-hook.js PROXY_DOMAINS list
    // Uses full domain suffixes to prevent false positives
    const PROXY_STREAM_DOMAINS = [
      "vodvidl.site",
      "rabbitstream.net",
      "megacloud.tv",
      "vidplay.site",
      "filemoon.sx",
      "dokicloud.one",
      "rapid-cloud.co",
      "vidstreaming.io",
      "trueparadise.workers.dev",
      "tigerflare.com",
      "videasy.net",
      // Additional pirate CDN/embed domains (from generic-network-hook.js)
      "streamtape.com",
      "doodstream.com",
      "mixdrop.co",
      "upstream.to",
      "streamlare.com",
      "fembed.com",
      "voe.sx",
      "streamhub.to",
      "streamsb.net",
      "vidcloud.co",
      "mycloud.to",
      "mp4upload.com",
      "evoload.io",
      "streamz.ws",
      "vidoza.net",
      "netu.tv",
      "supervideo.tv",
      "jetload.net",
      "vido.gg",
      "streamwish.to",
      "vidhide.com",
      "embedrise.com",
      "closeload.top",
      "filelions.to",
      "vidguard.to",
      "lulustream.com",
      "vembed.net",
      "multiembed.mov",
      "2embed.cc",
      "vidsrc.me",
      "autoembed.cc",
      "flixhq.to",
      "sflix.to",
      "fmovies.to",
      "gomovies.sx",
      "123movies.to",
      "putlocker.vip",
      "kinox.to",
      "primewire.li",
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
//
// Data structure: sniffedYouTubeUrls = Map(tabId → Map("videoId:itag" → data))
// Using composite key "videoId:itag" prevents URL collisions when a page
// embeds multiple YouTube videos (playlist pages, blog embeds, etc.) since
// itag values overlap between videos (e.g., all have itag 140 for audio).
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

      // Extract video ID from the googlevideo.com URL's "id" parameter.
      // Format is typically "o-<hash>.<videoId>.<number>" or just the video ID.
      // Falls back to "unknown" if not parseable (single-video pages still work).
      let videoId = "unknown";
      const idParam = url.searchParams.get("id");
      if (idParam) {
        // Try to extract 11-char YouTube video ID from the id parameter
        const match = idParam.match(/([A-Za-z0-9_-]{11})/);
        if (match) videoId = match[1];
      }

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

      // Use composite key "videoId:itag" to prevent collisions between
      // different embedded videos that share the same itag numbers
      const sniffKey = `${videoId}:${itag}`;
      tabSniffed.set(sniffKey, {
        url: cleanUrl.toString(),
        mime,
        clen,
        dur,
        expire,
        ts: Date.now(),
        videoId,
        itag,
      });

      console.log(
        `[YT-SNIFF] Captured itag ${itag} video=${videoId} (${mime}) on tab ${details.tabId}`,
        `— ${tabSniffed.size} URLs total`,
      );
    } catch {
      // ignore parse errors
    }
  },
  { urls: ["*://*.googlevideo.com/*"] },
);

// S48: Validate that a sniffed URL is not affected by system time manipulation.
// Returns { valid: boolean, reason?: string }
function validateSniffedUrlTime(data, nowSeconds) {
  if (!data.expire) {
    // No expire timestamp — can't validate, assume valid
    return { valid: true };
  }

  // Use trusted time reference: performance.timeOrigin is fixed at page load,
  // performance.now() increments monotonically (pauses during sleep but never jumps)
  const trustedNowMs = performance.timeOrigin + performance.now();
  const trustedNowSeconds = Math.floor(trustedNowMs / 1000);

  // Check if URL is expired (based on trusted time)
  if (data.expire < trustedNowSeconds) {
    return { valid: false, reason: "URL expired" };
  }

  // Check if system time was moved backward (current time < capture time)
  // This is impossible unless the user manipulated their clock
  if (data.ts && nowSeconds < Math.floor(data.ts / 1000) - 5) {
    // Allow 5 second tolerance for clock drift/precision
    console.warn(
      `[S48] System time anomaly detected: current time (${nowSeconds}) is before URL capture time (${Math.floor(data.ts / 1000)}). User may have moved clock backward.`,
    );
    return {
      valid: false,
      reason: "System time moved backward (clock manipulation detected)",
    };
  }

  // Check if system time was moved suspiciously far forward
  // YouTube URLs typically expire in 6 hours, so if current time is >24 hours
  // after capture but before expire, the user likely moved clock forward
  const ONE_DAY = 86400; // 24 hours in seconds
  if (
    data.ts &&
    nowSeconds > Math.floor(data.ts / 1000) + ONE_DAY &&
    data.expire > nowSeconds + 3600
  ) {
    // Current time is >24h after capture, but URL still valid for >1h
    console.warn(
      `[S48] System time anomaly: URL captured ${Math.floor((nowSeconds - data.ts / 1000) / 3600)}h ago but still valid for ${Math.floor((data.expire - nowSeconds) / 3600)}h (typical: 6h lifetime). Clock may have moved forward.`,
    );
    // Don't invalidate — just log suspicion (could be legitimate long-lived URL)
  }

  // Compare Date.now() vs trusted time (detect if Date.now() was tampered)
  const timeDiff = Math.abs(nowSeconds - trustedNowSeconds);
  if (timeDiff > 300) {
    // >5 minute discrepancy between Date.now() and performance.now()
    console.warn(
      `[S48] System time discrepancy: Date.now() differs from trusted time by ${timeDiff}s. Using trusted time for validation.`,
    );
    // Use trusted time for final decision
    if (data.expire < trustedNowSeconds) {
      return { valid: false, reason: "URL expired (trusted time)" };
    }
  }

  return { valid: true };
}

// Build format objects from sniffed YouTube URLs using ITAG_MAP metadata.
// Returns an array of format objects compatible with the existing format pipeline.
// When videoId is provided, only returns formats for that specific video
// (prevents Frankenstein mixes from multi-video embed pages).
function buildSniffedFormats(tabId, videoId) {
  const tabSniffed = sniffedYouTubeUrls.get(tabId);
  if (!tabSniffed || tabSniffed.size === 0) return [];

  const formats = [];
  const now = Math.floor(Date.now() / 1000);

  for (const [sniffKey, data] of tabSniffed) {
    // sniffKey format: "videoId:itag"
    const itag = data.itag ?? parseInt(sniffKey.split(":").pop());

    // Filter by videoId if specified — prevents mixing URLs from different videos
    if (
      videoId &&
      data.videoId &&
      data.videoId !== "unknown" &&
      data.videoId !== videoId
    ) {
      continue;
    }

    // S48: Validate URL freshness with system time manipulation detection
    const timeValidation = validateSniffedUrlTime(data, now);
    if (!timeValidation.valid) {
      console.warn(
        `[S48] Skipping sniffed URL for itag ${itag}: ${timeValidation.reason}`,
      );
      continue;
    }

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
// When videoId is provided, only matches sniffed URLs for that specific video
// to prevent replacing with URLs from a different embedded video.
function enrichFormatsWithSniffed(formats, tabId, videoId) {
  const tabSniffed = sniffedYouTubeUrls.get(tabId);
  if (!tabSniffed || tabSniffed.size === 0) return 0;

  const now = Math.floor(Date.now() / 1000);
  let replaced = 0;

  for (const fmt of formats) {
    // Try composite key "videoId:itag" first (specific video match)
    let sniffed = null;
    if (videoId) {
      sniffed = tabSniffed.get(`${videoId}:${fmt.itag}`);
    }
    // Fallback: try "unknown:itag" for entries where videoId wasn't extractable
    if (!sniffed) {
      sniffed = tabSniffed.get(`unknown:${fmt.itag}`);
    }
    // Fallback: scan all entries for matching itag (backwards compat)
    if (!sniffed) {
      for (const [, data] of tabSniffed) {
        if (data.itag === fmt.itag) {
          // Only use if videoId matches or no filter
          if (
            !videoId ||
            !data.videoId ||
            data.videoId === "unknown" ||
            data.videoId === videoId
          ) {
            sniffed = data;
            break;
          }
        }
      }
    }
    if (!sniffed) continue;

    // S48: Validate URL freshness with system time manipulation detection
    const timeValidation = validateSniffedUrlTime(sniffed, now);
    if (!timeValidation.valid) {
      console.warn(
        `[S48] Skipping sniffed URL replacement for itag ${fmt.itag}: ${timeValidation.reason}`,
      );
      continue;
    }

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

          // Relay blob video detections from generic-network-hook
          if (
            event.data.type === "__generic_extractor__" &&
            event.data.isBlobVideo &&
            event.data.blobUrl
          ) {
            try {
              chrome.runtime.sendMessage({
                action: "BLOB_VIDEO_DETECTED",
                blobUrl: event.data.blobUrl,
                blobType: event.data.blobType || "video/mp4",
                blobSize: event.data.blobSize || 0,
                frameUrl: window.location.href,
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

/**
 * Fetch an HLS master playlist, parse its variants, and return per-quality
 * format entries.  Falls back to an empty array if the URL points to a media
 * playlist or the fetch fails.
 */
async function parseHLSVariants(masterUrl, mimeType) {
  try {
    const resp = await fetch(masterUrl, { cache: "no-cache" });
    if (!resp.ok) return [];
    const text = await resp.text();

    // Not a master playlist — single bitrate stream
    if (!text.includes("#EXT-X-STREAM-INF")) return [];

    const baseUrl = masterUrl.substring(0, masterUrl.lastIndexOf("/") + 1);
    const lines = text.split("\n").map((l) => l.trim());
    const variants = [];

    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith("#EXT-X-STREAM-INF:")) continue;

      const attrStr = lines[i].substring("#EXT-X-STREAM-INF:".length);
      const attrs = {};
      // Simple attribute parser for BANDWIDTH, RESOLUTION, CODECS, etc.
      for (const m of attrStr.matchAll(/([\w-]+)=(?:"([^"]*)"|([^,]*))/g)) {
        attrs[m[1]] = m[2] !== undefined ? m[2] : m[3];
      }

      let url = null;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j] && !lines[j].startsWith("#")) {
          url = lines[j];
          break;
        }
      }
      if (!url) continue;
      // Resolve relative URLs
      if (!/^https?:\/\//i.test(url)) {
        url = url.startsWith("/")
          ? new URL(url, masterUrl).href
          : baseUrl + url;
      }

      const bw = parseInt(attrs.BANDWIDTH) || 0;
      const res = attrs.RESOLUTION || "";
      const [w, h] = res.split("x").map(Number);
      const label = h ? `${h}p` : bw ? `${Math.round(bw / 1000)}k` : "Auto";

      variants.push({
        url,
        bandwidth: bw,
        width: w || 0,
        height: h || 0,
        resolution: res,
        codecs: attrs.CODECS || "",
        label,
      });
    }

    if (variants.length === 0) return [];

    // Sort by bandwidth descending (highest quality first)
    variants.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));

    console.log(
      `[BG] Parsed ${variants.length} HLS quality variants from master playlist`,
    );

    return variants.map((v, idx) => ({
      url: v.url,
      itag: `hls-${v.height || v.bandwidth || idx}`,
      mimeType,
      quality: v.label,
      qualityLabel: `${v.label}${v.codecs ? " · " + v.codecs.split(",")[0] : ""}`,
      width: v.width,
      height: v.height,
      bandwidth: v.bandwidth,
      isVideo: true,
      isMuxed: true,
      ext: "mp4",
      isHLS: true,
    }));
  } catch (e) {
    console.warn("[BG] Failed to parse HLS master playlist:", e.message);
    return [];
  }
}

async function onSpecialistDetected(msg, tabId) {
  console.log("[BG] Specialist detected:", msg.protocol, "tab:", tabId);

  // Discard stale detections from MAIN-world hooks that fired after
  // an SPA navigation (S15 race condition). Compare the message's
  // pageUrl against the tab's current URL.
  if (msg.pageUrl && tabId) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab?.url && msg.pageUrl !== tab.url) {
        console.debug(
          `[BG] Dropping stale specialist detection: msg URL ${msg.pageUrl.substring(0, 60)} ≠ tab URL ${tab.url.substring(0, 60)}`,
        );
        return { success: false, error: "Stale detection (SPA navigated)" };
      }
    } catch {
      // Tab may have closed — proceed anyway
    }
  }

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
    } else if (
      (videoType === "HLS" || videoType === "M3U8") &&
      /\.m3u8(\?|#|$)/i.test(videoUrl)
    ) {
      // Try to fetch master playlist and parse quality variants
      formats = await parseHLSVariants(videoUrl, mimeType);
      if (formats.length === 0) {
        // Fallback: single format entry (media playlist or fetch failed)
        formats.push({
          url: videoUrl,
          mimeType,
          quality: "auto",
          qualityLabel: "HLS (best quality)",
          isVideo: true,
          isMuxed: true,
          ext: "mp4",
          isHLS: true,
        });
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

  // For HLS formats, try to parse the master playlist to extract quality variants
  const hlsFormats = formats.filter((f) => f.isHLS && f.url);
  if (hlsFormats.length > 0) {
    for (const hlsFmt of hlsFormats) {
      try {
        const variants = await parseHLSMasterPlaylist(hlsFmt.url);
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
async function parseHLSMasterPlaylist(masterUrl) {
  try {
    const resp = await fetch(masterUrl);
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
    if (videoFormats.length === 0 && imageFormats.length > 0) {
      info.formats = [newFormat];
    } else {
      info.formats = [...videoFormats, newFormat];
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
const SESSION_RULE_SAFETY_MARGIN = 500; // Trigger cleanup when within this margin of limit
const MAX_SESSION_RULES = 5000; // Chrome's MAX_NUMBER_OF_SESSION_RULES
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

  // Proactive cleanup: if approaching Chrome's 5000 session rule limit,
  // purge old session header rules to prevent silent failures.
  try {
    const existingRules =
      await chrome.declarativeNetRequest?.getSessionRules?.();
    if (
      existingRules &&
      existingRules.length >= MAX_SESSION_RULES - SESSION_RULE_SAFETY_MARGIN
    ) {
      // Find session header rules (id >= SESSION_HEADER_BASE) that are likely orphaned
      const sessionRuleIds = existingRules
        .filter((r) => r.id >= SESSION_HEADER_BASE)
        .map((r) => r.id)
        .sort((a, b) => a - b);
      // Keep the newest 100, purge the rest
      const toRemove = sessionRuleIds.slice(0, sessionRuleIds.length - 100);
      if (toRemove.length > 0) {
        await chrome.declarativeNetRequest?.updateSessionRules?.({
          removeRuleIds: toRemove,
        });
        console.warn(
          `[BG] Purged ${toRemove.length} old session header rules (approaching ${MAX_SESSION_RULES} limit)`,
        );
      }
    }
  } catch {
    // getSessionRules may not be available (Firefox)
  }

  const rule = {
    id: ruleId,
    priority: 2,
    action: { type: "modifyHeaders", requestHeaders },
    condition: {
      urlFilter: urlPattern,
      resourceTypes: ["xmlhttprequest", "media", "other"],
    },
  };

  // S30 fix: CDN redirect chains (e.g., cdn.example.com → edge.akamai.net)
  // cause auth headers to be stripped because the DNR rule only matches the
  // original host.  Add a second, broader rule that catches redirect targets.
  // We extract the path pattern from the original urlFilter and create a
  // permissive rule for the same resource types.  Both rules are short-lived
  // (removed after download) so the broad match is safe.
  let redirectRuleId = null;
  try {
    // Extract just the host from the pattern for initiatorDomains
    const hostMatch = urlPattern.match(/^\|\|([^/]+)/);
    if (hostMatch) {
      redirectRuleId = SESSION_HEADER_BASE + ++sessionHeaderCounter;
      const redirectRule = {
        id: redirectRuleId,
        priority: 1, // lower priority than the host-specific rule
        action: { type: "modifyHeaders", requestHeaders },
        condition: {
          // Broad filter — matches any media/XHR request initiated from our
          // target domain.  This covers CDN edge redirects that switch hosts.
          initiatorDomains: [hostMatch[1]],
          resourceTypes: ["xmlhttprequest", "media", "other"],
        },
      };
      await chrome.declarativeNetRequest.updateSessionRules?.({
        addRules: [redirectRule],
      });
      console.log("[BG] Added redirect-covering rule, ruleId:", redirectRuleId);
    }
  } catch (e) {
    console.warn("[BG] Failed to add redirect header rule:", e.message);
    redirectRuleId = null;
  }

  try {
    await chrome.declarativeNetRequest.updateSessionRules?.({
      addRules: [rule],
    });
  } catch (e) {
    console.error(
      `[BG] Failed to add session header rule ${ruleId}:`,
      e.message,
    );
    return { primaryId: ruleId, redirectId: redirectRuleId };
  }

  console.log("[BG] Added session headers, ruleId:", ruleId);
  return { primaryId: ruleId, redirectId: redirectRuleId };
}

async function removeSessionHeaders(ruleId) {
  if (!ruleId) return;
  // S30 fix: ruleId may be an object { primaryId, redirectId } from the
  // updated addSessionHeaders, or a plain number from legacy callers.
  const ids = [];
  if (typeof ruleId === "object" && ruleId !== null) {
    if (ruleId.primaryId) ids.push(ruleId.primaryId);
    if (ruleId.redirectId) ids.push(ruleId.redirectId);
  } else {
    ids.push(ruleId);
  }
  if (ids.length === 0) return;
  await chrome.declarativeNetRequest
    ?.updateSessionRules({ removeRuleIds: ids })
    .catch(() => {});
  console.log("[BG] Removed session header rule(s):", ids);
}

async function handleWorkerDownload(msg) {
  const { url, type, filename, headers, tabId, videoTitle, videoThumbnail } =
    msg;

  if (!url) throw new Error("URL required for worker download");

  await ensureOffscreen();

  const downloadId =
    "dl_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6);

  // Keep the service worker alive for the duration of this download
  startWorkerKeepalive();

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
      tabId, // S35 fix: Pass tabId for URL refresh
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
    };
    chrome.storage.session.set({ activeDownloads: downloads }).catch(() => {});
  });

  return { success: true, downloadId };
}

/**
 * S35 fix: Refresh YouTube format URLs mid-download when they expire.
 * Re-calls getFormats() for the tab and builds a URL map (old -> new).
 */
async function handleRefreshYouTubeUrls(msg) {
  const { tabId, downloadId } = msg;

  if (!tabId) {
    console.warn("[BG] URL refresh requested but no tabId provided");
    return { success: false, error: "No tabId" };
  }

  console.log(
    `[BG] Refreshing YouTube URLs for tab ${tabId} (download ${downloadId})`,
  );

  try {
    const data = tabData.get(tabId);
    if (!data) {
      return { success: false, error: "No tab data found" };
    }

    // Store old formats
    const oldFormats = data.formats || [];

    // Force fresh format resolution (bypass cache)
    const freshData = await getFormats(data.url, tabId, data.videoId);

    if (!freshData?.formats || freshData.formats.length === 0) {
      return { success: false, error: "No fresh formats available" };
    }

    // Build URL map: old URL -> new URL by matching itag
    const urlMap = {};
    for (const oldFmt of oldFormats) {
      const newFmt = freshData.formats.find((f) => f.itag === oldFmt.itag);
      if (newFmt && newFmt.url !== oldFmt.url) {
        urlMap[oldFmt.url] = newFmt.url;
      }
    }

    console.log(`[BG] URL refresh: ${Object.keys(urlMap).length} URLs updated`);

    // Update tabData with fresh formats
    tabData.set(tabId, { ...data, ...freshData });
    persistTabData();

    return { success: true, urlMap };
  } catch (err) {
    console.error("[BG] URL refresh failed:", err);
    return { success: false, error: err.message };
  }
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
