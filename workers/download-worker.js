importScripts("segment-pool.js");

const MAX_CONCURRENT_SEGMENTS = 6;
const MAX_SEGMENT_RETRIES = 6; // Increased from 3 — yt-dlp uses 10, 6 is balanced for browser context
const SEGMENT_TIMEOUT = 30000;
const MAX_DOWNLOAD_SIZE = 20 * 1024 * 1024 * 1024;
const OPFS_ENABLED =
  typeof navigator !== "undefined" && navigator.storage?.getDirectory;
const RAM_THRESHOLD = 100 * 1024 * 1024;

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

function hashSegmentData(data) {
  const len = data.byteLength;
  if (len < 1048576) {
    let key = String(len) + ":";
    for (let i = 0; i < len; i++) key += String.fromCharCode(data[i]);
    return cyrb53(key);
  }

  const headSize = 8192;
  const midStart = Math.floor(len / 2) - 2048;
  const midSize = 4096;
  const tailStart = len - 4096;
  const tailSize = 4096;
  let key = String(len) + ":";
  for (let i = 0; i < headSize; i++) key += String.fromCharCode(data[i]);
  for (let i = midStart; i < midStart + midSize; i++)
    key += String.fromCharCode(data[i]);
  for (let i = tailStart; i < tailStart + tailSize; i++)
    key += String.fromCharCode(data[i]);
  return cyrb53(key);
}

const activeDownloads = new Map();

self.onmessage = async (e) => {
  const { name, data } = e.data;

  switch (name) {
    case "start_download":
      try {
        await handleDownload(data);
      } catch (err) {
        reportError(data.download_id, err.message);
      }
      break;

    case "cancel_download":
      cancelDownload(data.download_id);
      break;

    case "refresh_urls":
      // S35 fix: Handle URL refresh from background (YouTube URL expiry)
      handleUrlRefresh(data);
      break;

    case "ping":
      self.postMessage({ name: "pong" });
      break;
  }
};

async function handleDownload(data) {
  const { download_id, url, audioUrl, filename, type, headers, tabId } = data;

  activeDownloads.set(download_id, { cancelled: false, pool: null, tabId });

  try {
    let result;

    switch (type) {
      case "direct":
        result = await downloadHttpDirect(download_id, url, filename, headers);
        break;

      case "m3u8":
      case "hls":
        result = await downloadM3U8(download_id, url, filename, headers);
        break;

      case "dash":
      case "mpd":
        result = await downloadDASH(download_id, url, filename, headers);
        break;

      case "merge":
        result = await downloadMergedStreams(
          download_id,
          url,
          audioUrl,
          filename,
          headers,
        );
        break;

      default:
        if (/\.m3u8(\?|$)/i.test(url)) {
          result = await downloadM3U8(download_id, url, filename, headers);
        } else if (/\.mpd(\?|$)/i.test(url)) {
          result = await downloadDASH(download_id, url, filename, headers);
        } else {
          result = await downloadHttpDirect(
            download_id,
            url,
            filename,
            headers,
          );
        }
    }

    if (!isCancelled(download_id)) {
      self.postMessage({
        name: "download_result",
        data: {
          download_id,
          ...result,
        },
      });
    }
  } finally {
    activeDownloads.delete(download_id);
  }
}

async function downloadHttpDirect(downloadId, url, filename, headers = {}) {
  reportProgress(downloadId, "downloading", 0, "Starting download...");

  // S29 fix: retry transient errors (429, 5xx, network failures) with
  // exponential backoff, matching the robustness of the HLS/SegmentPool path.
  const MAX_DIRECT_RETRIES = 5;
  const DIRECT_BACKOFF_BASE = 1000;
  const DIRECT_BACKOFF_CAP = 30000;
  let resp = null;

  for (let attempt = 0; attempt <= MAX_DIRECT_RETRIES; attempt++) {
    try {
      resp = await fetch(url, { headers, cache: "no-cache" });
      if (resp.ok) break; // 2xx — success

      // Retryable HTTP status codes
      if (resp.status === 429 || resp.status >= 500) {
        if (attempt >= MAX_DIRECT_RETRIES) {
          throw new Error(`HTTP ${resp.status} after ${attempt + 1} attempts`);
        }
        const retryAfterHdr = resp.headers.get("retry-after");
        const retryAfterMs = retryAfterHdr
          ? (parseInt(retryAfterHdr) || 1) * 1000
          : 0;
        const backoff = Math.min(
          DIRECT_BACKOFF_BASE * Math.pow(2, attempt) + Math.random() * 500,
          DIRECT_BACKOFF_CAP,
        );
        const delay = Math.max(retryAfterMs, backoff);
        console.warn(
          `[Worker] Direct download: HTTP ${resp.status}, retry ${attempt + 1}/${MAX_DIRECT_RETRIES} in ${Math.round(delay)}ms`,
        );
        reportProgress(
          downloadId,
          "downloading",
          0,
          `Retrying (${resp.status})... attempt ${attempt + 1}/${MAX_DIRECT_RETRIES}`,
        );
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      // Non-retryable HTTP error (4xx except 429)
      throw new Error(`HTTP ${resp.status}`);
    } catch (err) {
      // Network-level errors (DNS, connection reset, etc.)
      if (err.message?.startsWith?.("HTTP ")) throw err; // re-throw our own HTTP errors
      if (attempt >= MAX_DIRECT_RETRIES) {
        throw new Error(
          `Network error after ${attempt + 1} attempts: ${err.message}`,
        );
      }
      const delay = Math.min(
        DIRECT_BACKOFF_BASE * Math.pow(2, attempt) + Math.random() * 500,
        DIRECT_BACKOFF_CAP,
      );
      console.warn(
        `[Worker] Direct download: ${err.message}, retry ${attempt + 1}/${MAX_DIRECT_RETRIES} in ${Math.round(delay)}ms`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  if (!resp || !resp.ok) throw new Error(`HTTP ${resp?.status || "unknown"}`);

  const contentLength = parseInt(resp.headers.get("content-length")) || 0;
  const contentType = resp.headers.get("content-type") || "video/mp4";
  const reader = resp.body.getReader();
  const chunks = [];
  let downloaded = 0;
  let lastPct = 0;

  while (true) {
    if (isCancelled(downloadId)) throw new Error("Cancelled");
    const { done, value } = await reader.read();
    if (done) break;

    chunks.push(value);
    downloaded += value.byteLength;

    if (downloaded > MAX_DOWNLOAD_SIZE) {
      throw new Error("File exceeds 20GB size limit");
    }

    if (contentLength > 0) {
      const pct = Math.floor((downloaded / contentLength) * 100);
      if (pct > lastPct) {
        lastPct = pct;
        reportProgress(
          downloadId,
          "downloading",
          pct,
          `${formatBytes(downloaded)} / ${formatBytes(contentLength)}`,
        );
      }
    } else {
      reportProgress(
        downloadId,
        "downloading",
        -1,
        `Downloaded ${formatBytes(downloaded)}`,
      );
    }
  }

  reportProgress(downloadId, "finalizing", 95, "Preparing file...");

  const blob = new Blob(chunks, { type: contentType });
  const blobUrl = URL.createObjectURL(blob);

  return {
    blobUrl,
    filename: filename || "video.mp4",
    size: blob.size,
    mimeType: contentType,
  };
}

async function downloadM3U8(
  downloadId,
  masterUrl,
  filename,
  headers = {},
  _depth = 0,
) {
  if (_depth > 5)
    throw new Error("HLS playlist recursion limit exceeded (>5 levels)");
  reportProgress(downloadId, "parsing", 0, "Fetching HLS manifest...");

  const resp = await fetch(masterUrl, { headers, cache: "no-cache" });
  if (!resp.ok) throw new Error(`Manifest fetch failed: HTTP ${resp.status}`);
  const manifestText = await resp.text();

  const baseUrl = masterUrl.substring(0, masterUrl.lastIndexOf("/") + 1);

  if (manifestText.includes("#EXT-X-STREAM-INF")) {
    const variants = parseM3U8MasterPlaylist(manifestText, baseUrl);
    if (variants.length === 0)
      throw new Error("No variants found in master playlist");

    variants.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
    const best = variants[0];
    console.log(
      `[Worker] Selected variant: ${best.resolution || ""} bandwidth=${best.bandwidth}`,
    );
    console.log(
      `[Worker] Audio status: ${best.hasAudio ? "Muxed in stream" : "Separate track"} (codecs: ${best.codecs})`,
    );

    if (best.audioTracks && best.audioTracks.length > 0 && !best.hasAudio) {
      const audioTrack =
        best.audioTracks.find((a) => a.isDefault) || best.audioTracks[0];
      console.log(
        `[Worker] Downloading video + separate audio: ${audioTrack.name} (${audioTrack.language || "unknown"})`,
      );

      // Extract audio codec from CODECS attribute for smart BSF selection
      const audioCodec = extractAudioCodecFromCodecs(best.codecs);
      console.log(
        `[Worker] Detected audio codec from manifest: ${audioCodec || "unknown"}`,
      );

      // Download video segments
      reportProgress(
        downloadId,
        "downloading",
        0,
        "Downloading video track...",
      );
      const videoResult = await downloadM3U8(
        downloadId,
        best.url,
        filename,
        headers,
        _depth + 1,
      );
      if (isCancelled(downloadId)) throw new Error("Cancelled");

      // Download audio segments
      reportProgress(
        downloadId,
        "downloading",
        0,
        "Downloading audio track...",
      );
      const audioResult = await downloadM3U8(
        downloadId,
        audioTrack.url,
        "audio.ts",
        headers,
        _depth + 1,
      );
      if (isCancelled(downloadId)) throw new Error("Cancelled");

      return {
        blobUrl: videoResult.blobUrl,
        audioBlobUrl: audioResult.blobUrl,
        filename: filename || "video.mp4",
        size: videoResult.size + audioResult.size,
        mimeType: "video/mp4",
        needsMerge: true,
        needsTransmux: videoResult.needsTransmux || audioResult.needsTransmux,
        audioCodec: audioCodec || audioResult.audioCodec || null,
        opfsCleanupInfo: videoResult.opfsCleanupInfo,
        audioOpfsCleanupInfo: audioResult.opfsCleanupInfo,
      };
    }

    return downloadM3U8(downloadId, best.url, filename, headers, _depth + 1);
  }

  const segments = parseM3U8MediaPlaylist(manifestText, baseUrl);
  if (segments.length === 0)
    throw new Error("No segments found in media playlist");

  const firstSegmentUrl = segments[0]?.url || "";
  const isAudioOnly =
    /audio/i.test(manifestText) || /\.aac|\.mp3/i.test(firstSegmentUrl);

  console.log(`[Worker] HLS: ${segments.length} segments to download`);
  console.log(
    `[Worker] Stream type: ${isAudioOnly ? "Audio-only" : "Video (may include audio)"}`,
  );
  reportProgress(
    downloadId,
    "downloading",
    0,
    `0 / ${segments.length} segments`,
  );

  const keyMap = await resolveAllM3U8Keys(segments, headers);
  const hasEncryption = keyMap.size > 0;

  // S35 fix: Add URL refresh callback for YouTube URL expiry
  const pool = new SegmentPool(MAX_CONCURRENT_SEGMENTS, MAX_SEGMENT_RETRIES, {
    onUrlRefreshNeeded: async () => {
      console.log("[Worker] Requesting fresh URLs from background...");
      return new Promise((resolve, reject) => {
        const URL_REFRESH_TIMEOUT = 30000; // 30s timeout
        self.postMessage({
          name: "request_url_refresh",
          data: { downloadId },
        });
        // Background will call refresh_urls message with fresh URLs
        // Store the resolve/reject to be called when fresh URLs arrive
        const state = activeDownloads.get(downloadId);
        if (state) {
          state.urlRefreshResolve = resolve;
          state.urlRefreshReject = reject;
          state.urlRefreshTimer = setTimeout(() => {
            // Timeout — clear stored callbacks and reject
            if (state.urlRefreshResolve) {
              state.urlRefreshResolve = null;
              state.urlRefreshReject = null;
              state.urlRefreshTimer = null;
              reject(new Error("URL refresh timed out after 30s"));
            }
          }, URL_REFRESH_TIMEOUT);
        } else {
          reject(new Error("Download state not found for URL refresh"));
        }
      });
    },
    // S36 fix: Handle sleep/wake events
    onSleepWakeDetected: (event) => {
      console.warn(
        `[Worker] System sleep/wake detected during download ${downloadId}: ${Math.round(event.timeDrift / 1000)}s gap`,
      );
      reportProgress(
        downloadId,
        "downloading",
        -1,
        `Resuming after system sleep (${Math.round(event.timeDrift / 1000)}s)...`,
      );
    },
    // S40 fix: Handle network changes (WiFi switch, mobile data toggle)
    onNetworkChange: (event) => {
      console.warn(
        `[Worker] Network change detected during download ${downloadId}: ${event.effectiveType}`,
      );
      reportProgress(
        downloadId,
        "downloading",
        -1,
        `Network changed (${event.effectiveType}), continuing...`,
      );
    },
  });
  const state = activeDownloads.get(downloadId);
  if (state) state.pool = pool;

  const estimatedSize = segments.length * 1024 * 1024;
  const useOPFS = OPFS_ENABLED && estimatedSize > RAM_THRESHOLD;

  if (useOPFS) {
    console.log(
      `[Worker] Large download detected (~${Math.floor(estimatedSize / 1024 / 1024)}MB estimated). Using OPFS disk storage.`,
    );
  }

  const opfsRoot = useOPFS ? await navigator.storage.getDirectory() : null;
  const opfsFolder = useOPFS ? `m3u8_${downloadId}_${Date.now()}` : null;
  const opfsDir = useOPFS
    ? await opfsRoot.getDirectoryHandle(opfsFolder, { create: true })
    : null;

  let completedSegments = 0;
  const seenHashes = new Set();
  let skippedDupes = 0;

  // Filter out ad segments identified during playlist parsing
  // (yt-dlp technique: Anvato/Uplynk ad tags + EXT-X-DISCONTINUITY heuristics)
  const mediaSegments = segments.filter((seg) => !seg.isAd);
  const adSegmentCount = segments.length - mediaSegments.length;
  if (adSegmentCount > 0) {
    console.log(
      `[Worker] Filtered ${adSegmentCount} ad segment(s) from playlist (${mediaSegments.length} media segments remain)`,
    );
  }

  // Size segmentData to match mediaSegments (what we actually download), not total segments
  const segmentData = useOPFS ? null : new Array(mediaSegments.length);

  let skippedFragments = 0;
  let totalBytesDownloaded = 0;
  let speedTrackStart = Date.now();
  let lastSpeedBytes = 0;
  let currentSpeed = 0;

  function getSpeedStr() {
    const now = Date.now();
    const elapsed = now - speedTrackStart;
    if (elapsed >= 1000) {
      currentSpeed = ((totalBytesDownloaded - lastSpeedBytes) / elapsed) * 1000;
      speedTrackStart = now;
      lastSpeedBytes = totalBytesDownloaded;
    }
    return currentSpeed > 0
      ? ` • ${formatBytes(Math.round(currentSpeed))}/s`
      : "";
  }

  const downloadPromises = mediaSegments.map((seg, i) =>
    pool
      .fetch(seg.url, i, {
        headers,
        timeout: SEGMENT_TIMEOUT,
        byteRange: seg.byteRange || null,
      })
      .then(async (data) => {
        if (isCancelled(downloadId)) return;

        if (hasEncryption && seg.key?.method === "AES-128" && seg.key?.uri) {
          const segKey = keyMap.get(seg.key.uri);
          if (!segKey) {
            console.error(
              `[Worker] No key found for segment ${i} (uri: ${seg.key.uri})`,
            );
            throw new Error(`Missing decryption key for segment ${i}`);
          }
          data = await decryptSegment(
            data,
            segKey,
            seg.iv || buildIV(seg.sequence),
          );
        }

        const segHash = hashSegmentData(data);
        if (seenHashes.has(segHash)) {
          skippedDupes++;
          console.log(
            `[Worker] Skipped duplicate segment ${i} (hash=${segHash})`,
          );
          completedSegments++;
          const pct = Math.floor(
            (completedSegments / mediaSegments.length) * 100,
          );
          const adStats =
            pool.stats.adBlocked > 0
              ? ` | ${pool.stats.adBlocked} ads blocked`
              : "";
          reportProgress(
            downloadId,
            "downloading",
            pct,
            `${completedSegments} / ${mediaSegments.length} segments${skippedDupes ? ` (${skippedDupes} dupes skipped)` : ""}${adStats}`,
          );
          return;
        }
        seenHashes.add(segHash);

        totalBytesDownloaded += data.byteLength;

        if (useOPFS) {
          // S36 fix: OPFS file handles may become stale after system sleep.
          // Retry with fresh handle if write fails.
          let writeSuccess = false;
          let attempts = 0;
          const maxAttempts = 3;

          while (!writeSuccess && attempts < maxAttempts) {
            attempts++;
            try {
              const segFile = await opfsDir.getFileHandle(
                `seg_${String(i).padStart(5, "0")}.bin`,
                { create: true },
              );
              const access = await segFile.createSyncAccessHandle();
              access.write(data);
              access.flush();
              access.close();
              writeSuccess = true;
            } catch (opfsErr) {
              if (attempts >= maxAttempts) {
                console.error(
                  `[Worker] OPFS write failed after ${attempts} attempts for segment ${i}:`,
                  opfsErr.message,
                );
                throw new Error(
                  `OPFS write failed (possibly after system sleep): ${opfsErr.message}`,
                );
              }
              console.warn(
                `[Worker] OPFS write attempt ${attempts} failed for segment ${i}, retrying... (${opfsErr.message})`,
              );
              // Wait a bit before retry to allow system to stabilize after wake
              await new Promise((r) => setTimeout(r, 1000 * attempts));
            }
          }
        } else {
          segmentData[i] = data;
        }

        completedSegments++;

        const pct = Math.floor(
          (completedSegments / mediaSegments.length) * 100,
        );
        const adStats =
          pool.stats.adBlocked > 0
            ? ` | ${pool.stats.adBlocked} ads blocked`
            : "";
        reportProgress(
          downloadId,
          "downloading",
          pct,
          `${completedSegments} / ${mediaSegments.length} segments${adStats}${getSpeedStr()}`,
        );
      })
      .catch((err) => {
        // yt-dlp inspired: skip unavailable fragments instead of aborting entire download
        // First segment is always fatal (like yt-dlp's is_fatal logic)
        if (i === 0) throw err;
        skippedFragments++;
        console.warn(
          `[Worker] Skipping unavailable segment ${i}: ${err.message} (${skippedFragments} skipped so far)`,
        );
        completedSegments++;
        const pct = Math.floor(
          (completedSegments / mediaSegments.length) * 100,
        );
        reportProgress(
          downloadId,
          "downloading",
          pct,
          `${completedSegments} / ${mediaSegments.length} segments (${skippedFragments} skipped)`,
        );
      }),
  );

  await Promise.all(downloadPromises);

  if (isCancelled(downloadId)) throw new Error("Cancelled");

  reportProgress(downloadId, "merging", 90, "Concatenating segments...");

  const isTS = mediaSegments.some((s) => /\.ts(\?|$)/i.test(s.url));
  const outputMimeType = isTS ? "video/mp2t" : "video/mp4";
  let outputBlob;
  let outputFilename = filename || "video.mp4";
  if (isTS) {
    outputFilename = outputFilename.replace(/\.\w+$/, ".ts");
  }

  // Detect audio codec from first downloaded segment's magic bytes (fallback)
  let detectedAudioCodec = null;
  if (isTS) {
    const firstSeg = useOPFS
      ? null
      : segmentData.find((s) => s && s.byteLength > 0);
    if (firstSeg) {
      detectedAudioCodec = detectAudioCodecFromTS(firstSeg);
      if (detectedAudioCodec) {
        console.log(
          `[Worker] Detected audio codec from TS data: ${detectedAudioCodec}`,
        );
      }
    }
  }

  if (useOPFS) {
    console.log(`[Worker] Merging segments from OPFS (disk-based)...`);

    const mergedFileHandle = await opfsDir.getFileHandle("merged_output.bin", {
      create: true,
    });
    const mergedAccess = await mergedFileHandle.createSyncAccessHandle();
    let writeOffset = 0;

    for (let i = 0; i < mediaSegments.length; i++) {
      try {
        const segName = `seg_${String(i).padStart(5, "0")}.bin`;
        const segFile = await opfsDir.getFileHandle(segName);
        const file = await segFile.getFile();
        const buffer = await file.arrayBuffer();
        mergedAccess.write(new Uint8Array(buffer), { at: writeOffset });
        writeOffset += buffer.byteLength;
        // Delete segment file immediately after merge — frees disk space progressively
        await opfsDir.removeEntry(segName).catch(() => {});
      } catch (e) {}
    }

    mergedAccess.flush();
    mergedAccess.close();

    console.log(
      `[Worker] Merged ${formatBytes(writeOffset)} to OPFS output file`,
    );

    const mergedFile = await mergedFileHandle.getFile();
    outputBlob = new Blob([mergedFile], { type: outputMimeType });

    console.log(
      `[Worker] OPFS merge complete (${formatBytes(mergedFile.size)}). Cleanup deferred until download finishes.`,
    );
  } else {
    let totalSize = 0;
    for (const seg of segmentData) {
      if (seg) totalSize += seg.byteLength;
    }

    const merged = new Uint8Array(totalSize);
    let offset = 0;
    for (let si = 0; si < segmentData.length; si++) {
      const seg = segmentData[si];
      if (seg) {
        merged.set(seg, offset);
        offset += seg.byteLength;
        segmentData[si] = null; // Free segment immediately after copying — reduces peak RAM
      }
    }
    outputBlob = new Blob([merged], { type: outputMimeType });
  }

  reportProgress(downloadId, "finalizing", 95, "Preparing file...");

  const blobUrl = URL.createObjectURL(outputBlob);

  return {
    blobUrl,
    filename: outputFilename,
    size: outputBlob.size,
    mimeType: outputBlob.type,
    segmentCount: mediaSegments.length,
    needsTransmux: isTS,
    audioCodec: detectedAudioCodec,

    opfsCleanupInfo: useOPFS ? { folder: opfsFolder } : null,
  };
}

async function downloadDASH(downloadId, mpdUrl, filename, headers = {}) {
  reportProgress(downloadId, "parsing", 0, "Fetching DASH manifest...");

  const resp = await fetch(mpdUrl, { headers, cache: "no-cache" });
  if (!resp.ok) throw new Error(`MPD fetch failed: HTTP ${resp.status}`);
  const mpdText = await resp.text();

  const baseUrl = mpdUrl.substring(0, mpdUrl.lastIndexOf("/") + 1);

  const representations = parseMPD(mpdText, baseUrl);
  if (representations.length === 0)
    throw new Error("No representations found in MPD");

  const videoReps = representations.filter((r) => r.type === "video");
  const audioReps = representations.filter((r) => r.type === "audio");

  videoReps.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
  audioReps.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));

  const bestVideo = videoReps[0];
  const bestAudio = audioReps[0];

  if (!bestVideo && !bestAudio)
    throw new Error("No video or audio representations found");

  const allSegments = [];
  if (bestVideo?.segments)
    allSegments.push(
      ...bestVideo.segments.map((s) => ({ ...s, track: "video" })),
    );
  if (bestAudio?.segments)
    allSegments.push(
      ...bestAudio.segments.map((s) => ({ ...s, track: "audio" })),
    );

  if (allSegments.length === 0)
    throw new Error("No segments found in DASH manifest");

  console.log(
    `[Worker] DASH: ${bestVideo?.segments?.length || 0} video + ${bestAudio?.segments?.length || 0} audio segments`,
  );

  const pool = new SegmentPool(MAX_CONCURRENT_SEGMENTS, MAX_SEGMENT_RETRIES);
  const state = activeDownloads.get(downloadId);
  if (state) state.pool = pool;

  const videoChunks = [];
  const audioChunks = [];
  let completed = 0;
  const total = allSegments.length;
  const seenHashes = new Set();
  let dashBytesDownloaded = 0;
  let dashSpeedStart = Date.now();
  let dashLastSpeedBytes = 0;
  let dashSpeed = 0;

  function getDashSpeedStr() {
    const now = Date.now();
    const elapsed = now - dashSpeedStart;
    if (elapsed >= 1000) {
      dashSpeed = ((dashBytesDownloaded - dashLastSpeedBytes) / elapsed) * 1000;
      dashSpeedStart = now;
      dashLastSpeedBytes = dashBytesDownloaded;
    }
    return dashSpeed > 0 ? ` • ${formatBytes(Math.round(dashSpeed))}/s` : "";
  }

  reportProgress(downloadId, "downloading", 0, `0 / ${total} segments`);

  let skippedFragments = 0;

  const promises = allSegments.map((seg, i) =>
    pool
      .fetch(seg.url, i, { headers, timeout: SEGMENT_TIMEOUT })
      .then((data) => {
        if (isCancelled(downloadId)) return;

        const segHash = hashSegmentData(data);
        if (seenHashes.has(segHash)) {
          console.log(
            `[Worker] Skipped duplicate DASH segment ${i} (${seg.track})`,
          );
          completed++;
          reportProgress(
            downloadId,
            "downloading",
            Math.floor((completed / total) * 100),
            `${completed} / ${total} segments`,
          );
          return;
        }
        seenHashes.add(segHash);

        if (seg.track === "video")
          videoChunks.push({ index: seg.index || i, data });
        else audioChunks.push({ index: seg.index || i, data });

        dashBytesDownloaded += data.byteLength;
        completed++;
        reportProgress(
          downloadId,
          "downloading",
          Math.floor((completed / total) * 100),
          `${completed} / ${total} segments${skippedFragments ? ` (${skippedFragments} skipped)` : ""}${getDashSpeedStr()}`,
        );
      })
      .catch((err) => {
        // yt-dlp inspired: skip unavailable fragments instead of aborting entire download
        // First segment of each track is always fatal (use seg.index, not allSegments index i)
        if (seg.index === 0 || (seg.index === undefined && i === 0)) throw err;
        skippedFragments++;
        console.warn(
          `[Worker] Skipping unavailable DASH segment ${i} (${seg.track}): ${err.message}`,
        );
        completed++;
        reportProgress(
          downloadId,
          "downloading",
          Math.floor((completed / total) * 100),
          `${completed} / ${total} segments (${skippedFragments} skipped)`,
        );
      }),
  );

  await Promise.all(promises);

  if (isCancelled(downloadId)) throw new Error("Cancelled");

  reportProgress(downloadId, "merging", 90, "Concatenating...");

  videoChunks.sort((a, b) => a.index - b.index);
  audioChunks.sort((a, b) => a.index - b.index);

  const concatChunks = (chunks) => {
    let size = 0;
    for (const c of chunks) size += c.data.byteLength;
    const result = new Uint8Array(size);
    let off = 0;
    for (let ci = 0; ci < chunks.length; ci++) {
      result.set(chunks[ci].data, off);
      off += chunks[ci].data.byteLength;
      chunks[ci].data = null; // Free chunk immediately after copying
    }
    return result;
  };

  if (videoChunks.length > 0 && audioChunks.length > 0) {
    const videoBlob = new Blob([concatChunks(videoChunks)], {
      type: "video/mp4",
    });
    const audioBlob = new Blob([concatChunks(audioChunks)], {
      type: "audio/mp4",
    });
    const videoBlobUrl = URL.createObjectURL(videoBlob);
    const audioBlobUrl = URL.createObjectURL(audioBlob);

    return {
      blobUrl: videoBlobUrl,
      audioBlobUrl,
      filename: filename || "video.mp4",
      size: videoBlob.size + audioBlob.size,
      mimeType: "video/mp4",
      needsMerge: true,
    };
  }

  const chunks = videoChunks.length > 0 ? videoChunks : audioChunks;
  const merged = concatChunks(chunks);
  const blob = new Blob([merged], { type: "video/mp4" });
  const blobUrl = URL.createObjectURL(blob);

  return {
    blobUrl,
    filename: filename || "video.mp4",
    size: blob.size,
    mimeType: "video/mp4",
  };
}

async function downloadMergedStreams(
  downloadId,
  videoUrl,
  audioUrl,
  filename,
  headers = {},
) {
  reportProgress(downloadId, "downloading", 0, "Downloading video + audio...");

  // Track combined download progress from both streams
  let videoDL = 0,
    videoTotal = 0;
  let audioDL = 0,
    audioTotal = 0;
  let lastPct = -1;

  function onVideoProgress(dl, total) {
    videoDL = dl;
    videoTotal = total;
    reportCombinedProgress();
  }
  function onAudioProgress(dl, total) {
    audioDL = dl;
    audioTotal = total;
    reportCombinedProgress();
  }
  function reportCombinedProgress() {
    const totalBytes = videoTotal + audioTotal;
    if (totalBytes <= 0) return;
    const pct = Math.min(
      Math.floor(((videoDL + audioDL) / totalBytes) * 85),
      85,
    );
    if (pct <= lastPct) return;
    lastPct = pct;
    const dlMB = ((videoDL + audioDL) / 1048576).toFixed(1);
    const totalMB = (totalBytes / 1048576).toFixed(1);
    reportProgress(downloadId, "downloading", pct, `${dlMB} / ${totalMB} MB`);
  }

  const [videoData, audioData] = await Promise.all([
    fetchFullFile(downloadId, videoUrl, headers, "video", onVideoProgress),
    fetchFullFile(downloadId, audioUrl, headers, "audio", onAudioProgress),
  ]);

  if (isCancelled(downloadId)) throw new Error("Cancelled");

  const videoBlob = new Blob([videoData], { type: "video/mp4" });
  const audioBlob = new Blob([audioData], { type: "audio/mp4" });
  const videoBlobUrl = URL.createObjectURL(videoBlob);
  const audioBlobUrl = URL.createObjectURL(audioBlob);

  reportProgress(downloadId, "merging", 90, "Tracks ready for merge...");

  return {
    blobUrl: videoBlobUrl,
    audioBlobUrl,
    filename: filename || "video.mp4",
    size: videoBlob.size + audioBlob.size,
    mimeType: "video/mp4",
    needsMerge: true,
  };
}

async function fetchFullFile(downloadId, url, headers, label, onProgress) {
  // Retry up to 3 times on transient errors (403, network errors)
  let resp;
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (isCancelled(downloadId)) throw new Error("Cancelled");
    if (attempt > 0) {
      const delay = 2000 * attempt;
      console.log(
        `[Worker] Retrying ${label} download after ${delay}ms (attempt ${attempt + 1}/3)`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
    try {
      resp = await fetch(url, { headers, cache: "no-cache" });
      if (resp.ok) break;
      if (resp.status === 403 || resp.status === 429) {
        lastErr = new Error(`${label}: HTTP ${resp.status}`);
        continue; // retry
      }
      throw new Error(`${label}: HTTP ${resp.status}`);
    } catch (fetchErr) {
      if (fetchErr.message?.startsWith(`${label}: HTTP`)) throw fetchErr;
      lastErr = fetchErr;
      if (attempt === 2)
        throw new Error(
          `${label}: network error after 3 attempts (${fetchErr.message})`,
        );
    }
  }
  if (!resp?.ok) throw lastErr || new Error(`${label}: download failed`);

  const contentLength = parseInt(resp.headers.get("content-length")) || 0;
  const reader = resp.body.getReader();
  let downloaded = 0;

  // Report initial total for progress tracking
  if (onProgress) onProgress(0, contentLength);

  if (contentLength > 0) {
    // Pre-allocate buffer when size is known — avoids 2× peak memory
    const result = new Uint8Array(contentLength);
    while (true) {
      if (isCancelled(downloadId)) {
        reader.cancel().catch(() => {});
        throw new Error("Cancelled");
      }
      const { done, value } = await reader.read();
      if (done) break;
      const safeLen = Math.min(value.byteLength, contentLength - downloaded);
      if (safeLen > 0) result.set(value.subarray(0, safeLen), downloaded);
      downloaded += value.byteLength;
      if (onProgress) onProgress(downloaded, contentLength);
    }
    return downloaded < contentLength ? result.subarray(0, downloaded) : result;
  }

  // Unknown size: accumulate then combine
  const chunks = [];
  while (true) {
    if (isCancelled(downloadId)) {
      reader.cancel().catch(() => {});
      throw new Error("Cancelled");
    }
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    downloaded += value.byteLength;
    if (onProgress) onProgress(downloaded, 0);
  }

  const result = new Uint8Array(downloaded);
  let offset = 0;
  for (let ci = 0; ci < chunks.length; ci++) {
    result.set(chunks[ci], offset);
    offset += chunks[ci].byteLength;
    chunks[ci] = null; // Free chunk after copying
  }
  return result;
}

function parseM3U8MasterPlaylist(text, baseUrl) {
  const variants = [];
  const audioTracks = [];
  const lines = text.split("\n").map((l) => l.trim());

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("#EXT-X-MEDIA:")) {
      const attrs = parseM3U8Attrs(lines[i].substring("#EXT-X-MEDIA:".length));
      if (attrs.TYPE === "AUDIO" && attrs.URI) {
        audioTracks.push({
          url: resolveUrl(attrs.URI.replace(/"/g, ""), baseUrl),
          groupId: attrs["GROUP-ID"] || "",
          name: attrs.NAME || "Audio",
          language: attrs.LANGUAGE || "",
          isDefault: attrs.DEFAULT === "YES",
        });
        console.log(
          `[Worker] Found separate audio track: ${attrs.NAME} (${attrs.LANGUAGE || "unknown lang"})`,
        );
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("#EXT-X-STREAM-INF:")) {
      const attrs = parseM3U8Attrs(
        lines[i].substring("#EXT-X-STREAM-INF:".length),
      );

      let url = null;
      for (let j = i + 1; j < lines.length; j++) {
        const line = lines[j];
        if (line && !line.startsWith("#")) {
          url = resolveUrl(line, baseUrl);
          break;
        }
      }
      if (url) {
        const audioGroupId = attrs.AUDIO;
        const hasAudio = attrs.CODECS && /mp4a|aac|mp3/i.test(attrs.CODECS);
        const needsAudioTrack = audioGroupId && audioTracks.length > 0;

        variants.push({
          url,
          bandwidth: parseInt(attrs.BANDWIDTH) || 0,
          resolution: attrs.RESOLUTION || "",
          codecs: attrs.CODECS || "",
          audioGroupId: audioGroupId || null,
          hasAudio: hasAudio || !needsAudioTrack,
          audioTracks: needsAudioTrack
            ? audioTracks.filter((a) => a.groupId === audioGroupId)
            : [],
        });
      }
    }
  }

  return variants;
}

/**
 * Parse M3U8 media playlist with ad segment detection.
 *
 * Inspired by yt-dlp's HLS downloader:
 * - Detects Anvato ad tags (#ANVATO-SEGMENT-INFO type=ad/master)
 * - Detects Uplynk ad tags (#UPLYNK-SEGMENT ending with ,ad/,segment)
 * - Uses EXT-X-DISCONTINUITY + duration heuristics to identify likely ad segments
 *   (short segments immediately after a discontinuity, especially with different
 *   CDN domains, are likely ads)
 * - Marks ad segments with isAd=true so the downloader can skip them
 */
function parseM3U8MediaPlaylist(text, baseUrl) {
  const segments = [];
  const lines = text.split("\n").map((l) => l.trim());
  let sequence = 0;
  let currentKey = null;
  let inAdRegion = false;
  let discontinuityCount = 0;
  let afterDiscontinuity = false;
  let discontinuitySegCount = 0;
  // Track durations per discontinuity region for ad heuristic
  const regionDurations = [];
  let currentRegionDuration = 0;
  // ── EXT-X-BYTERANGE state (RFC 8216 §4.3.2.2) ──
  // Tracks pending byte-range for the next segment URI.
  // If offset is omitted, it equals the byte after the end of the previous
  // sub-range of the same resource.
  let pendingByteRange = null;
  let lastByteEnd = 0; // running end-offset for implicit offset calculation

  // ── Pass 1: Detect vendor-specific ad markers (yt-dlp technique) ──
  function isAdFragmentStart(s) {
    return (
      (s.startsWith("#ANVATO-SEGMENT-INFO") && s.includes("type=ad")) ||
      (s.startsWith("#UPLYNK-SEGMENT") && s.endsWith(",ad"))
    );
  }

  function isAdFragmentEnd(s) {
    return (
      (s.startsWith("#ANVATO-SEGMENT-INFO") && s.includes("type=master")) ||
      (s.startsWith("#UPLYNK-SEGMENT") && s.endsWith(",segment"))
    );
  }

  // ── Pass 1: Build segments with ad flags ──
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      sequence = parseInt(line.split(":")[1]) || 0;
    }

    // Vendor-specific ad markers (from yt-dlp)
    if (isAdFragmentStart(line)) {
      inAdRegion = true;
      continue;
    }
    if (isAdFragmentEnd(line)) {
      inAdRegion = false;
      continue;
    }

    // Track discontinuity boundaries (potential ad insertion points)
    if (line.startsWith("#EXT-X-DISCONTINUITY")) {
      discontinuityCount++;
      afterDiscontinuity = true;
      discontinuitySegCount = 0;
      // Save previous region duration
      if (currentRegionDuration > 0) {
        regionDurations.push(currentRegionDuration);
      }
      currentRegionDuration = 0;
      continue;
    }

    // ── EXT-X-BYTERANGE (RFC 8216 §4.3.2.2) ──
    // Format: #EXT-X-BYTERANGE:<length>[@<offset>]
    // If offset is omitted, it starts at the byte following the previous
    // sub-range of the same resource or 0 if there is no previous sub-range.
    if (line.startsWith("#EXT-X-BYTERANGE:")) {
      const val = line.substring("#EXT-X-BYTERANGE:".length);
      const atIdx = val.indexOf("@");
      if (atIdx !== -1) {
        const length = parseInt(val.substring(0, atIdx), 10);
        const offset = parseInt(val.substring(atIdx + 1), 10);
        pendingByteRange = { offset, length };
        lastByteEnd = offset + length;
      } else {
        const length = parseInt(val, 10);
        pendingByteRange = { offset: lastByteEnd, length };
        lastByteEnd = lastByteEnd + length;
      }
      continue;
    }

    if (line.startsWith("#EXT-X-KEY:")) {
      const attrs = parseM3U8Attrs(line.substring("#EXT-X-KEY:".length));
      currentKey = {
        method: attrs.METHOD || "NONE",
        uri: attrs.URI
          ? resolveUrl(attrs.URI.replace(/"/g, ""), baseUrl)
          : null,
        iv: attrs.IV || null,
      };
    }

    if (line.startsWith("#EXT-X-MAP:")) {
      const attrs = parseM3U8Attrs(line.substring("#EXT-X-MAP:".length));
      if (attrs.URI) {
        // Parse optional BYTERANGE attribute on #EXT-X-MAP (RFC 8216 §4.3.2.5)
        let mapByteRange = null;
        if (attrs.BYTERANGE) {
          const brVal = attrs.BYTERANGE.replace(/"/g, "");
          const atIdx = brVal.indexOf("@");
          if (atIdx !== -1) {
            const length = parseInt(brVal.substring(0, atIdx), 10);
            const offset = parseInt(brVal.substring(atIdx + 1), 10);
            mapByteRange = { offset, length };
          } else {
            const length = parseInt(brVal, 10);
            mapByteRange = { offset: 0, length }; // MAP BYTERANGE default offset is 0
          }
        }
        segments.push({
          url: resolveUrl(attrs.URI.replace(/"/g, ""), baseUrl),
          isInit: true,
          isAd: false,
          sequence: -1,
          byteRange: mapByteRange,
          key: currentKey?.method !== "NONE" ? currentKey : null,
          iv: currentKey?.iv,
        });
      }
    }

    if (line.startsWith("#EXTINF:")) {
      const duration = parseFloat(line.split(":")[1]) || 0;
      currentRegionDuration += duration;

      for (let j = i + 1; j < lines.length; j++) {
        const segLine = lines[j];
        if (segLine && !segLine.startsWith("#")) {
          const segUrl = resolveUrl(segLine, baseUrl);

          // Determine if this is an ad segment
          let isAd = inAdRegion;

          // Heuristic: If we just crossed a discontinuity and the segment
          // duration is very short (< 1s) and we're in the first 2 segments
          // of this region, it's likely an ad bumper/pre-roll
          if (
            !isAd &&
            afterDiscontinuity &&
            discontinuitySegCount < 2 &&
            duration < 1.0 &&
            discontinuityCount > 0
          ) {
            // Only flag if this appears to be a different CDN (URL domain mismatch)
            try {
              const segDomain = new URL(segUrl).hostname;
              const baseDomain = new URL(baseUrl).hostname;
              if (segDomain !== baseDomain) {
                isAd = true;
              }
            } catch (e) {
              // If URL parsing fails, don't flag
            }
          }

          segments.push({
            url: segUrl,
            isInit: false,
            isAd,
            sequence: sequence++,
            duration,
            byteRange: pendingByteRange || null,
            key: currentKey?.method !== "NONE" ? currentKey : null,
            iv: currentKey?.iv,
          });
          pendingByteRange = null; // consumed
          discontinuitySegCount++;
          if (discontinuitySegCount >= 3) afterDiscontinuity = false;
          break;
        }
      }
    }
  }

  // Save last region
  if (currentRegionDuration > 0) {
    regionDurations.push(currentRegionDuration);
  }

  // ── Pass 2 (optional): Detect short discontinuity regions as ads ──
  // If we have multiple discontinuity regions, very short ones (< 15s total)
  // surrounded by long regions are likely ad breaks
  if (discontinuityCount > 0 && regionDurations.length > 2) {
    const avgDuration =
      regionDurations.reduce((a, b) => a + b, 0) / regionDurations.length;
    const adThreshold = Math.min(15, avgDuration * 0.15);

    let regionIdx = 0;
    let runningDuration = 0;
    for (const seg of segments) {
      if (seg.isInit) continue;
      runningDuration += seg.duration || 0;

      // Check if this region is suspiciously short
      if (
        regionIdx < regionDurations.length &&
        regionDurations[regionIdx] < adThreshold &&
        regionIdx > 0 && // Never flag the first region
        regionIdx < regionDurations.length - 1 // Never flag the last region
      ) {
        seg.isAd = true;
      }

      // Move to next region at discontinuity boundaries
      if (
        regionIdx < regionDurations.length &&
        runningDuration >= regionDurations[regionIdx]
      ) {
        regionIdx++;
        runningDuration = 0;
      }
    }
  }

  const adCount = segments.filter((s) => s.isAd).length;
  if (adCount > 0) {
    console.log(
      `[Worker] Playlist analysis: ${segments.length} total segments, ${adCount} identified as ads (${discontinuityCount} discontinuities)`,
    );
  }

  return segments;
}

function parseM3U8Attrs(str) {
  const attrs = {};

  const re = /([A-Z0-9_-]+)=("(?:[^"\\]|\\.)*"|[^,]*)/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    let val = m[2];
    if (val.startsWith('"') && val.endsWith('"')) {
      val = val.slice(1, -1);
    }
    attrs[m[1]] = val;
  }
  return attrs;
}

/**
 * Resolve ALL unique AES-128 keys referenced in the playlist.
 * Returns a Map<keyURI, CryptoKey> so each segment can look up its own key.
 * Supports key rotation: playlists with multiple EXT-X-KEY tags pointing
 * to different URIs will have each key fetched and imported once.
 */
async function resolveAllM3U8Keys(segments, headers) {
  const keyMap = new Map(); // uri → CryptoKey
  const uniqueUris = new Set();

  for (const seg of segments) {
    if (seg.key?.method === "AES-128" && seg.key?.uri) {
      uniqueUris.add(seg.key.uri);
    }
  }

  if (uniqueUris.size === 0) return keyMap;

  console.log(`[Worker] Resolving ${uniqueUris.size} unique encryption key(s)`);

  // Notify background about key server domains that may need DNR header rules.
  // The main stream DNR rule only covers the segment host — key URIs may be
  // on a different domain that also needs Referer/auth headers.
  try {
    const keyHosts = new Set();
    for (const uri of uniqueUris) {
      try {
        keyHosts.add(new URL(uri).hostname);
      } catch (_) {}
    }
    if (keyHosts.size > 0) {
      self.postMessage({
        name: "key_domains_discovered",
        hosts: [...keyHosts],
      });
    }
  } catch (_) {}

  for (const uri of uniqueUris) {
    try {
      const resp = await fetch(uri, { headers, cache: "no-cache" });
      if (!resp.ok)
        throw new Error(`Key fetch failed: HTTP ${resp.status} for ${uri}`);
      const keyData = await resp.arrayBuffer();

      if (keyData.byteLength !== 16) {
        console.warn(
          `[Worker] Key from ${uri} is ${keyData.byteLength} bytes (expected 16). Attempting import anyway.`,
        );
      }

      const cryptoKey = await crypto.subtle.importKey(
        "raw",
        keyData,
        "AES-CBC",
        false,
        ["decrypt"],
      );
      keyMap.set(uri, cryptoKey);
      console.log(`[Worker] Imported key from ${uri}`);
    } catch (err) {
      console.error(`[Worker] Failed to resolve key ${uri}:`, err.message);
      throw err;
    }
  }

  return keyMap;
}

/** @deprecated Use resolveAllM3U8Keys instead */
async function resolveM3U8Key(segments, headers) {
  const keyMap = await resolveAllM3U8Keys(segments, headers);
  if (keyMap.size === 0) return null;
  return keyMap.values().next().value;
}

function buildIV(sequence) {
  const iv = new Uint8Array(16);
  const view = new DataView(iv.buffer);
  view.setUint32(12, sequence, false);
  return iv;
}

async function decryptSegment(data, key, iv) {
  let ivBytes;
  if (typeof iv === "string") {
    const hex = iv.startsWith("0x") ? iv.substring(2) : iv;
    ivBytes = new Uint8Array(hex.match(/.{1,2}/g).map((b) => parseInt(b, 16)));
  } else {
    ivBytes = iv;
  }

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-CBC", iv: ivBytes },
    key,
    data.buffer,
  );
  return new Uint8Array(decrypted);
}

function parseMPD(mpdText, baseUrl) {
  const representations = [];

  // Handle multi-Period MPDs: extract <Period> blocks, or treat entire doc as single period
  const periodRe = /<Period([^>]*)>([\s\S]*?)<\/Period>/gi;
  const periods = [];
  let pm;
  while ((pm = periodRe.exec(mpdText)) !== null) {
    periods.push({ attrs: pm[1], content: pm[2] });
  }
  // If no <Period> tags found, treat the entire MPD as one period
  if (periods.length === 0) {
    periods.push({ attrs: "", content: mpdText });
  }

  let periodSegmentOffset = 0; // Cumulative segment index offset for multi-Period

  for (const period of periods) {
    const periodContent = period.content;
    const adaptationRe = /<AdaptationSet([^>]*)>([\s\S]*?)<\/AdaptationSet>/gi;
    let am;

    while ((am = adaptationRe.exec(periodContent)) !== null) {
      const setAttrs = am[1];
      const setContent = am[2];
      const mimeType = extractAttr(setAttrs, "mimeType") || "";
      const contentType = extractAttr(setAttrs, "contentType") || "";
      const type =
        mimeType.startsWith("video") || contentType === "video"
          ? "video"
          : "audio";

      const repRe =
        /<Representation([^>]*)(?:\/>|>([\s\S]*?)<\/Representation>)/gi;
      let rm;

      while ((rm = repRe.exec(setContent)) !== null) {
        const repAttrs = rm[1];
        const repContent = rm[2] || "";
        const bandwidth = parseInt(extractAttr(repAttrs, "bandwidth")) || 0;
        const width = parseInt(extractAttr(repAttrs, "width")) || 0;
        const height = parseInt(extractAttr(repAttrs, "height")) || 0;
        const id = extractAttr(repAttrs, "id") || "";

        const segments = extractDASHSegments(
          setContent + repContent,
          baseUrl,
          id,
        );

        // For multi-Period, offset segment indices so they don't overlap
        if (periodSegmentOffset > 0) {
          for (const seg of segments) {
            seg.index += periodSegmentOffset;
          }
        }

        // Try to append to an existing representation with the same id+type
        // (multi-Period: same representation spans multiple periods)
        const existing = representations.find(
          (r) => r.id === id && r.type === type,
        );
        if (existing) {
          existing.segments.push(...segments);
        } else {
          representations.push({
            type,
            bandwidth,
            width,
            height,
            id,
            mimeType,
            segments,
          });
        }
      }
    }

    // Track the max segment index from this period for offset calculation
    let maxIdx = 0;
    for (const r of representations) {
      for (const s of r.segments) {
        if (s.index > maxIdx) maxIdx = s.index;
      }
    }
    periodSegmentOffset = maxIdx;
  }

  return representations;
}

function extractDASHSegments(content, baseUrl, repId) {
  const segments = [];

  const templateMatch =
    /<SegmentTemplate([^>]*)(?:\/>|>([\s\S]*?)<\/SegmentTemplate>)/i.exec(
      content,
    );
  if (templateMatch) {
    const tAttrs = templateMatch[1];
    const tContent = templateMatch[2] || "";
    const media = extractAttr(tAttrs, "media") || "";
    const init = extractAttr(tAttrs, "initialization") || "";
    const startNumber = parseInt(extractAttr(tAttrs, "startNumber")) || 1;
    const timescale = parseInt(extractAttr(tAttrs, "timescale")) || 1;

    if (init) {
      const initUrl = resolveUrl(
        init.replace("$RepresentationID$", repId),
        baseUrl,
      );
      segments.push({ url: initUrl, isInit: true, index: 0 });
    }

    const timelineRe =
      /<S\s+(?:t="(\d+)"\s+)?d="(\d+)"(?:\s+r="(-?\d+)")?\s*\/>/g;
    let tm;
    let segIndex = 1;
    let time = 0;

    // Collect all S elements first to handle negative @r (look-ahead needed)
    const sElements = [];
    while ((tm = timelineRe.exec(tContent)) !== null) {
      sElements.push({
        t: tm[1] ? parseInt(tm[1]) : null,
        d: parseInt(tm[2]),
        r: parseInt(tm[3] || "0"),
      });
    }

    // Extract total period/MPD duration for the final negative-r calculation
    const totalDur = extractMPDDuration(content) || 0;
    const totalTimescaled = totalDur > 0 ? totalDur * timescale : 0;

    for (let si = 0; si < sElements.length; si++) {
      const s = sElements[si];
      if (s.t !== null) time = s.t;
      const duration = s.d;
      let count;

      if (s.r >= 0) {
        count = s.r + 1;
      } else {
        // Negative r: repeat until the next S element's @t, or period end
        const nextT =
          si + 1 < sElements.length && sElements[si + 1].t !== null
            ? sElements[si + 1].t
            : totalTimescaled > 0
              ? totalTimescaled
              : 0;
        count =
          nextT > time && duration > 0
            ? Math.ceil((nextT - time) / duration)
            : 1;
      }

      for (let r = 0; r < count; r++) {
        const segUrl = media
          .replace("$RepresentationID$", repId)
          .replace("$Number$", String(startNumber + segIndex - 1))
          .replace("$Time$", String(time));
        segments.push({
          url: resolveUrl(segUrl, baseUrl),
          isInit: false,
          index: segIndex++,
          time,
          duration,
        });
        time += duration;
      }
    }

    if (segments.length <= 1) {
      const duration = parseInt(extractAttr(tAttrs, "duration")) || 0;
      const totalDuration = extractMPDDuration(content) || 0;
      if (duration > 0 && totalDuration > 0) {
        const count = Math.ceil((totalDuration * timescale) / duration);
        for (let i = 0; i < count; i++) {
          const num = startNumber + i;
          const segUrl = media
            .replace("$RepresentationID$", repId)
            .replace("$Number$", String(num));
          segments.push({
            url: resolveUrl(segUrl, baseUrl),
            isInit: false,
            index: i + 1,
          });
        }
      }
    }

    return segments;
  }

  const listMatch = /<SegmentList([^>]*)>([\s\S]*?)<\/SegmentList>/i.exec(
    content,
  );
  if (listMatch) {
    const listContent = listMatch[2];

    const initMatch = /<Initialization\s+sourceURL="([^"]+)"/i.exec(
      listContent,
    );
    if (initMatch) {
      segments.push({
        url: resolveUrl(initMatch[1], baseUrl),
        isInit: true,
        index: 0,
      });
    }

    const segRe = /<SegmentURL\s+media="([^"]+)"/gi;
    let sm;
    let idx = 1;
    while ((sm = segRe.exec(listContent)) !== null) {
      segments.push({
        url: resolveUrl(sm[1], baseUrl),
        isInit: false,
        index: idx++,
      });
    }

    return segments;
  }

  const baseUrlMatch = /<BaseURL>([^<]+)<\/BaseURL>/i.exec(content);
  if (baseUrlMatch) {
    segments.push({
      url: resolveUrl(baseUrlMatch[1].trim(), baseUrl),
      isInit: false,
      index: 0,
    });
  }

  return segments;
}

function extractAttr(attrStr, name) {
  const re = new RegExp(`${name}="([^"]*)"`, "i");
  const m = re.exec(attrStr);
  return m ? m[1] : null;
}

function extractMPDDuration(text) {
  const m =
    /mediaPresentationDuration="PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?"/i.exec(
      text,
    );
  if (!m) return 0;
  return (
    (parseInt(m[1]) || 0) * 3600 +
    (parseInt(m[2]) || 0) * 60 +
    (parseFloat(m[3]) || 0)
  );
}

function resolveUrl(url, baseUrl) {
  if (!url) return url;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("//")) return "https:" + url;
  if (url.startsWith("/")) {
    try {
      const base = new URL(baseUrl);
      return base.origin + url;
    } catch {
      return url;
    }
  }

  return baseUrl + url;
}

function isCancelled(downloadId) {
  const state = activeDownloads.get(downloadId);
  return state?.cancelled === true;
}

function cancelDownload(downloadId) {
  const state = activeDownloads.get(downloadId);
  if (state) {
    state.cancelled = true;
    state.pool?.cancel();
  }
}

/**
 * S35 fix: Handle URL refresh message from background (YouTube URL expiry).
 * Updates the segment pool with fresh URLs and resolves the pending promise.
 */
function handleUrlRefresh(data) {
  const { downloadId, urlMap } = data;
  const state = activeDownloads.get(downloadId);
  if (!state) {
    console.warn(`[Worker] URL refresh for unknown download ${downloadId}`);
    return;
  }

  if (state.pool && urlMap) {
    console.log(`[Worker] Applying fresh URLs to pool for ${downloadId}`);
    // Clear the refresh timeout and resolve the pending promise with the urlMap
    if (state.urlRefreshTimer) {
      clearTimeout(state.urlRefreshTimer);
      state.urlRefreshTimer = null;
    }
    if (state.urlRefreshResolve) {
      state.urlRefreshResolve(urlMap);
      state.urlRefreshResolve = null;
      state.urlRefreshReject = null;
    }
  }
}

function reportProgress(downloadId, phase, percent, message) {
  self.postMessage({
    name: "download_progress",
    data: { download_id: downloadId, phase, percent, message },
  });
}

function reportError(downloadId, message) {
  self.postMessage({
    name: "download_error",
    data: { download_id: downloadId, error: message },
  });
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + " MB";
  return (bytes / 1073741824).toFixed(2) + " GB";
}

/**
 * Extract audio codec identifier from HLS CODECS attribute string.
 * e.g. "avc1.640028,mp4a.40.2" → "aac"
 *      "avc1.640028,mp4a.40.5" → "aac"
 *      "avc1.640028,ac-3"      → "ac3"
 *      "avc1.640028,ec-3"      → "eac3"
 *      "avc1.640028,opus"      → "opus"
 *      "avc1.640028,vorbis"    → "vorbis"
 *      "avc1.640028,mp4a.69"   → "mp3"
 *      "avc1.640028,mp4a.6B"   → "mp3"
 */
function extractAudioCodecFromCodecs(codecsStr) {
  if (!codecsStr) return null;

  const parts = codecsStr.split(",").map((s) => s.trim().toLowerCase());

  for (const p of parts) {
    // AAC variants (mp4a.40.x)
    if (p.startsWith("mp4a.40.")) return "aac";
    // MP3 in MP4 (mp4a.69 or mp4a.6b)
    if (p === "mp4a.69" || p === "mp4a.6b") return "mp3";
    // Generic mp4a without sub-profile — assume AAC
    if (p.startsWith("mp4a.")) return "aac";
    // Opus
    if (p === "opus" || p.startsWith("opus")) return "opus";
    // Vorbis
    if (p === "vorbis") return "vorbis";
    // AC-3 / E-AC-3
    if (p === "ac-3") return "ac3";
    if (p === "ec-3") return "eac3";
    // FLAC
    if (p === "flac" || p === "fLaC") return "flac";
  }

  return null;
}

/**
 * Detect audio codec from MPEG-TS segment magic bytes.
 * Scans the first few TS packets looking for PES stream IDs that
 * indicate the audio codec type.
 *
 * MPEG-TS audio stream IDs:
 * - 0xC0-0xDF: MPEG audio (MP2/MP3)
 * - 0xBD: Private stream 1 (AC-3, E-AC-3, DTS)
 * - PMT stream_type: 0x0F = AAC, 0x03/0x04 = MP3, 0x81 = AC-3, 0x87 = E-AC-3
 */
function detectAudioCodecFromTS(data) {
  if (!data || data.byteLength < 188) return null;

  // Scan PMT (Program Map Table) for stream_type identifiers
  const packetCount = Math.min(Math.floor(data.byteLength / 188), 50);

  for (let p = 0; p < packetCount; p++) {
    const offset = p * 188;

    // Verify TS sync byte
    if (data[offset] !== 0x47) continue;

    // Look for PMT table_id = 0x02 in payload
    const payloadStart = offset + 4;
    const hasAdaptation = (data[offset + 3] & 0x20) !== 0;
    const hasPayload = (data[offset + 3] & 0x10) !== 0;
    if (!hasPayload) continue;

    let payloadOffset = payloadStart;
    if (hasAdaptation) {
      const adaptLen = data[payloadStart];
      payloadOffset = payloadStart + 1 + adaptLen;
    }

    if (payloadOffset >= offset + 188) continue;

    // Check for pointer field (PUSI bit)
    const pusi = (data[offset + 1] & 0x40) !== 0;
    if (pusi && payloadOffset < offset + 187) {
      const pointerField = data[payloadOffset];
      payloadOffset += 1 + pointerField;
    }

    if (payloadOffset >= offset + 185) continue;

    // Check for PMT table_id
    if (data[payloadOffset] === 0x02) {
      // Parse PMT to find audio stream_type
      const sectionLength =
        ((data[payloadOffset + 1] & 0x0f) << 8) | data[payloadOffset + 2];
      const progInfoLen =
        ((data[payloadOffset + 10] & 0x0f) << 8) | data[payloadOffset + 11];
      let esOffset = payloadOffset + 12 + progInfoLen;
      const sectionEnd = payloadOffset + 3 + sectionLength - 4; // exclude CRC

      while (esOffset + 5 <= sectionEnd && esOffset < offset + 188) {
        const streamType = data[esOffset];
        const esInfoLen =
          ((data[esOffset + 3] & 0x0f) << 8) | data[esOffset + 4];
        esOffset += 5 + esInfoLen;

        // Audio stream types
        switch (streamType) {
          case 0x0f:
            return "aac"; // AAC (ADTS)
          case 0x11:
            return "aac"; // AAC (LATM)
          case 0x03:
            return "mp3"; // MPEG-1 Audio Layer III
          case 0x04:
            return "mp3"; // MPEG-2 Audio Layer III
          case 0x81:
            return "ac3"; // AC-3
          case 0x87:
            return "eac3"; // E-AC-3
          case 0x06: // PES private data (could be AC-3 or other)
            // Ambiguous — don't guess, let ffprobe handle it
            break;
        }
      }
    }
  }

  return null;
}

console.log("[Worker] Download worker ready");
