importScripts("segment-pool.js");

const MAX_CONCURRENT_SEGMENTS = 4;
const MAX_SEGMENT_RETRIES = 3;
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

    case "ping":
      self.postMessage({ name: "pong" });
      break;
  }
};

async function handleDownload(data) {
  const { download_id, url, audioUrl, filename, type, headers } = data;

  activeDownloads.set(download_id, { cancelled: false, pool: null });

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

  const resp = await fetch(url, { headers, cache: "no-cache" });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

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
      console.warn(
        `[Worker] Separate audio track detected but merge not yet implemented. Audio may be missing!`,
      );
      console.warn(`[Worker] Audio track URL: ${best.audioTracks[0].url}`);
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

  const encKey = await resolveM3U8Key(segments, headers);

  const pool = new SegmentPool(MAX_CONCURRENT_SEGMENTS, MAX_SEGMENT_RETRIES);
  const state = activeDownloads.get(downloadId);
  if (state) state.pool = pool;

  const estimatedSize = segments.length * 1024 * 1024;
  const useOPFS = OPFS_ENABLED && estimatedSize > RAM_THRESHOLD;

  if (useOPFS) {
    console.log(
      `[Worker] Large download detected (~${Math.floor(estimatedSize / 1024 / 1024)}MB estimated). Using OPFS disk storage.`,
    );
  }

  const segmentData = useOPFS ? null : new Array(segments.length);
  const opfsRoot = useOPFS ? await navigator.storage.getDirectory() : null;
  const opfsFolder = useOPFS ? `m3u8_${downloadId}_${Date.now()}` : null;
  const opfsDir = useOPFS
    ? await opfsRoot.getDirectoryHandle(opfsFolder, { create: true })
    : null;

  let completedSegments = 0;
  const seenHashes = new Set();
  let skippedDupes = 0;

  const downloadPromises = segments.map((seg, i) =>
    pool
      .fetch(seg.url, i, { headers, timeout: SEGMENT_TIMEOUT })
      .then(async (data) => {
        if (isCancelled(downloadId)) return;

        if (encKey && seg.key) {
          data = await decryptSegment(
            data,
            encKey,
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
          const pct = Math.floor((completedSegments / segments.length) * 100);
          reportProgress(
            downloadId,
            "downloading",
            pct,
            `${completedSegments} / ${segments.length} segments${skippedDupes ? ` (${skippedDupes} dupes skipped)` : ""}`,
          );
          return;
        }
        seenHashes.add(segHash);

        if (useOPFS) {

          const segFile = await opfsDir.getFileHandle(
            `seg_${String(i).padStart(5, "0")}.bin`,
            { create: true },
          );
          const access = await segFile.createSyncAccessHandle();
          access.write(data);
          access.flush();
          access.close();
        } else {

          segmentData[i] = data;
        }

        completedSegments++;

        const pct = Math.floor((completedSegments / segments.length) * 100);
        reportProgress(
          downloadId,
          "downloading",
          pct,
          `${completedSegments} / ${segments.length} segments`,
        );
      }),
  );

  await Promise.all(downloadPromises);

  if (isCancelled(downloadId)) throw new Error("Cancelled");

  reportProgress(downloadId, "merging", 90, "Concatenating segments...");

  const isTS = segments.some((s) => /\.ts(\?|$)/i.test(s.url));
  const outputMimeType = isTS ? "video/mp2t" : "video/mp4";
  let outputBlob;
  let outputFilename = filename || "video.mp4";
  if (isTS) {
    outputFilename = outputFilename.replace(/\.\w+$/, ".ts");
  }

  if (useOPFS) {

    console.log(`[Worker] Merging segments from OPFS (disk-based)...`);

    const mergedFileHandle = await opfsDir.getFileHandle("merged_output.bin", {
      create: true,
    });
    const mergedAccess = await mergedFileHandle.createSyncAccessHandle();
    let writeOffset = 0;

    for (let i = 0; i < segments.length; i++) {
      try {
        const segFile = await opfsDir.getFileHandle(
          `seg_${String(i).padStart(5, "0")}.bin`,
        );
        const file = await segFile.getFile();
        const buffer = await file.arrayBuffer();
        mergedAccess.write(new Uint8Array(buffer), { at: writeOffset });
        writeOffset += buffer.byteLength;
      } catch (e) {

      }
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
    for (const seg of segmentData) {
      if (seg) {
        merged.set(seg, offset);
        offset += seg.byteLength;
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
    segmentCount: segments.length,
    needsTransmux: isTS,

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

  reportProgress(downloadId, "downloading", 0, `0 / ${total} segments`);

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

        completed++;
        reportProgress(
          downloadId,
          "downloading",
          Math.floor((completed / total) * 100),
          `${completed} / ${total} segments`,
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
    for (const c of chunks) {
      result.set(c.data, off);
      off += c.data.byteLength;
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

  const [videoData, audioData] = await Promise.all([
    fetchFullFile(downloadId, videoUrl, headers, "video"),
    fetchFullFile(downloadId, audioUrl, headers, "audio"),
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

async function fetchFullFile(downloadId, url, headers, label) {
  const resp = await fetch(url, { headers, cache: "no-cache" });
  if (!resp.ok) throw new Error(`${label}: HTTP ${resp.status}`);

  const contentLength = parseInt(resp.headers.get("content-length")) || 0;
  const reader = resp.body.getReader();
  const chunks = [];
  let downloaded = 0;

  while (true) {
    if (isCancelled(downloadId)) throw new Error("Cancelled");
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    downloaded += value.byteLength;
  }

  let totalSize = 0;
  for (const c of chunks) totalSize += c.byteLength;
  const result = new Uint8Array(totalSize);
  let offset = 0;
  for (const c of chunks) {
    result.set(c, offset);
    offset += c.byteLength;
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

function parseM3U8MediaPlaylist(text, baseUrl) {
  const segments = [];
  const lines = text.split("\n").map((l) => l.trim());
  let sequence = 0;
  let currentKey = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      sequence = parseInt(line.split(":")[1]) || 0;
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
        segments.push({
          url: resolveUrl(attrs.URI.replace(/"/g, ""), baseUrl),
          isInit: true,
          sequence: -1,
          key: currentKey?.method !== "NONE" ? currentKey : null,
          iv: currentKey?.iv,
        });
      }
    }

    if (line.startsWith("#EXTINF:")) {

      for (let j = i + 1; j < lines.length; j++) {
        const segLine = lines[j];
        if (segLine && !segLine.startsWith("#")) {
          segments.push({
            url: resolveUrl(segLine, baseUrl),
            isInit: false,
            sequence: sequence++,
            duration: parseFloat(line.split(":")[1]) || 0,
            key: currentKey?.method !== "NONE" ? currentKey : null,
            iv: currentKey?.iv,
          });
          break;
        }
      }
    }
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

async function resolveM3U8Key(segments, headers) {
  const keySeg = segments.find(
    (s) => s.key?.method === "AES-128" && s.key?.uri,
  );
  if (!keySeg) return null;

  const resp = await fetch(keySeg.key.uri, { headers, cache: "no-cache" });
  if (!resp.ok) throw new Error(`Key fetch failed: HTTP ${resp.status}`);
  const keyData = await resp.arrayBuffer();
  return await crypto.subtle.importKey("raw", keyData, "AES-CBC", false, [
    "decrypt",
  ]);
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

  const adaptationRe = /<AdaptationSet([^>]*)>([\s\S]*?)<\/AdaptationSet>/gi;
  let am;

  while ((am = adaptationRe.exec(mpdText)) !== null) {
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

    while ((tm = timelineRe.exec(tContent)) !== null) {
      if (tm[1]) time = parseInt(tm[1]);
      const duration = parseInt(tm[2]);
      const repeat = parseInt(tm[3] || "0");
      const count = repeat >= 0 ? repeat + 1 : 1;

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

console.log("[Worker] Download worker ready");
