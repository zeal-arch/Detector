const ICONS = {
  download: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
  stop: `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`,
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
  fileVideo: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><path d="m10 11 5 3-5 3v-6z"/></svg>`,
  error: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
  folder: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`,
};

function formatSize(bytes) {
  if (!bytes) return "";
  const n = Number(bytes);
  if (isNaN(n) || n <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let size = n,
    idx = 0;
  while (size >= 1024 && idx < units.length - 1) {
    size /= 1024;
    idx++;
  }
  return `${size.toFixed(1)} ${units[idx]}`;
}

function formatDuration(seconds) {
  if (!seconds) return "";
  const s = Number(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    : `${m}:${String(sec).padStart(2, "0")}`;
}

function getQualityLabel(f) {
  if (f.qualityLabel) return f.qualityLabel;
  if (f.height) return `${f.height}p`;
  if (f.audioQuality) return f.audioQuality.replace("AUDIO_QUALITY_", "");
  return f.quality || "Unknown";
}

function isHighQuality(f) {
  return (f.height || 0) >= 720;
}

function getCodecInfo(f) {
  if (!f.codecs) return "";
  const c = f.codecs;
  if (c.includes("avc1")) return "H.264";
  if (c.includes("vp9") || c.includes("vp09")) return "VP9";
  if (c.includes("av01")) return "AV1";
  if (c.includes("mp4a")) return "AAC";
  if (c.includes("opus")) return "Opus";
  return c.split(".")[0];
}

function getContainer(f) {
  if (f.ext) return f.ext.toUpperCase();
  const m = f.mimeType || "";
  if (m.includes("mp4")) return "MP4";
  if (m.includes("webm")) return "WebM";
  if (m.includes("audio/mp4")) return "M4A";
  return m.split("/")[1]?.split(";")[0] || "";
}

function escapeHtml(str) {
  if (!str) return "";
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

/**
 * Produce a human-friendly label for a client identifier used to obtain a stream.
 *
 * Converts known identifiers (e.g., "web", "android", "page_deciphered") to readable labels.
 * If the input contains "+" and is not an exact known key, each plus-separated token is labeled (known tokens mapped, "cipher" -> "Cipher", unknown tokens uppercased) and joined with " + ".
 *
 * @param {string} clientUsed - Client identifier string or a plus-separated composite (e.g., "web", "page_deciphered", "web+cipher").
 * @returns {string} A human-readable label for the provided client identifier; returns an empty string for falsy input.
 */
function formatSourceLabel(clientUsed) {
  if (!clientUsed) return "";
  const labels = {
    page_deciphered: "Page (Deciphered)",
    android: "Android API",
    android_vr: "Android VR API",
    android_testsuite: "Android Test API",
    ios: "iOS API",
    web: "Web API",
    "web+cipher": "Web API (Cipher)",
    page_scrape: "Page Scrape",
    sniffed: "Network Sniffed",
  };

  if (clientUsed.includes("+") && !labels[clientUsed]) {
    const parts = clientUsed.split("+");
    const labeledParts = parts.map((p) => {
      if (p === "cipher") return "Cipher";
      return labels[p] || p.toUpperCase();
    });
    return labeledParts.join(" + ");
  }

  return labels[clientUsed] || clientUsed;
}

function findBestAudio(audioFormats, videoFormat) {
  if (!audioFormats || audioFormats.length === 0) return null;
  const isMP4 = (videoFormat.mimeType || "").includes("mp4");
  const scored = audioFormats
    .filter((a) => a.url)
    .map((a) => {
      const aM = a.mimeType || "";
      const containerMatch = isMP4 ? aM.includes("mp4") : aM.includes("webm");
      const bitrate = a.bitrate || a.audioBitrate || 0;
      return {
        format: a,
        score: (containerMatch ? 100000 : 0) - Math.abs(bitrate - 128000),
      };
    })
    .sort((a, b) => b.score - a.score);
  return scored[0]?.format || audioFormats[0];
}

function shortenUrl(url, maxLen) {
  try {
    const u = new URL(url);
    const display = u.hostname + u.pathname;
    return display.length <= maxLen
      ? display
      : display.substring(0, maxLen - 3) + "...";
  } catch {
    return url.length <= maxLen ? url : url.substring(0, maxLen - 3) + "...";
  }
}

function guessFilenameFromUrl(url, type) {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    let name = (parts[parts.length - 1] || "video")
      .replace(/\.\w+$/, "")
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .substring(0, 60);
    if (type === "hls") return name + ".mp4";
    if (type === "dash") return name + ".mp4";
    return name + ".mp4";
  } catch {
    return "video.mp4";
  }
}

function generateFilename(title, quality, container) {
  const safe = (title || "video")
    .replace(/[<>:"/\\|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .substring(0, 60);
  return `${safe}_${quality}.${(container || "mp4").toLowerCase()}`;
}

const content = document.getElementById("content");
let currentView = "list";
let currentFormats = [];
let currentAudioFormats = [];
let currentVideoTitle = "";
let currentVideoId = null;
let currentVideoInfo = null;
let activeMergeInProgress = false;
let mergePollTimer = null;
let downloadPollTimer = null;

window.addEventListener("unload", () => {
  if (mergePollTimer) {
    clearInterval(mergePollTimer);
    mergePollTimer = null;
  }
  if (downloadPollTimer) {
    clearInterval(downloadPollTimer);
    downloadPollTimer = null;
  }
});

function setView(view) {
  currentView = view;
  const btn = document.getElementById("settingsBtn");
  if (btn) btn.classList.toggle("active", view === "settings");
  if (view === "settings") {
    renderSettingsView();
  } else {
    init();
  }
}

function renderLoading() {
  content.innerHTML = `
    <div class="state-container">
      <div class="spinner"></div>
      <span class="state-text">Detecting videos...</span>
    </div>`;
}

function renderNoVideo() {
  content.innerHTML = `
    <div class="state-container">
      <div class="state-icon-wrap float-anim">${ICONS.fileVideo}</div>
      <span class="state-title">Waiting for content</span>
      <span class="state-text">Play a video on the current page to detect downloadable streams.</span>
      <button class="state-btn" id="retryBtn">Refresh</button>
    </div>`;
  document.getElementById("retryBtn")?.addEventListener("click", init);
}

function renderError(title, message) {
  content.innerHTML = `
    <div class="state-container">
      <div class="state-icon-wrap error">${ICONS.error}</div>
      <span class="state-title error">${escapeHtml(title)}</span>
      <span class="state-text">${escapeHtml(message)}</span>
      <button class="state-btn" id="retryBtn">Try Again</button>
    </div>`;
  document.getElementById("retryBtn")?.addEventListener("click", init);
}

/**
 * Render the video information card and associated download UI for a detected video.
 *
 * Updates internal state with the provided video info, builds and inserts the appropriate
 * UI (compact single-format card or multi-format selector), displays DRM and login hints,
 * and wires download/merge controls and thumbnail fallbacks.
 *
 * @param {Object} info - Video metadata and available formats.
 * @param {string} [info.title] - Video title.
 * @param {string} [info.videoId] - Video identifier (used to derive a thumbnail if none provided).
 * @param {string} [info.author] - Video author/channel name.
 * @param {number} [info.lengthSeconds] - Video duration in seconds.
 * @param {string} [info.thumbnail] - URL of the video thumbnail.
 * @param {Array<Object>} [info.formats] - Array of available format objects (muxed, video-only, audio-only) with properties like itag, url, mimeType, codecs, height, bitrate, contentLength, isHLS, isDASH, isMuxed, isVideo, isAudio, fps, audioBitrate.
 * @param {boolean} [info.drmDetected] - True if DRM was detected for this video.
 * @param {string} [info.drmType] - DRM type label (when drmDetected is true).
 * @param {number|string} [info.drmConfidence] - Confidence level for DRM detection.
 * @param {boolean} [info.loggedIn] - False if the user is detected as not signed into the source (used to show a sign-in hint).
 * @param {string} [info.clientUsed] - Identifier of the source client used to obtain info (used to render a source label).
 */
function renderVideo(info) {
  currentVideoInfo = info; // Store current video info for DRM checks
  const {
    title,
    videoId,
    author,
    lengthSeconds,
    thumbnail,
    formats,
    drmDetected,
    drmType,
    drmConfidence,
  } = info;
  currentFormats = formats;
  currentVideoTitle = title || "Video";
  currentVideoId = videoId || null;

  // DRM Warning
  const drmWarning = drmDetected
    ? `
    <div class="drm-warning">
      <span class="drm-icon">🔒</span>
      <span class="drm-text">DRM Protected${drmType ? ` (${drmType})` : ""}${drmConfidence ? ` - ${drmConfidence} confidence` : ""}</span>
    </div>`
    : "";

  // Login hint for YouTube
  const loginHint =
    info.loggedIn === false
      ? `
    <div class="login-hint">
      <span class="login-hint-icon">ℹ️</span>
      <span class="login-hint-text">Sign in to YouTube for all video qualities</span>
    </div>`
      : "";

  const muxed = [];
  const videoOnly = [];
  const audioOnly = [];

  for (const f of formats) {
    if (f.isMuxed || (f.isVideo && f.codecs?.includes("mp4a"))) {
      muxed.push(f);
    } else if (f.isVideo) {
      videoOnly.push(f);
    } else if (f.isAudio) {
      audioOnly.push(f);
    }
  }

  for (const f of formats) {
    if (f.isMuxed || (f.isVideo && f.codecs?.includes("mp4a"))) {
      muxed.push(f);
    } else if (f.isVideo) {
      videoOnly.push(f);
    } else if (f.isAudio) {
      audioOnly.push(f);
    }
  }

  currentAudioFormats = audioOnly;

  muxed.sort((a, b) => (b.height || 0) - (a.height || 0));
  videoOnly.sort((a, b) => (b.height || 0) - (a.height || 0));
  audioOnly.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

  if (formats.length === 0) {
    renderError(
      "No downloadable formats",
      "The signature cipher may have changed. Try refreshing.",
    );
    return;
  }

  const withUrls = formats.filter((f) => f.url);
  if (withUrls.length === 0) {
    renderError(
      "Cipher decryption needed",
      "All formats require signature decryption. Try refreshing.",
    );
    return;
  }

  const bestHeight = videoOnly[0]?.height || muxed[0]?.height || 0;
  const qualityBadge =
    bestHeight >= 2160
      ? "4K"
      : bestHeight >= 1440
        ? "2K"
        : bestHeight >= 1080
          ? "HD"
          : "";

  const thumbUrl =
    thumbnail ||
    (videoId
      ? `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`
      : "icons/icon48.png");

  const isSimple =
    videoOnly.length === 0 && audioOnly.length === 0 && muxed.length === 1;

  if (isSimple) {
    const bestFmt = muxed[0];
    const q = getQualityLabel(bestFmt);
    const container = getContainer(bestFmt) || "MP4";
    const size = formatSize(bestFmt.contentLength);

    content.innerHTML = `
    <div class="video-card" id="vcard">
      <div class="video-header">
        <div class="video-thumb">
          <img src="${thumbUrl}" alt="" class="thumb-img">
          ${lengthSeconds ? `<span class="thumb-badge">${formatDuration(lengthSeconds)}</span>` : ""}
          ${qualityBadge ? `<span class="thumb-quality">${qualityBadge}</span>` : ""}
        </div>
        <div class="video-info">
          <div class="video-title">${escapeHtml(title || "Video")}</div>
          <div class="video-meta">
            ${author ? `<span class="video-meta-tag">${escapeHtml(author)}</span>` : ""}
            ${info.clientUsed ? `<span class="video-meta-tag">· ${escapeHtml(formatSourceLabel(info.clientUsed))}</span>` : ""}
          </div>
          ${drmWarning}
          ${loginHint}
        </div>
      </div>
      <div class="video-controls">
        <span class="quality-tag">${q} · ${container}${size ? " · " + size : ""}</span>
        <button class="dl-btn dl-btn-primary" id="dlBtn" title="Download" ${drmDetected ? "disabled" : ""}>${ICONS.download} ${drmDetected ? "DRM Protected" : "Download"}</button>
      </div>
      <div class="progress-wrap" id="progressWrap" style="display: none;">
        <div class="progress-bar-bg">
          <div class="progress-bar-fill" id="progressFill" style="width: 0%"></div>
        </div>
        <span class="progress-text" id="progressText">0%</span>
      </div>
    </div>`;

    document.getElementById("dlBtn")?.addEventListener("click", () => {
      if (drmDetected) {
        alert("This video is DRM protected and cannot be downloaded.");
        return;
      }
      const fmt = bestFmt;
      if (!fmt?.url) return;
      const filename = generateFilename(
        currentVideoTitle,
        q,
        container.toLowerCase(),
      );

      const isHLS =
        fmt.isHLS ||
        (fmt.mimeType || "").includes("mpegurl") ||
        fmt.url.includes(".m3u8");
      const isDASH =
        fmt.isDASH ||
        (fmt.mimeType || "").includes("dash") ||
        fmt.url.includes(".mpd");

      if (isHLS || isDASH) {
        workerDownload(fmt.url, isHLS ? "hls" : "dash", filename);
      } else {
        downloadFormat(fmt.url, filename);
      }
      const btn = document.getElementById("dlBtn");
      if (btn) {
        btn.innerHTML = "Starting...";
        btn.disabled = true;
        setTimeout(() => {
          btn.innerHTML = `${ICONS.download} Download`;
          btn.disabled = false;
        }, 2000);
      }
    });
    attachThumbFallbacks();
    return;
  }

  let optionsHtml = "";
  let defaultValue = "";

  if (videoOnly.length > 0 && audioOnly.length > 0) {
    optionsHtml += '<optgroup label="HD Video (+ audio merge)">';
    for (const f of videoOnly) {
      const best = findBestAudio(audioOnly, f);
      if (!best) continue;
      const q = getQualityLabel(f);
      const codec = getCodecInfo(f);
      const size = formatSize(f.contentLength);
      const fps = f.fps > 30 ? ` · ${f.fps}fps` : "";
      const val = `m:${f.itag}:${best.itag}`;
      const disabled = !f.url || !best.url ? " disabled" : "";
      if (!defaultValue && f.url && best.url) defaultValue = val;
      optionsHtml += `<option value="${val}"${disabled}>${q} · ${codec}${fps}${size ? " · " + size : ""}</option>`;
    }
    optionsHtml += "</optgroup>";
  }

  if (muxed.length > 0) {
    optionsHtml += '<optgroup label="Ready to play">';
    for (const f of muxed) {
      const q = getQualityLabel(f);
      const container = getContainer(f);
      const size = formatSize(f.contentLength);
      const val = `d:${f.itag}`;
      const disabled = !f.url ? " disabled" : "";
      if (!defaultValue && f.url) defaultValue = val;
      optionsHtml += `<option value="${val}"${disabled}>${q} · ${container}${size ? " · " + size : ""}</option>`;
    }
    optionsHtml += "</optgroup>";
  }

  if (audioOnly.length > 0) {
    optionsHtml += '<optgroup label="Audio only">';
    for (const f of audioOnly) {
      const kbps = f.audioBitrate || Math.round((f.bitrate || 0) / 1000);
      const codec = getCodecInfo(f);
      const size = formatSize(f.contentLength);
      const val = `d:${f.itag}`;
      const disabled = !f.url ? " disabled" : "";
      if (!defaultValue && f.url) defaultValue = val;
      optionsHtml += `<option value="${val}"${disabled}>${kbps}kbps · ${codec}${size ? " · " + size : ""}</option>`;
    }
    optionsHtml += "</optgroup>";
  }

  content.innerHTML = `
    <div class="video-card" id="vcard">
      <div class="video-header">
        <div class="video-thumb">
          <img src="${thumbUrl}" alt="" class="thumb-img">
          ${lengthSeconds ? `<span class="thumb-badge">${formatDuration(lengthSeconds)}</span>` : ""}
          ${qualityBadge ? `<span class="thumb-quality">${qualityBadge}</span>` : ""}
        </div>
        <div class="video-info">
          <div class="video-title">${escapeHtml(title || "Video")}</div>
          <div class="video-meta">
            ${author ? `<span class="video-meta-tag">${escapeHtml(author)}</span>` : ""}
            ${info.clientUsed ? `<span class="video-meta-tag">· ${escapeHtml(formatSourceLabel(info.clientUsed))}</span>` : ""}
          </div>
          ${drmWarning}
          ${loginHint}
        </div>
      </div>
      <div class="video-controls">
        <select class="quality-select" id="qualitySelect" ${drmDetected ? "disabled" : ""}>${optionsHtml}</select>
        <button class="dl-btn dl-btn-primary" id="dlBtn" title="Download" ${drmDetected ? "disabled" : ""}>${ICONS.download} ${drmDetected ? "DRM Protected" : "Download"}</button>
      </div>
      <div class="progress-wrap" id="progressWrap" style="display: none;">
        <div class="progress-bar-bg">
          <div class="progress-bar-fill" id="progressFill" style="width: 0%"></div>
        </div>
        <span class="progress-text" id="progressText">0%</span>
      </div>
    </div>`;

  const select = document.getElementById("qualitySelect");
  if (select && defaultValue) select.value = defaultValue;

  document
    .getElementById("dlBtn")
    ?.addEventListener("click", handleDownloadClick);
  attachThumbFallbacks();
}

function renderSettingsView() {
  content.innerHTML = `
    <div class="settings-view">
      <div class="settings-section">
        <div class="settings-section-title">Storage Location</div>
        <div class="settings-card">
          <div class="settings-row">
            <div class="settings-icon">${ICONS.folder}</div>
            <div class="settings-info">
              <div class="settings-label">Default Browser Downloads</div>
              <div class="settings-desc">Uses your browser's default download folder</div>
            </div>
          </div>
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">About</div>
        <div class="settings-card">
          <div class="settings-version">
            <span>Version</span>
            <span>1.1.0</span>
          </div>
        </div>
      </div>
    </div>`;
}

function renderSniffedStreams(streams) {
  if (!streams || streams.length === 0) {
    renderNoVideo();
    return;
  }

  const hls = streams.filter((s) => s.type === "hls");
  const dash = streams.filter((s) => s.type === "dash");
  const direct = streams.filter((s) => s.type === "direct");

  let html = '<div class="section-divider">Detected Streams</div>';
  for (const s of hls) html += renderStreamItem(s);
  for (const s of dash) html += renderStreamItem(s);
  for (const s of direct.slice(0, 10)) html += renderStreamItem(s);

  content.innerHTML = html;
  attachStreamDownloadHandlers();
}

function appendSniffedStreams(streams) {
  if (!streams || streams.length === 0) return;

  const hls = streams.filter((s) => s.type === "hls");
  const dash = streams.filter((s) => s.type === "dash");
  const direct = streams.filter((s) => s.type === "direct");

  let html = '<div class="section-divider">Detected Streams</div>';
  for (const s of hls) html += renderStreamItem(s);
  for (const s of dash) html += renderStreamItem(s);
  for (const s of direct.slice(0, 10)) html += renderStreamItem(s);

  const div = document.createElement("div");
  div.innerHTML = html;
  content.appendChild(div);
  attachStreamDownloadHandlers();
}

function renderStreamItem(stream) {
  const typeLabel = stream.type.toUpperCase();
  const urlDisplay = shortenUrl(stream.url, 42);
  const sizeDisplay = stream.size > 0 ? formatSize(stream.size) : "";
  const btnLabel =
    stream.type === "hls" || stream.type === "dash" ? "Download" : "Save";

  return `
    <div class="stream-card">
      <span class="stream-badge ${stream.type}">${typeLabel}</span>
      <div class="stream-details">
        <div class="stream-url" title="${escapeHtml(stream.url)}">${escapeHtml(urlDisplay)}</div>
        <div class="stream-meta">${escapeHtml(stream.contentType || "")}${sizeDisplay ? " · " + sizeDisplay : ""}</div>
      </div>
      <button class="stream-dl-btn" data-url="${escapeHtml(stream.url)}" data-type="${stream.type}">${btnLabel}</button>
    </div>`;
}

/**
 * Handle the Download button click: validate selection and initiate the appropriate download flow.
 *
 * Reads the selected quality/option from the quality selector, prevents downloads for DRM-protected content,
 * and either starts a merge download for separate video+audio tracks or starts a worker/direct download for a single format.
 * Updates the download button state briefly while the download is being started.
 */
function handleDownloadClick() {
  // Check for DRM protection
  const currentInfo = currentVideoInfo;
  if (currentInfo && currentInfo.drmDetected) {
    alert("This video is DRM protected and cannot be downloaded.");
    return;
  }

  const select = document.getElementById("qualitySelect");
  const btn = document.getElementById("dlBtn");
  if (!select || !btn || btn.disabled) return;

  const value = select.value;
  if (!value) return;

  if (value.startsWith("m:")) {
    const parts = value.split(":");
    const videoItag = parts[1];
    const audioItag = parts[2];
    const videoFmt = currentFormats.find((f) => String(f.itag) === videoItag);
    const audioFmt = currentFormats.find((f) => String(f.itag) === audioItag);

    if (videoFmt?.url && audioFmt?.url) {
      const q = getQualityLabel(videoFmt);
      // Pick container based on codecs — WebM for VP9/VP8+Opus/Vorbis, MP4 otherwise
      const vMime = (videoFmt.mimeType || "").toLowerCase();
      const aMime = (audioFmt.mimeType || "").toLowerCase();
      const mergeContainer =
        vMime.includes("webm") && aMime.includes("webm") ? "webm" : "mp4";
      const filename = generateFilename(currentVideoTitle, q, mergeContainer);
      mergeDownload(videoFmt.url, audioFmt.url, filename, videoItag, audioItag);
    }
  } else if (value.startsWith("d:")) {
    const itag = value.substring(2);
    const fmt = currentFormats.find((f) => String(f.itag) === itag);
    if (fmt?.url) {
      const q = getQualityLabel(fmt);
      const container = getContainer(fmt) || "mp4";
      const filename = generateFilename(currentVideoTitle, q, container);

      const isHLS =
        fmt.isHLS ||
        (fmt.mimeType || "").includes("mpegurl") ||
        fmt.url.includes(".m3u8");
      const isDASH =
        fmt.isDASH ||
        (fmt.mimeType || "").includes("dash") ||
        fmt.url.includes(".mpd");

      if (isHLS || isDASH) {
        workerDownload(fmt.url, isHLS ? "hls" : "dash", filename);
      } else {
        downloadFormat(fmt.url, filename);
      }
      btn.innerHTML = "Starting...";
      btn.disabled = true;
      setTimeout(() => {
        btn.innerHTML = ICONS.download;
        btn.disabled = false;
      }, 2000);
    }
  }
}

async function downloadFormat(url, filename) {
  try {
    const resp = await chrome.runtime.sendMessage({
      action: "DOWNLOAD_VIDEO",
      url,
      filename,
    });
    if (!resp?.success) console.error("Download failed:", resp?.error);
  } catch (err) {
    console.error("Download error:", err);
  }
}

/**
 * Starts a background worker download for the given URL and begins polling for download progress on success.
 *
 * Sends the download request (including optional video title and thumbnail metadata) to the extension background so the worker can perform HLS/DASH downloads and keeps the UI updated by starting the download poll when accepted.
 * @param {string} url - The resource URL to download.
 * @param {string} type - The download type, e.g. "hls", "dash", or "direct".
 * @param {string} filename - The desired filename for the downloaded file.
 */
async function workerDownload(url, type, filename) {
  try {
    const resp = await chrome.runtime.sendMessage({
      action: "START_WORKER_DOWNLOAD",
      url,
      type,
      filename,
      // Include video metadata for persistent display
      videoTitle: currentVideoTitle || null,
      videoThumbnail: currentVideoInfo?.thumbnail || null,
    });
    if (resp?.success) {
      startDownloadPoll();
    } else {
      console.error("Worker download failed:", resp?.error);
    }
  } catch (err) {
    console.error("Worker download error:", err);
  }
}

/**
 * Starts merging a video and audio stream into a single file and updates the UI to reflect merge progress.
 *
 * Initiates a background merge request for the provided video and audio URLs, disables relevant UI controls,
 * shows progress, and handles success, failure, and cancellation states. On completion (success or failure)
 * the UI is reset and the internal merge-in-progress flag is cleared.
 *
 * @param {string} videoUrl - URL of the video-only stream to merge.
 * @param {string} audioUrl - URL of the audio-only stream to merge.
 * @param {string} filename - Desired output filename for the merged file.
 * @param {string|number} videoItag - Format itag or identifier for the video stream.
 * @param {string|number} audioItag - Format itag or identifier for the audio stream.
 */
async function mergeDownload(
  videoUrl,
  audioUrl,
  filename,
  videoItag,
  audioItag,
) {
  if (activeMergeInProgress) return;
  activeMergeInProgress = true;

  const btn = document.getElementById("dlBtn");
  const select = document.getElementById("qualitySelect");

  if (select) select.disabled = true;
  if (btn) {
    btn.className = "dl-btn dl-btn-stop";
    btn.innerHTML = `${ICONS.stop} Stop`;
    btn.disabled = false;
    btn.onclick = async () => {
      btn.disabled = true;
      btn.innerHTML = "Cancelling...";
      try {
        await chrome.runtime.sendMessage({ action: "CANCEL_MERGE" });
      } catch {}
    };
  }

  showProgress(0, "Starting merge...");
  startMergePoll();

  try {
    const response = await chrome.runtime.sendMessage({
      action: "DOWNLOAD_MERGED",
      videoUrl,
      audioUrl,
      filename,
      videoItag,
      audioItag,
      videoId: currentVideoId,
      // Include video metadata for persistent display
      videoTitle: currentVideoTitle || null,
      videoThumbnail: currentVideoInfo?.thumbnail || null,
    });

    if (response?.success) {
      showProgress(100, "Saved! Check your downloads folder");
      const fill = document.getElementById("progressFill");
      if (fill) fill.classList.add("done");
      if (btn) {
        btn.className = "dl-btn dl-btn-done";
        btn.innerHTML = `${ICONS.check} Done`;
      }
    } else {
      showProgress(0, response?.error || "Merge failed");
      const fill = document.getElementById("progressFill");
      if (fill) fill.classList.add("error");
      if (btn) {
        btn.className = "dl-btn dl-btn-primary";
        btn.innerHTML = `${ICONS.download} Retry`;
      }
      console.error("Merge failed:", response?.error);
    }
  } catch (err) {
    showProgress(0, "Error: " + err.message);
    console.error("Merge error:", err);
  } finally {
    setTimeout(() => {
      resetDownloadUI();
      activeMergeInProgress = false;
    }, 4000);
  }
}

function resetDownloadUI() {
  const btn = document.getElementById("dlBtn");
  const select = document.getElementById("qualitySelect");
  if (btn) {
    btn.className = "dl-btn dl-btn-primary";
    btn.innerHTML = ICONS.download;
    btn.disabled = false;
    btn.onclick = null;
    btn.addEventListener("click", handleDownloadClick);
  }
  if (select) select.disabled = false;
  hideProgress();
}

function attachThumbFallbacks() {
  content.querySelectorAll(".thumb-img").forEach((img) => {
    img.addEventListener("error", function () {
      this.src = "icons/icon48.png";
    });
  });
}

function attachStreamDownloadHandlers() {
  content.querySelectorAll(".stream-dl-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const url = btn.dataset.url;
      const type = btn.dataset.type;
      btn.disabled = true;
      btn.textContent = "Starting...";

      try {
        if (type === "hls" || type === "dash") {
          const resp = await chrome.runtime.sendMessage({
            action: "START_WORKER_DOWNLOAD",
            url,
            type,
            filename: guessFilenameFromUrl(url, type),
          });
          if (resp?.success) {
            btn.textContent = "Downloading...";
            startDownloadPoll();
          } else {
            btn.textContent = "Failed";
            setTimeout(() => {
              btn.textContent =
                type === "hls" || type === "dash" ? "Download" : "Save";
              btn.disabled = false;
            }, 3000);
          }
        } else {
          const resp = await chrome.runtime.sendMessage({
            action: "DOWNLOAD_VIDEO",
            url,
            filename: guessFilenameFromUrl(url, type),
          });
          btn.textContent = resp?.success ? "Done!" : "Failed";
          setTimeout(() => {
            btn.textContent = "Save";
            btn.disabled = false;
          }, 3000);
        }
      } catch (err) {
        console.error("Stream download error:", err);
        btn.textContent = "Error";
        setTimeout(() => {
          btn.textContent =
            type === "hls" || type === "dash" ? "Download" : "Save";
          btn.disabled = false;
        }, 3000);
      }
    });
  });
}

function showProgress(percent, message) {
  const wrap = document.getElementById("progressWrap");
  const fill = document.getElementById("progressFill");
  const text = document.getElementById("progressText");
  if (wrap) wrap.style.display = "flex";
  if (fill) fill.style.width = `${percent}%`;
  if (text) text.textContent = message || `${percent}%`;
}

function hideProgress() {
  const wrap = document.getElementById("progressWrap");
  const fill = document.getElementById("progressFill");
  if (wrap) wrap.style.display = "none";
  if (fill) {
    fill.style.width = "0%";
    fill.className = "progress-bar-fill";
  }
}

function showBanner(type, html) {
  content.querySelectorAll(".banner").forEach((el) => el.remove());

  const banner = document.createElement("div");
  banner.className = `banner ${type}`;
  banner.id = "activeBanner";
  banner.innerHTML = html;

  if (content.firstChild) {
    content.insertBefore(banner, content.firstChild);
  } else {
    content.appendChild(banner);
  }
}

/**
 * Periodically polls session storage for an active merge and updates the UI with merge progress.
 *
 * Starts a repeating poll that reads "activeMerge" from chrome.storage.session and, while the merge
 * is active, updates either the inline progress UI (element with id "progressWrap") or the global
 * merge banner (element with id "activeBanner") with the current percent and message. If no active
 * merge is found the poll is stopped and cleared. Calling this while a poll is already running has
 * no effect.
 */
function startMergePoll() {
  if (mergePollTimer) return;
  mergePollTimer = setInterval(async () => {
    try {
      const result = await chrome.storage.session.get("activeMerge");
      const merge = result?.activeMerge;

      if (!merge || merge.status !== "active") {
        clearInterval(mergePollTimer);
        mergePollTimer = null;
        return;
      }

      const pct = Math.round(merge.percent || 0);
      const msg = merge.message || merge.phase || "Merging...";

      // Check if we have video card elements (progressWrap exists)
      const hasProgressUI = document.getElementById("progressWrap");
      if (hasProgressUI) {
        showProgress(pct, `${msg} · ${pct}%`);
      } else {
        // Update the merge banner
        const banner = document.getElementById("activeBanner");
        if (banner) {
          const msgEl = banner.querySelector(".banner-msg");
          const pctEl = banner.querySelector(".banner-pct");
          const barEl = banner.querySelector(".banner-bar-fill");
          if (msgEl) msgEl.textContent = msg;
          if (pctEl) pctEl.textContent = `${pct}%`;
          if (barEl) barEl.style.width = `${pct}%`;
        }
      }
    } catch {}
  }, 1200);
}

/**
 * Begin a periodic check of session storage for active downloads and render/update download banners in the UI.
 *
 * If a poll is already active this is a no-op. While running, the function:
 * - Creates or updates per-download banners showing progress, percentage, and an optional thumbnail and title.
 * - Converts completed or errored downloads into final banners and removes them after a short delay.
 * - Stops polling and clears banners when there are no active downloads.
 */
function startDownloadPoll() {
  if (downloadPollTimer) return;
  downloadPollTimer = setInterval(async () => {
    try {
      const result = await chrome.storage.session.get("activeDownloads");
      const downloads = result?.activeDownloads;

      if (!downloads || Object.keys(downloads).length === 0) {
        clearInterval(downloadPollTimer);
        downloadPollTimer = null;
        content.querySelectorAll(".banner").forEach((el) => el.remove());
        return;
      }

      let hasActive = false;
      for (const [dlId, dl] of Object.entries(downloads)) {
        const existing = document.getElementById(`dl-banner-${dlId}`);
        const hasMetadata = dl.videoTitle || dl.videoThumbnail;

        if (dl.phase === "complete" || dl.phase === "error") {
          if (existing) {
            existing.className = `banner ${dl.phase === "complete" ? "complete" : "error"}`;
            const icon = dl.phase === "complete" ? "✓" : "✗";
            if (hasMetadata) {
              const thumbHtml = dl.videoThumbnail
                ? `<img src="${escapeHtml(dl.videoThumbnail)}" class="banner-thumb" alt="" />`
                : "";
              const titleHtml = dl.videoTitle
                ? `<div class="banner-title">${escapeHtml(dl.videoTitle)}</div>`
                : "";
              existing.innerHTML = `<div class="banner-video-row">${thumbHtml}<div class="banner-video-info">${titleHtml}<div class="banner-status">${icon} ${escapeHtml(dl.message || dl.filename || "")}</div></div></div>`;
            } else {
              existing.innerHTML = `<div class="banner-row">${icon} ${escapeHtml(dl.message || dl.filename || "")}</div>`;
            }
            setTimeout(() => existing.remove(), 5000);
          }
        } else {
          hasActive = true;
          const pct = Math.round(dl.percent || 0);

          if (existing) {
            const msgEl = existing.querySelector(".banner-msg");
            const pctEl = existing.querySelector(".banner-pct");
            const barEl = existing.querySelector(".banner-bar-fill");
            if (msgEl) msgEl.textContent = dl.message || "Downloading...";
            if (pctEl) pctEl.textContent = `${pct}%`;
            if (barEl) barEl.style.width = `${pct}%`;
          } else {
            const banner = document.createElement("div");
            banner.className = "banner active";
            banner.id = `dl-banner-${dlId}`;
            if (hasMetadata) {
              const thumbHtml = dl.videoThumbnail
                ? `<img src="${escapeHtml(dl.videoThumbnail)}" class="banner-thumb" alt="" />`
                : "";
              const titleHtml = dl.videoTitle
                ? `<div class="banner-title">${escapeHtml(dl.videoTitle)}</div>`
                : "";
              banner.innerHTML = `<div class="banner-video-row">
                ${thumbHtml}
                <div class="banner-video-info">
                  ${titleHtml}
                  <div class="banner-row" style="margin-top:4px">
                    <span class="banner-spinner"></span>
                    <span class="banner-msg">${escapeHtml(dl.message || "Downloading...")}</span>
                    <span class="banner-pct" style="margin-left:auto;font-weight:500">${pct}%</span>
                  </div>
                  <div class="banner-bar-bg">
                    <div class="banner-bar-fill" style="width: ${pct}%"></div>
                  </div>
                </div>
              </div>`;
            } else {
              banner.innerHTML = `
                <div class="banner-row">
                  <span class="banner-spinner"></span>
                  <span class="banner-msg">${escapeHtml(dl.message || "Downloading...")}</span>
                  <span class="banner-pct" style="margin-left:auto;font-weight:500">${pct}%</span>
                </div>
                <div class="banner-bar-bg">
                  <div class="banner-bar-fill" style="width: ${pct}%"></div>
                </div>`;
            }
            if (content.firstChild)
              content.insertBefore(banner, content.firstChild);
            else content.appendChild(banner);
          }
        }
      }

      if (!hasActive) {
        clearInterval(downloadPollTimer);
        downloadPollTimer = null;
      }
    } catch {}
  }, 1500);
}

/**
 * Render banners for current active downloads stored in session storage.
 *
 * Retrieves `activeDownloads` from `chrome.storage.session` and creates a banner
 * for each entry under the page `content` element. Each banner reflects the
 * download's phase: "complete" (success), "error" (failure), or active
 * (in-progress). When available, video metadata (`videoTitle`, `videoThumbnail`)
 * is shown; active banners display percentage progress and a progress bar and
 * will trigger the download poll to keep UI in sync.
 */
async function showActiveDownloads() {
  try {
    const result = await chrome.storage.session.get("activeDownloads");
    const downloads = result?.activeDownloads;
    if (!downloads || Object.keys(downloads).length === 0) return;

    for (const [dlId, dl] of Object.entries(downloads)) {
      const banner = document.createElement("div");
      banner.id = `dl-banner-${dlId}`;

      // Build video info section if metadata is available
      const hasMetadata = dl.videoTitle || dl.videoThumbnail;
      const thumbHtml = dl.videoThumbnail
        ? `<img src="${escapeHtml(dl.videoThumbnail)}" class="banner-thumb" alt="" />`
        : "";
      const titleHtml = dl.videoTitle
        ? `<div class="banner-title">${escapeHtml(dl.videoTitle)}</div>`
        : "";

      if (dl.phase === "complete") {
        banner.className = "banner complete";
        banner.innerHTML = hasMetadata
          ? `<div class="banner-video-row">${thumbHtml}<div class="banner-video-info">${titleHtml}<div class="banner-status">✓ ${escapeHtml(dl.filename || "Download complete")}</div></div></div>`
          : `<div class="banner-row">✓ ${escapeHtml(dl.filename || "Download complete")}</div>`;
      } else if (dl.phase === "error") {
        banner.className = "banner error";
        banner.innerHTML = hasMetadata
          ? `<div class="banner-video-row">${thumbHtml}<div class="banner-video-info">${titleHtml}<div class="banner-status">✗ ${escapeHtml(dl.message || "Download failed")}</div></div></div>`
          : `<div class="banner-row">✗ ${escapeHtml(dl.message || "Download failed")}</div>`;
      } else {
        banner.className = "banner active";
        const pct = Math.round(dl.percent || 0);
        banner.innerHTML = hasMetadata
          ? `<div class="banner-video-row">
              ${thumbHtml}
              <div class="banner-video-info">
                ${titleHtml}
                <div class="banner-row" style="margin-top:4px">
                  <span class="banner-spinner"></span>
                  <span class="banner-msg">${escapeHtml(dl.message || "Downloading...")}</span>
                  <span class="banner-pct" style="margin-left:auto;font-weight:500">${pct}%</span>
                </div>
                <div class="banner-bar-bg">
                  <div class="banner-bar-fill" style="width: ${pct}%"></div>
                </div>
              </div>
            </div>`
          : `<div class="banner-row">
              <span class="banner-spinner"></span>
              <span class="banner-msg">${escapeHtml(dl.message || "Downloading...")}</span>
              <span class="banner-pct" style="margin-left:auto;font-weight:500">${pct}%</span>
            </div>
            <div class="banner-bar-bg">
              <div class="banner-bar-fill" style="width: ${pct}%"></div>
            </div>`;
        startDownloadPoll();
      }

      if (content.firstChild) content.insertBefore(banner, content.firstChild);
      else content.appendChild(banner);
    }
  } catch {}
}

/**
 * Initialize the popup UI, detect video content on the active tab, and render the appropriate view.
 *
 * Queries the active browser tab, requests video information and any sniffed streams from the background
 * script, and then renders one of: a detailed video card, sniffed streams list, a waiting-for-content view,
 * or an error state. Restores and displays any active merge state (inline or as a banner), starts merge/download
 * polling when appropriate, and populates active download banners. On failure, logs the error and renders an error view.
 */
async function init() {
  if (currentView === "settings") return;
  renderLoading();

  try {
    const mergeResult = await chrome.storage.session.get("activeMerge");
    const activeMerge = mergeResult?.activeMerge;
    activeMergeInProgress = activeMerge?.status === "active";

    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    const isYouTube = tab?.url?.match(
      /youtube\.com\/(watch|shorts|embed|live)/,
    );

    if (isYouTube) {
      const url = new URL(tab.url);
      const videoId =
        url.searchParams.get("v") ||
        tab.url.match(/\/shorts\/([\w-]{11})/)?.[1] ||
        tab.url.match(/\/embed\/([\w-]{11})/)?.[1] ||
        tab.url.match(/\/live\/([\w-]{11})/)?.[1];

      if (!videoId) {
        renderNoVideo();
        return;
      }

      const response = await chrome.runtime.sendMessage({
        action: "GET_VIDEO_INFO",
        videoId,
        tabId: tab.id,
      });

      if (response?.error) {
        renderError("Failed to get video info", response.error);
        return;
      }

      if (response?.formats?.length > 0) {
        renderVideo(response);
      } else if (response?.formats) {
        renderError(
          "No downloadable formats",
          "Cipher decryption may have failed. Try refreshing.",
        );
      } else {
        renderError(
          "No response",
          "Could not communicate with background script.",
        );
      }
    } else {
      const response = await chrome.runtime.sendMessage({
        action: "GET_VIDEO_INFO",
        tabId: tab.id,
        videoId: null,
      });

      const sniffedResult = await chrome.runtime.sendMessage({
        action: "GET_SNIFFED_STREAMS",
        tabId: tab.id,
      });
      const sniffedStreams = sniffedResult?.streams || [];

      if (response?.formats?.length > 0) {
        renderVideo(response);
        if (sniffedStreams.length > 0) appendSniffedStreams(sniffedStreams);
      } else if (sniffedStreams.length > 0) {
        renderSniffedStreams(sniffedStreams);
      } else {
        renderNoVideo();
      }
    }

    if (activeMerge && activeMerge.status === "active") {
      // Check if we have video card elements (progressWrap exists)
      const hasProgressUI = document.getElementById("progressWrap");
      if (hasProgressUI) {
        // We're on the video page - use inline progress
        showProgress(
          activeMerge.percent || 0,
          activeMerge.message || "Merging...",
        );
        const btn = document.getElementById("dlBtn");
        const select = document.getElementById("qualitySelect");
        if (btn) {
          btn.className = "dl-btn dl-btn-stop";
          btn.innerHTML = `${ICONS.stop} Stop`;
          btn.disabled = false;
          btn.onclick = async () => {
            btn.disabled = true;
            btn.innerHTML = "Cancelling...";
            try {
              await chrome.runtime.sendMessage({ action: "CANCEL_MERGE" });
            } catch {}
          };
        }
        if (select) select.disabled = true;
      } else {
        // We're on a different tab - show merge as a banner with video card
        const pct = Math.round(activeMerge.percent || 0);
        const hasMetadata =
          activeMerge.videoTitle || activeMerge.videoThumbnail;
        const thumbHtml = activeMerge.videoThumbnail
          ? `<img src="${escapeHtml(activeMerge.videoThumbnail)}" class="banner-thumb" alt="" />`
          : "";
        const titleHtml = activeMerge.videoTitle
          ? `<div class="banner-title">${escapeHtml(activeMerge.videoTitle)}</div>`
          : "";
        const bannerHtml = hasMetadata
          ? `<div class="banner-video-row">
              ${thumbHtml}
              <div class="banner-video-info">
                ${titleHtml}
                <div class="banner-row" style="margin-top:4px">
                  <span class="banner-spinner"></span>
                  <span class="banner-msg">${escapeHtml(activeMerge.message || "Merging...")}</span>
                  <span class="banner-pct" style="margin-left:auto;font-weight:500">${pct}%</span>
                </div>
                <div class="banner-bar-bg">
                  <div class="banner-bar-fill" style="width: ${pct}%"></div>
                </div>
              </div>
            </div>`
          : `<div class="banner-row">
              <span class="banner-spinner"></span>
              <span class="banner-msg">${escapeHtml(activeMerge.message || "Merging...")}</span>
              <span class="banner-pct" style="margin-left:auto;font-weight:500">${pct}%</span>
            </div>
            <div class="banner-bar-bg">
              <div class="banner-bar-fill" style="width: ${pct}%"></div>
            </div>`;
        showBanner("active", bannerHtml);
      }
      startMergePoll();
    } else if (activeMerge?.status === "complete") {
      const hasMetadata = activeMerge.videoTitle || activeMerge.videoThumbnail;
      if (hasMetadata) {
        const thumbHtml = activeMerge.videoThumbnail
          ? `<img src="${escapeHtml(activeMerge.videoThumbnail)}" class="banner-thumb" alt="" />`
          : "";
        const titleHtml = activeMerge.videoTitle
          ? `<div class="banner-title">${escapeHtml(activeMerge.videoTitle)}</div>`
          : "";
        showBanner(
          "complete",
          `<div class="banner-video-row">${thumbHtml}<div class="banner-video-info">${titleHtml}<div class="banner-status">✓ ${escapeHtml(activeMerge.filename || "Download complete")}</div></div></div>`,
        );
      } else {
        showBanner(
          "complete",
          `<div class="banner-row">✓ Merge complete: ${escapeHtml(activeMerge.filename || "")}</div>`,
        );
      }
    } else if (activeMerge?.status === "failed") {
      const hasMetadata = activeMerge.videoTitle || activeMerge.videoThumbnail;
      if (hasMetadata) {
        const thumbHtml = activeMerge.videoThumbnail
          ? `<img src="${escapeHtml(activeMerge.videoThumbnail)}" class="banner-thumb" alt="" />`
          : "";
        const titleHtml = activeMerge.videoTitle
          ? `<div class="banner-title">${escapeHtml(activeMerge.videoTitle)}</div>`
          : "";
        showBanner(
          "error",
          `<div class="banner-video-row">${thumbHtml}<div class="banner-video-info">${titleHtml}<div class="banner-status">✗ ${escapeHtml(activeMerge.error || "Merge failed")}</div></div></div>`,
        );
      } else {
        showBanner(
          "error",
          `<div class="banner-row">✗ ${escapeHtml(activeMerge.error || "Merge failed")}</div>`,
        );
      }
    }

    await showActiveDownloads();
  } catch (error) {
    console.error("Popup error:", error);
    renderError("Error", error.message);
  }
}

document.getElementById("settingsBtn")?.addEventListener("click", () => {
  setView(currentView === "settings" ? "list" : "settings");
});

document.getElementById("refreshBtn")?.addEventListener("click", () => {
  currentView = "list";
  document.getElementById("settingsBtn")?.classList.remove("active");
  init();
});

document.getElementById("noVideoBtn")?.addEventListener("click", () => {
  currentView = "list";
  document.getElementById("settingsBtn")?.classList.remove("active");
  init();
});

document.getElementById("openFolderBtn")?.addEventListener("click", () => {
  chrome.tabs.create({ url: "chrome://downloads/" });
});

document.getElementById("clearAllBtn")?.addEventListener("click", async () => {
  try {
    await chrome.storage.session.remove(["activeMerge", "activeDownloads"]);
  } catch {}
  if (mergePollTimer) {
    clearInterval(mergePollTimer);
    mergePollTimer = null;
  }
  if (downloadPollTimer) {
    clearInterval(downloadPollTimer);
    downloadPollTimer = null;
  }
  activeMergeInProgress = false;
  init();
});

init();