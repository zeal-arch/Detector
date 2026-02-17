const bc = new BroadcastChannel("offscreen_to_service");
const bcIn = new BroadcastChannel("service_to_offscreen");

bcIn.onmessage = (e) => {
  if (e.data?.type === "PING") {
    bc.postMessage({ type: "PONG", ts: Date.now() });
  }
};

window.addEventListener("load", () => {
  bc.postMessage({ type: "PONG", ts: Date.now() });
});

const sandbox = document.getElementById("sandbox");
const pending = new Map();
let nextId = 1;
let activeMergeAbort = null; // AbortController for cancelling merge downloads

// Track player URLs that caused solver hangs/failures — skip retries within cooldown
const failedPlayerUrls = new Map(); // playerUrl → timestamp of failure
const SOLVER_FAIL_COOLDOWN = 5 * 60 * 1000; // 5 minutes before retrying a failed player

// S34 fix: Merge queue to prevent concurrent large merges from exhausting memory
// Each merge holds video + audio buffers (~1-2 GB each) in memory simultaneously.
// Serialize large merges to avoid OOM crashes.
const mergeQueue = [];
let activeMerge = null; // Promise for the current merge operation
const MERGE_MEMORY_THRESHOLD = 500 * 1024 * 1024; // 500 MB — serialize if either track > this

/**
 * Queue and serialize merge operations to prevent memory exhaustion.
 * @param {Function} mergeFn - The merge function to execute
 * @param {number} estimatedSize - Estimated memory usage in bytes
 * @returns {Promise} - Resolves when merge completes
 */
async function queueMerge(mergeFn, estimatedSize = 0) {
  // If the merge is large, wait for the current merge to finish
  if (estimatedSize > MERGE_MEMORY_THRESHOLD && activeMerge) {
    console.log(
      `[OFFSCREEN] Large merge (${(estimatedSize / 1024 / 1024).toFixed(1)} MB) queued, waiting for active merge...`,
    );
    try {
      await activeMerge;
    } catch {}
  }

  // Execute the merge
  const mergePromise = mergeFn();
  activeMerge = mergePromise;

  try {
    return await mergePromise;
  } finally {
    // Clear activeMerge when this merge completes
    if (activeMerge === mergePromise) {
      activeMerge = null;
    }
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== "offscreen") return false;

  switch (msg.action) {
    case "EVAL_NSIG":
      handleEvalNSig(msg, sendResponse);
      return true;

    case "EVAL_CIPHER":
      handleEvalCipher(msg, sendResponse);
      return true;

    case "SOLVE_PLAYER":
      handleSolvePlayer(msg, sendResponse);
      return true;

    case "MERGE_AND_DOWNLOAD":
      handleMergeAndDownload(msg, sendResponse);
      return true;

    case "CLEANUP_OPFS":
      handleCleanupOPFS(sendResponse);
      return true;

    case "START_WORKER_DOWNLOAD":
      handleStartWorkerDownload(msg, sendResponse);
      return true;

    case "CANCEL_WORKER_DOWNLOAD":
      handleCancelWorkerDownload(msg, sendResponse);
      return true;

    case "CANCEL_MERGE":
      handleCancelMerge(sendResponse);
      return true;
  }
});

function handleEvalNSig(msg, sendResponse) {
  const id = nextId++;
  pending.set(id, sendResponse);

  sandbox.contentWindow.postMessage(
    { id, action: "EVAL_NSIG", fnCode: msg.fnCode, params: msg.params },
    "*",
  );

  setTimeout(() => {
    if (pending.has(id)) {
      console.warn("[OFFSCREEN] N-sig sandbox eval timed out after 10s");
      pending.get(id)({
        error: "Sandbox timeout",
        results: [],
        timedOut: true,
      });
      pending.delete(id);
    }
  }, 10000);
}

function handleEvalCipher(msg, sendResponse) {
  const id = nextId++;
  pending.set(id, sendResponse);

  sandbox.contentWindow.postMessage(
    {
      id,
      action: "EVAL_CIPHER",
      cipherCode: msg.cipherCode,
      argName: msg.argName,
      sigs: msg.sigs,
    },
    "*",
  );

  setTimeout(() => {
    if (pending.has(id)) {
      console.warn("[OFFSCREEN] Cipher sandbox eval timed out after 10s");
      pending.get(id)({
        error: "Sandbox cipher timeout",
        results: [],
        timedOut: true,
      });
      pending.delete(id);
    }
  }, 10000);
}

function handleSolvePlayer(msg, sendResponse) {
  // Check if this player URL recently failed — skip retry within cooldown
  const playerUrl = msg.playerUrl || "";
  const failedAt = failedPlayerUrls.get(playerUrl);
  if (failedAt && Date.now() - failedAt < SOLVER_FAIL_COOLDOWN) {
    console.warn(
      `[OFFSCREEN] Skipping solver for recently-failed player URL (cooldown active): ${playerUrl}`,
    );
    sendResponse({
      error: "Player solver recently failed — cooldown active",
      nResults: {},
      sigResults: {},
      timedOut: true,
    });
    return;
  }

  const id = nextId++;
  pending.set(id, sendResponse);

  sandbox.contentWindow.postMessage(
    {
      id,
      action: "SOLVE_PLAYER",
      playerJs: msg.playerJs,
      playerUrl: msg.playerUrl,
      nChallenges: msg.nChallenges || [],
      sigChallenges: msg.sigChallenges || [],
    },
    "*",
  );

  // Player.js parsing + execution can take a while on first run (~1-2s)
  // Use a generous 30s timeout
  setTimeout(() => {
    if (pending.has(id)) {
      console.warn("[OFFSCREEN] Player solver timed out after 30s");
      // Mark this player URL as failed to prevent retry storms
      if (playerUrl) {
        failedPlayerUrls.set(playerUrl, Date.now());
      }
      pending.get(id)({
        error: "Player solver timeout",
        nResults: {},
        sigResults: {},
        timedOut: true,
      });
      pending.delete(id);

      // Reload the sandbox iframe to unstick it from any infinite loop
      try {
        const src = sandbox.src;
        sandbox.src = "";
        sandbox.src = src;
        console.log("[OFFSCREEN] Sandbox iframe reloaded after solver timeout");
      } catch (e) {
        console.warn("[OFFSCREEN] Failed to reload sandbox iframe:", e.message);
      }
    }
  }, 30000);
}

window.addEventListener("message", (e) => {
  if (e.source !== sandbox.contentWindow) return;
  const { id, results, error, nResults, sigResults, cached, elapsed } =
    e.data || {};
  if (!id || !pending.has(id)) return;

  const respond = pending.get(id);
  pending.delete(id);

  // SOLVE_PLAYER responses have nResults/sigResults instead of results
  if (nResults !== undefined || sigResults !== undefined) {
    respond({
      nResults: nResults || {},
      sigResults: sigResults || {},
      cached,
      elapsed,
      error,
    });
  } else if (error) {
    respond({ error, results: [] });
  } else {
    respond({ results: results || [] });
  }
});

let LibAVFactory = null;
let libavInstance = null;
let libavInitPromise = null;

async function getLibAV() {
  if (libavInstance) return libavInstance;

  if (libavInitPromise) return libavInitPromise;

  libavInitPromise = (async () => {
    try {
      if (!LibAVFactory) {
        console.log("[OFFSCREEN] Loading libav.js WASM module...");
        const module = await import(
          chrome.runtime.getURL("lib/libav-6.5.7.1-h264-aac-mp3.wasm.mjs")
        );
        LibAVFactory = module.default;
      }

      // Let the Emscripten runtime fetch + compile WASM via
      // WebAssembly.instantiateStreaming (compiles while downloading).
      // The .mjs module's import.meta.url resolves the .wasm path
      // automatically to the correct chrome-extension:// lib/ directory.
      // If streaming compilation fails (e.g. wrong MIME type), the runtime
      // gracefully falls back to ArrayBuffer instantiation — same as before.
      console.log(
        "[OFFSCREEN] Initializing libav.js (streaming WASM compile)...",
      );

      libavInstance = await LibAVFactory();

      console.log("[OFFSCREEN] libav.js ready");
      return libavInstance;
    } catch (err) {
      libavInitPromise = null;
      throw err;
    }
  })();

  return libavInitPromise;
}

async function getOPFSRoot() {
  return navigator.storage.getDirectory();
}

/**
 * Download a URL into a single Uint8Array.
 *
 * When Content-Length is known (the common case for YouTube media), the full
 * buffer is pre-allocated upfront and each streamed chunk is written directly
 * into it.  This keeps peak JS memory at ~1× the file size instead of the
 * ~2× that the old "accumulate chunks[] then new Uint8Array(total)" approach
 * needed — which caused "Array buffer allocation failed" for 700 MB+ files.
 *
 * When Content-Length is unknown, falls back to accumulating chunks and
 * combining at the end (acceptable because unknown-size downloads are
 * typically small).
 */
async function downloadToBuffer(url, label, signal, onProgress) {
  console.log(`[OFFSCREEN] Downloading ${label}...`);

  // Retry up to 3 times on 403 — YouTube can temporarily reject requests
  // (e.g. when fetching audio after a long video download).
  let response;
  let lastStatus = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (signal?.aborted)
      throw new DOMException("Download cancelled", "AbortError");
    if (attempt > 0) {
      const delay = 2000 * attempt; // 2s, 4s
      console.log(
        `[OFFSCREEN] Retrying ${label} download after ${delay}ms (attempt ${attempt + 1}/3, last status: ${lastStatus})`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
    try {
      response = await fetch(url, {
        credentials: "include",
        mode: "cors",
        cache: "no-cache",
        signal,
      });
    } catch (fetchErr) {
      // Network error (QUIC protocol error, connection reset, DNS failure, etc.)
      if (fetchErr.name === "AbortError") throw fetchErr;
      console.warn(
        `[OFFSCREEN] Network error downloading ${label} (attempt ${attempt + 1}/3): ${fetchErr.message}`,
      );
      lastStatus = 0;
      if (attempt === 2)
        throw new Error(
          `Download failed: network error after 3 attempts (${fetchErr.message})`,
        );
      continue;
    }
    lastStatus = response.status;
    if (response.ok) break;
    if (response.status !== 403) {
      throw new Error(`Download failed: HTTP ${response.status}`);
    }
    // 403 — will retry
  }

  if (!response.ok) {
    throw new Error(
      `Download failed: HTTP ${response.status} after 3 attempts`,
    );
  }

  const totalSize = parseInt(response.headers.get("content-length")) || 0;
  const reader = response.body.getReader();
  let downloaded = 0;
  let lastTime = Date.now();
  let lastBytes = 0;
  let speed = 0;

  function trackProgress(chunkLen) {
    downloaded += chunkLen;
    const now = Date.now();
    const elapsed = now - lastTime;
    if (elapsed >= 500) {
      speed = ((downloaded - lastBytes) / elapsed) * 1000;
      lastTime = now;
      lastBytes = downloaded;
    }
    if (onProgress) onProgress(downloaded, totalSize, speed);
  }

  let result;

  try {
    if (totalSize > 0) {
      // --- Known size: pre-allocate, write chunks in-place ---
      result = new Uint8Array(totalSize);
      while (true) {
        if (signal?.aborted)
          throw new DOMException("Download cancelled", "AbortError");
        const { done, value } = await reader.read();
        if (done) break;
        // Guard against server sending more bytes than Content-Length
        const safeLen = Math.min(value.byteLength, totalSize - downloaded);
        if (safeLen > 0) result.set(value.subarray(0, safeLen), downloaded);
        trackProgress(value.byteLength);
      }
      if (downloaded < totalSize) {
        result = result.subarray(0, downloaded);
      }
    } else {
      // --- Unknown size: accumulate then combine ---
      const chunks = [];
      while (true) {
        if (signal?.aborted)
          throw new DOMException("Download cancelled", "AbortError");
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        trackProgress(value.byteLength);
      }
      result = new Uint8Array(downloaded);
      let offset = 0;
      for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.byteLength;
      }
    }
  } catch (err) {
    // On cancel or error, release the pre-allocated buffer immediately
    result = null;
    reader.cancel().catch(() => {});
    throw err;
  }

  console.log(
    `[OFFSCREEN] Downloaded ${label}: ${(downloaded / 1024 / 1024).toFixed(2)} MB` +
      (speed > 0 ? ` (${(speed / 1024 / 1024).toFixed(1)} MB/s)` : ""),
  );

  return result;
}

async function cleanupMergeOPFS() {
  try {
    const root = await getOPFSRoot();
    let removed = 0;
    for await (const [name] of root) {
      if (
        name.startsWith("merge_video_") ||
        name.startsWith("merge_audio_") ||
        name.startsWith("merge_output_") ||
        name.startsWith("m3u8_")
      ) {
        await root.removeEntry(name, { recursive: true }).catch(() => {});
        removed++;
      }
    }
    console.log(`[OFFSCREEN] OPFS cleanup done (removed ${removed} entries)`);
  } catch (e) {
    console.warn("[OFFSCREEN] OPFS cleanup error:", e.message);
  }
}

/**
 * Remove common MEMFS input and output files created during merge/download operations.
 *
 * Attempts to unlink both MP4 and WebM variants of input_video, input_audio, and output files
 * from the libav instance's MEMFS and ignores any unlink errors (e.g., file not present).
 */
function cleanupMEMFS() {
  if (!libavInstance) return;
  // Clean up all possible input/output filenames across all merge/transmux paths
  for (const f of [
    // YouTube merge (MP4 / WebM variants)
    "input_video.mp4",
    "input_video.webm",
    "input_audio.mp4",
    "input_audio.webm",
    "output.mp4",
    "output.webm",
    // HLS separate audio merge (TS variants)
    "input_video.ts",
    "input_audio.ts",
    "merged_output.mp4",
    // TS → MP4 transmux
    "input.ts",
  ]) {
    try {
      libavInstance.unlink(f);
    } catch (e) {}
  }
  // Also clean up any readahead-backed files (streaming I/O)
  // Must cover all extension variants: .ts (HLS transmux), .mp4 / .webm (fMP4/WebM merge)
  for (const f of [
    "input.ts",
    "input_video.ts",
    "input_audio.ts",
    "input_video.mp4",
    "input_audio.mp4",
    "input_video.webm",
    "input_audio.webm",
  ]) {
    try {
      libavInstance.unlinkreadaheadfile(f);
    } catch (e) {}
  }
}

/**
 * Cancels any in-progress merge operation, cleans up partial in-memory files, and reports the outcome.
 * @param {function(Object): void} sendResponse - Callback invoked with the result object: `{ success: true }` on successful cancellation, or `{ success: false, error: string }` if no active merge exists.
 */

// FFmpeg codec constants for pre-flight probe
const AVMEDIA_TYPE_VIDEO = 0;
const AVMEDIA_TYPE_AUDIO = 1;
const AV_CODEC_ID_AAC = 86018; // 0x15002
const AV_CODEC_ID_MP3 = 86017; // 0x15001
const AV_CODEC_ID_AC3 = 86019; // 0x15003
const AV_CODEC_ID_EAC3 = 86056; // 0x15028
const AV_CODEC_ID_OPUS = 86076; // 0x1503C
const AV_CODEC_ID_VORBIS = 86021; // 0x15005

/**
 * Pre-flight probe: open a MEMFS file via the demuxer and return stream info.
 *
 * Uses libav.js ff_init_demuxer_file to inspect the container without running
 * a full ffmpeg transcode.  Returns authoritative codec IDs from FFmpeg's own
 * parser, which is more reliable than the JS-level PMT/CODECS heuristics used
 * by the download worker.
 *
 * @param {Object} libav  - Initialized libav.js instance
 * @param {string} filename - MEMFS filename to probe (e.g. "input.ts")
 * @returns {{ valid: boolean, hasVideo: boolean, hasAudio: boolean,
 *             audioCodecId: number|null, audioCodecName: string|null,
 *             streams: Array<{index:number, codec_type:number, codec_id:number}> }}
 */
async function probeInputFile(libav, filename) {
  try {
    const [fmt_ctx, streams] = await libav.ff_init_demuxer_file(filename);

    const audioStream = streams.find(
      (s) => s.codec_type === AVMEDIA_TYPE_AUDIO,
    );
    let audioCodecName = null;
    if (audioStream) {
      switch (audioStream.codec_id) {
        case AV_CODEC_ID_AAC:
          audioCodecName = "aac";
          break;
        case AV_CODEC_ID_MP3:
          audioCodecName = "mp3";
          break;
        case AV_CODEC_ID_AC3:
          audioCodecName = "ac3";
          break;
        case AV_CODEC_ID_EAC3:
          audioCodecName = "eac3";
          break;
        case AV_CODEC_ID_OPUS:
          audioCodecName = "opus";
          break;
        case AV_CODEC_ID_VORBIS:
          audioCodecName = "vorbis";
          break;
        default:
          audioCodecName = `unknown(${audioStream.codec_id})`;
          break;
      }
    }

    const info = {
      valid: true,
      hasVideo: streams.some((s) => s.codec_type === AVMEDIA_TYPE_VIDEO),
      hasAudio: !!audioStream,
      audioCodecId: audioStream ? audioStream.codec_id : null,
      audioCodecName,
      streams: streams.map((s) => ({
        index: s.index,
        codec_type: s.codec_type,
        codec_id: s.codec_id,
      })),
    };

    // Close the demuxer (does NOT delete the MEMFS/readahead file).
    // Wrapped in its own try/catch so a close failure doesn't discard
    // the successfully-probed info.
    try {
      await libav.avformat_close_input_js(fmt_ctx);
    } catch (closeErr) {
      console.warn(
        `[OFFSCREEN] Probe close warning for ${filename}:`,
        closeErr,
      );
    }

    console.log(
      `[OFFSCREEN] Probe ${filename}: ${info.streams.length} stream(s), ` +
        `video=${info.hasVideo}, audio=${info.hasAudio}` +
        (info.audioCodecName ? ` (${info.audioCodecName})` : ""),
    );
    return info;
  } catch (e) {
    console.warn(`[OFFSCREEN] Pre-flight probe of ${filename} failed:`, e);
    return {
      valid: false,
      hasVideo: false,
      hasAudio: false,
      audioCodecId: null,
      audioCodecName: null,
      streams: [],
    };
  }
}

function handleCancelMerge(sendResponse) {
  if (activeMergeAbort) {
    console.log("[OFFSCREEN] Cancelling active merge...");
    activeMergeAbort.abort();
    activeMergeAbort = null;
    // Clean up any partially-written MEMFS files
    cleanupMEMFS();
    sendResponse({ success: true });
  } else {
    sendResponse({ success: false, error: "No active merge to cancel" });
  }
}

/**
 * Download video and audio streams, merge them into a single media file, and trigger a background download.
 *
 * Orchestrates parallel downloads of the provided video and audio URLs, writes them to libav.js MEMFS, runs an FFmpeg merge
 * (copying streams, using WebM when both inputs are WebM), produces a Blob URL for the merged output, and asks the background
 * script to start the actual file download. Progress updates are emitted via the broadcast channel; the operation can be
 * cancelled (AbortController) and cleans up MEMFS and temporary buffers on completion or error.
 *
 * @param {Object} msg - Message payload containing merge parameters.
 * @param {string} msg.videoUrl - URL of the video track to download.
 * @param {string} msg.audioUrl - URL of the audio track to download.
 * @param {string} [msg.filename] - Preferred filename for the merged output; extension will be ensured.
 * @param {string} [msg.mergeId] - Optional identifier used for progress reporting.
 * @param {Function} sendResponse - Callback to send the result back (called with an object describing success or error).
 */
async function handleMergeAndDownload(msg, sendResponse) {
  const { videoUrl, audioUrl, filename, mergeId } = msg;

  // S34 fix: Estimate size from URL (Content-Length) before queuing
  // to serialize large merges and prevent concurrent memory exhaustion
  let estimatedSize = 0;
  try {
    const videoHead = await fetch(videoUrl, { method: "HEAD" });
    const videoLength = parseInt(
      videoHead.headers.get("content-length") || "0",
      10,
    );
    const audioHead = await fetch(audioUrl, { method: "HEAD" });
    const audioLength = parseInt(
      audioHead.headers.get("content-length") || "0",
      10,
    );
    estimatedSize = videoLength + audioLength;
    console.log(
      `[OFFSCREEN] Merge size estimate: ${(estimatedSize / 1024 / 1024).toFixed(1)} MB`,
    );
  } catch (e) {
    // HEAD may fail, continue anyway
    console.warn("[OFFSCREEN] Failed to estimate merge size:", e.message);
  }

  // Queue the merge if it's large
  return queueMerge(async () => {
    return await _doMerge(msg, sendResponse);
  }, estimatedSize);
}

/**
 * Internal merge implementation (separated for queuing)
 */
async function _doMerge(msg, sendResponse) {
  const { videoUrl, audioUrl, filename, mergeId } = msg;
  const progressKey = mergeId || Date.now().toString();

  // Create AbortController so the user can cancel mid-download
  const abortController = new AbortController();
  activeMergeAbort = abortController;
  const signal = abortController.signal;

  let videoData = null;
  let audioData = null;

  try {
    const libav = await getLibAV();

    // Clean up any leftover files from previous merge attempts
    cleanupMEMFS();

    sendProgress(progressKey, "download", "Downloading audio + video...", 0);

    // --- Combined progress tracker ---
    // Maps the entire merge process to a single 0→100% bar:
    //   Download: 0–70%  |  Merge: 70–90%  |  Finalize: 90–100%
    // Audio + video download progress is weighted by total bytes.
    let audioDL = 0,
      audioTotal = 0;
    let videoDL = 0,
      videoTotal = 0;
    let lastReportedPct = -1;
    const dlStartTime = Date.now();

    function reportDownloadProgress() {
      const totalBytes = audioTotal + videoTotal;
      if (totalBytes <= 0) return;
      const dlDone = audioDL + videoDL;
      const dlFraction = dlDone / totalBytes; // 0.0 → 1.0
      const pct = Math.min(Math.floor(dlFraction * 70), 70); // 0 → 70
      if (pct <= lastReportedPct) return;
      lastReportedPct = pct;

      const dlMB = (dlDone / 1024 / 1024).toFixed(1);
      const totMB = (totalBytes / 1024 / 1024).toFixed(1);

      // Speed + ETA
      const elapsed = (Date.now() - dlStartTime) / 1000; // seconds
      let speedStr = "";
      let etaStr = "";
      if (elapsed > 2 && dlDone > 0) {
        const bps = dlDone / elapsed;
        speedStr = ` · ${(bps / 1024 / 1024).toFixed(1)} MB/s`;
        const remaining = totalBytes - dlDone;
        if (remaining > 0 && bps > 0) {
          const etaSec = Math.ceil(remaining / bps);
          if (etaSec < 60) etaStr = ` · ${etaSec}s left`;
          else if (etaSec < 3600) etaStr = ` · ${Math.ceil(etaSec / 60)}m left`;
          else
            etaStr = ` · ${Math.floor(etaSec / 3600)}h${Math.ceil((etaSec % 3600) / 60)}m left`;
        }
      }

      sendProgress(
        progressKey,
        "download",
        `Downloading · ${dlMB} / ${totMB} MB${speedStr}${etaStr}`,
        pct,
      );
    }

    // Download BOTH tracks in parallel.
    // Audio is tiny (10-50 MB), video is large (100 MB-2 GB).
    // Parallel download is safe because:
    //   - Audio finishes in seconds and gets written to MEMFS immediately
    //   - Peak memory is ~1× video size (audio already freed to MEMFS)
    //   - Both URLs are used immediately so neither goes stale
    const [audioResult, videoResult] = await Promise.all([
      downloadToBuffer(audioUrl, "audio", signal, (dl, total) => {
        audioDL = dl;
        audioTotal = total || audioDL;
        reportDownloadProgress();
      }),
      downloadToBuffer(videoUrl, "video", signal, (dl, total) => {
        videoDL = dl;
        videoTotal = total || videoDL;
        reportDownloadProgress();
      }),
    ]);

    audioData = audioResult;
    videoData = videoResult;

    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");

    // --- Auto-detect output container ---
    // This only activates when BOTH inputs are WebM (VP9/Opus), so H.264/AAC
    // never enters the WebM path.  With -c:v copy -c:a copy, no codec
    // decoders/encoders are needed — only muxer/demuxer support matters.
    const isWebMVideo =
      /mime=video(%2F|\/)webm/i.test(videoUrl) ||
      /webm/i.test((videoUrl.match(/[?&]type=([^&]+)/) || [])[1] || "");
    const isWebMAudio =
      /mime=audio(%2F|\/)webm/i.test(audioUrl) ||
      /webm/i.test((audioUrl.match(/[?&]type=([^&]+)/) || [])[1] || "");
    const useWebM = isWebMVideo && isWebMAudio;

    // Name input files with correct extensions so FFmpeg picks the right
    // demuxer (WebM data in a .mp4 file could confuse format probing).
    const videoInputFile = isWebMVideo ? "input_video.webm" : "input_video.mp4";
    const audioInputFile = isWebMAudio ? "input_audio.webm" : "input_audio.mp4";

    // Write audio to MEMFS first (small) then free it
    const audioSize = audioData.byteLength;
    libav.writeFile(audioInputFile, audioData, { canOwn: true });
    audioData = null;

    // Write video to MEMFS and free it
    const videoSize = videoData.byteLength;
    libav.writeFile(videoInputFile, videoData, { canOwn: true });
    videoData = null;

    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    const outputExt = useWebM ? "webm" : "mp4";
    const outputFile = `output.${outputExt}`;
    const mimeType = useWebM ? "video/webm" : "video/mp4";

    sendProgress(progressKey, "merge", "Merging audio + video...", 72);

    console.log(
      `[OFFSCREEN] Merging: video=${(videoSize / 1024 / 1024).toFixed(2)}MB, audio=${(audioSize / 1024 / 1024).toFixed(2)}MB → ${outputExt.toUpperCase()}`,
    );

    sendProgress(progressKey, "merge", "Running FFmpeg merge...", 75);

    // Build FFmpeg args — skip -movflags +faststart for WebM (not applicable)
    // WebM requires explicit -f matroska since libav.js doesn't auto-detect .webm extension
    const ffmpegArgs = [
      "-y",
      "-i",
      videoInputFile,
      "-i",
      audioInputFile,
      "-c:v",
      "copy",
      "-c:a",
      "copy",
      "-shortest",
    ];
    if (useWebM) {
      // WebM is a subset of Matroska — use explicit format
      ffmpegArgs.push("-f", "matroska");
    } else {
      ffmpegArgs.push("-movflags", "+faststart");
    }
    ffmpegArgs.push(outputFile);

    const exitCode = await libav.ffmpeg(ffmpegArgs);

    if (exitCode !== 0) {
      throw new Error(`FFmpeg merge failed with exit code ${exitCode}`);
    }

    // Check for cancellation immediately after FFmpeg completes
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");

    // Free input files from MEMFS BEFORE reading output — reduces peak memory
    try {
      libav.unlink(videoInputFile);
    } catch (e) {}
    try {
      libav.unlink(audioInputFile);
    } catch (e) {}

    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");

    sendProgress(progressKey, "finalize", "Preparing download...", 92);

    let mergedData = libav.readFile(outputFile);
    const outputSize = mergedData.byteLength;
    console.log(
      `[OFFSCREEN] Merged output: ${(outputSize / 1024 / 1024).toFixed(2)} MB (${outputExt})`,
    );

    // Free output from MEMFS immediately after reading into JS
    try {
      libav.unlink(outputFile);
    } catch (e) {}

    const blob = new Blob([mergedData], { type: mimeType });
    // Free the raw buffer immediately — Blob owns the data now
    mergedData = null;
    let blobUrl = null;
    try {
      blobUrl = URL.createObjectURL(blob);
      const finalFilename = ensureExtension(filename, outputExt);

      const downloadId = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          {
            target: "background",
            action: "DOWNLOAD_BLOB",
            blobUrl,
            filename: finalFilename,
            size: outputSize,
          },
          (response) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else if (response?.success) {
              resolve(response.downloadId);
            } else {
              reject(new Error(response?.error || "Download trigger failed"));
            }
          },
        );
      });

      console.log("[OFFSCREEN] Merged download started, id:", downloadId);

      setTimeout(() => URL.revokeObjectURL(blobUrl), 120000);

      sendProgress(
        progressKey,
        "complete",
        "Saving — choose location in popup",
        100,
      );

      sendResponse({
        success: true,
        downloadId,
        size: outputSize,
        filename: finalFilename,
      });
    } catch (err) {
      // Clean up blob URL if chrome API failed
      if (blobUrl) URL.revokeObjectURL(blobUrl);
      throw err;
    }
  } catch (err) {
    // Free any in-flight download buffers
    videoData = null;
    audioData = null;

    const isCancelled = err.name === "AbortError";
    const errMsg = isCancelled ? "Download cancelled by user" : err.message;

    if (isCancelled) {
      console.log("[OFFSCREEN] Merge cancelled by user");
    } else {
      console.error(
        "[OFFSCREEN] Merge failed:",
        err.name,
        err.message,
        err.stack,
      );
    }

    sendProgress(
      progressKey,
      isCancelled ? "cancelled" : "error",
      isCancelled ? "Cancelled" : `${err.name}: ${err.message}`,
      0,
    );

    // Clean up any MEMFS files
    cleanupMEMFS();

    sendResponse({ success: false, error: errMsg, cancelled: isCancelled });
  } finally {
    activeMergeAbort = null;
  }
}

function handleCleanupOPFS(sendResponse) {
  cleanupMergeOPFS()
    .then(() => sendResponse({ success: true }))
    .catch((e) => sendResponse({ success: false, error: e.message }));
}

function sendProgress(key, phase, message, percent) {
  bc.postMessage({
    type: "MERGE_PROGRESS",
    key,
    phase,
    message,
    percent,
  });
}

function ensureExtension(filename, ext) {
  if (!filename) return `video.${ext}`;
  return filename.replace(/\.\w+$/, "") + `.${ext}`;
}

function ensureMp4Extension(filename) {
  return ensureExtension(filename, "mp4");
}

const activeWorkers = new Map();

function handleStartWorkerDownload(msg, sendResponse) {
  const { downloadId, url, type, filename, headers, sessionRuleId, tabId } =
    msg;

  try {
    const workerUrl = chrome.runtime.getURL("workers/download-worker.js");
    const worker = new Worker(workerUrl);
    activeWorkers.set(downloadId, worker);
    const extraRuleIds = [];
    function cleanupAllHeaders() {
      cleanupSessionHeaders(sessionRuleId);
      for (const id of extraRuleIds) cleanupSessionHeaders(id);
    }

    worker.onmessage = async (e) => {
      const { name: msgName, data: msgData } = e.data;

      switch (msgName) {
        case "download_progress":
          bc.postMessage({
            type: "WORKER_PROGRESS",
            downloadId,
            phase: msgData.phase,
            message: msgData.message,
            percent: msgData.percent,
            filename,
          });
          break;

        case "request_url_refresh":
          // S35 fix: Worker detected YouTube URL expiry, request fresh URLs
          console.log("[OFFSCREEN] Worker requesting URL refresh");
          chrome.runtime.sendMessage(
            {
              target: "background",
              action: "REFRESH_YOUTUBE_URLS",
              downloadId,
              tabId: msg.tabId, // Pass tabId from original START_WORKER_DOWNLOAD
            },
            (refreshResponse) => {
              if (refreshResponse?.urlMap) {
                // Send fresh URLs back to worker
                worker.postMessage({
                  name: "refresh_urls",
                  data: {
                    downloadId,
                    urlMap: refreshResponse.urlMap,
                  },
                });
              } else {
                console.warn(
                  "[OFFSCREEN] URL refresh failed:",
                  refreshResponse?.error,
                );
              }
            },
          );
          break;

        case "download_result":
          try {
            let finalBlobUrl;
            let finalFilename = filename;
            let finalSize = msgData.size || 0;

            const TRANSMUX_MAX = 2 * 1024 * 1024 * 1024;

            // ── HLS separate audio merge ──
            // When the worker downloaded video + audio as separate M3U8
            // playlists, merge them into a single MP4 using libav.
            if (msgData.audioBlobUrl) {
              try {
                bc.postMessage({
                  type: "WORKER_PROGRESS",
                  downloadId,
                  phase: "merging",
                  message: "Merging video + audio tracks...",
                  percent: 85,
                  filename,
                });

                const [videoResp, audioResp] = await Promise.all([
                  fetch(msgData.blobUrl),
                  fetch(msgData.audioBlobUrl),
                ]);
                let videoBlob = await videoResp.blob();
                let audioBlob = await audioResp.blob();

                URL.revokeObjectURL(msgData.blobUrl);
                URL.revokeObjectURL(msgData.audioBlobUrl);

                console.log(
                  `[OFFSCREEN] Merging video (${(videoBlob.size / 1024 / 1024).toFixed(2)} MB) + audio (${(audioBlob.size / 1024 / 1024).toFixed(2)} MB) — streaming I/O`,
                );

                const libav = await getLibAV();
                const videoExt = msgData.needsTransmux ? "ts" : "mp4";
                const audioExt = msgData.needsTransmux ? "ts" : "mp4";
                const videoIn = `input_video.${videoExt}`;
                const audioIn = `input_audio.${audioExt}`;

                // Mount blobs as streaming readahead files — avoids the
                // expensive blob.arrayBuffer() + writeFile() double-copy
                // that previously tripled peak memory for V+A merges.
                try {
                  libav.unlinkreadaheadfile(videoIn);
                } catch (e) {}
                try {
                  libav.unlinkreadaheadfile(audioIn);
                } catch (e) {}
                try {
                  libav.unlink("merged_output.mp4");
                } catch (e) {}

                libav.mkreadaheadfile(videoIn, videoBlob);
                libav.mkreadaheadfile(audioIn, audioBlob);

                const ffArgs = [
                  "-y",
                  "-i",
                  videoIn,
                  "-i",
                  audioIn,
                  "-c:v",
                  "copy",
                  "-c:a",
                  "copy",
                ];
                if (msgData.needsTransmux) {
                  // Probe the audio input for authoritative codec detection
                  const audioProbe = await probeInputFile(libav, audioIn);
                  const workerCodec = msgData.audioCodec || null;
                  const probeIsAAC =
                    audioProbe.valid &&
                    audioProbe.audioCodecId === AV_CODEC_ID_AAC;
                  const applyBSF =
                    probeIsAAC ||
                    (!audioProbe.valid &&
                      (!workerCodec ||
                        workerCodec === "aac" ||
                        workerCodec === "aac-he"));

                  if (applyBSF) {
                    ffArgs.push("-bsf:a", "aac_adtstoasc");
                    console.log(
                      `[OFFSCREEN] Merge BSF: applying aac_adtstoasc (probed=${audioProbe.audioCodecName}, worker=${workerCodec})`,
                    );
                  } else {
                    console.log(
                      `[OFFSCREEN] Merge BSF: skipping aac_adtstoasc (probed=${audioProbe.audioCodecName}, worker=${workerCodec})`,
                    );
                  }
                }
                ffArgs.push("-movflags", "+faststart", "merged_output.mp4");

                const exitCode = await libav.ffmpeg(ffArgs);

                // Clean up readahead devices immediately (releases Blob refs)
                try {
                  libav.unlinkreadaheadfile(videoIn);
                } catch (e) {}
                try {
                  libav.unlinkreadaheadfile(audioIn);
                } catch (e) {}
                videoBlob = null;
                audioBlob = null;

                if (exitCode !== 0) {
                  throw new Error(
                    `FFmpeg merge failed with exit code ${exitCode}`,
                  );
                }

                let mp4Data = libav.readFile("merged_output.mp4");
                console.log(
                  `[OFFSCREEN] Merge complete: ${(mp4Data.byteLength / 1024 / 1024).toFixed(2)} MB`,
                );

                const mp4Blob = new Blob([mp4Data], { type: "video/mp4" });
                mp4Data = null; // Free raw buffer — Blob owns the data now
                finalBlobUrl = URL.createObjectURL(mp4Blob);
                finalFilename = ensureMp4Extension(filename);
                finalSize = mp4Blob.size;

                try {
                  libav.unlink("merged_output.mp4");
                } catch (e) {}

                bc.postMessage({
                  type: "WORKER_PROGRESS",
                  downloadId,
                  phase: "merging",
                  message: "Merge complete!",
                  percent: 95,
                  filename: finalFilename,
                });
              } catch (mergeErr) {
                cleanupMEMFS();
                console.warn(
                  "[OFFSCREEN] Audio merge failed, downloading video only:",
                  mergeErr,
                );
                // Fallback: download video-only (audio will be missing)
                finalBlobUrl = msgData.blobUrl;
                finalFilename = guessExtension(
                  filename,
                  msgData.mimeType || msgData.contentType,
                );
                finalSize = msgData.size || 0;
              }

              // Clean up audio OPFS folder if present
              if (msgData.audioOpfsCleanupInfo) {
                cleanupOPFS(msgData.audioOpfsCleanupInfo.folder);
              }
            } else if (msgData.needsTransmux) {
              // S32 fix: Check actual blob size before transmux, not just msgData.size.
              // For HLS with chunked transfer or missing Content-Length, msgData.size
              // may be 0 or undefined, allowing multi-GB files to bypass the guard.
              try {
                // Fetch the blob first to get actual size
                const tsResp = await fetch(msgData.blobUrl);
                let tsBlob = await tsResp.blob();
                const actualSize = tsBlob.size;

                console.log(
                  `[OFFSCREEN] TS size check: reported=${msgData.size || 0}, actual=${actualSize}`,
                );

                if (actualSize >= TRANSMUX_MAX) {
                  console.warn(
                    `[OFFSCREEN] File too large for transmux (${(actualSize / 1024 / 1024 / 1024).toFixed(2)} GB > ${(TRANSMUX_MAX / 1024 / 1024 / 1024).toFixed(2)} GB). Delivering as raw .ts`,
                  );

                  // Deliver raw TS without transmux
                  finalBlobUrl = msgData.blobUrl;
                  finalFilename = guessExtension(
                    filename,
                    msgData.mimeType || msgData.contentType,
                  );
                  finalSize = actualSize;
                } else {
                  // Size is OK, proceed with transmux
                  bc.postMessage({
                    type: "WORKER_PROGRESS",
                    downloadId,
                    phase: "transmuxing",
                    message: "Converting TS → MP4...",
                    percent: 85,
                    filename,
                  });

                  // NOTE: Do NOT revoke msgData.blobUrl here — we need it as a
                  // fallback if transmux fails. The Blob ref is held by tsBlob
                  // for the readahead device; the URL is revoked only on success.

                  console.log(
                    `[OFFSCREEN] Transmuxing TS → MP4: ${(actualSize / 1024 / 1024).toFixed(2)} MB (streaming I/O)`,
                  );

                  const libav = await getLibAV();

                  // Mount the TS Blob as a streaming readahead file — FFmpeg
                  // reads directly from the Blob via Blob.slice(), avoiding the
                  // expensive blob.arrayBuffer() + writeFile() double-copy that
                  // previously doubled peak memory.
                  try {
                    libav.unlinkreadaheadfile("input.ts");
                  } catch (e) {}
                  try {
                    libav.unlink("output.mp4");
                  } catch (e) {}

                  libav.mkreadaheadfile("input.ts", tsBlob);

                  // Pre-flight probe: use FFmpeg's own demuxer for authoritative
                  // codec detection — more reliable than JS-level PMT parsing.
                  const probe = await probeInputFile(libav, "input.ts");

                  // Dynamic BSF: prefer probed codec, fall back to worker hint
                  const tsFFArgs = [
                    "-y",
                    "-i",
                    "input.ts",
                    "-c:v",
                    "copy",
                    "-c:a",
                    "copy",
                  ];

                  // Use probe result for BSF decision when available;
                  // fall back to worker-level detection (msgData.audioCodec)
                  const probedIsAAC =
                    probe.valid && probe.audioCodecId === AV_CODEC_ID_AAC;
                  const workerCodec = msgData.audioCodec || null;
                  const applyAAC_BSF =
                    probedIsAAC ||
                    (!probe.valid &&
                      (!workerCodec ||
                        workerCodec === "aac" ||
                        workerCodec === "aac-he"));

                  if (applyAAC_BSF) {
                    tsFFArgs.push("-bsf:a", "aac_adtstoasc");
                    console.log(
                      `[OFFSCREEN] Transmux: applying aac_adtstoasc (probed=${probe.audioCodecName}, worker=${workerCodec})`,
                    );
                  } else {
                    console.log(
                      `[OFFSCREEN] Transmux: skipping aac_adtstoasc (probed=${probe.audioCodecName}, worker=${workerCodec})`,
                    );
                  }
                  tsFFArgs.push("-movflags", "+faststart", "output.mp4");

                  const exitCode = await libav.ffmpeg(tsFFArgs);

                  // Clean up the readahead device immediately (releases Blob ref)
                  try {
                    libav.unlinkreadaheadfile("input.ts");
                  } catch (e) {}
                  tsBlob = null; // Allow GC of the original Blob

                  if (exitCode !== 0) {
                    throw new Error(
                      `FFmpeg transmux failed with exit code ${exitCode}`,
                    );
                  }

                  let mp4Data = libav.readFile("output.mp4");
                  console.log(
                    `[OFFSCREEN] Transmux complete: ${(mp4Data.byteLength / 1024 / 1024).toFixed(2)} MB`,
                  );

                  const mp4Blob = new Blob([mp4Data], { type: "video/mp4" });
                  mp4Data = null; // Free raw buffer — Blob owns the data now
                  finalBlobUrl = URL.createObjectURL(mp4Blob);
                  finalFilename = ensureMp4Extension(filename);
                  finalSize = mp4Blob.size;

                  // Transmux succeeded — safe to revoke the original TS blob URL
                  URL.revokeObjectURL(msgData.blobUrl);

                  try {
                    libav.unlink("output.mp4");
                  } catch (e) {}

                  bc.postMessage({
                    type: "WORKER_PROGRESS",
                    downloadId,
                    phase: "transmuxing",
                    message: "Transmux complete!",
                    percent: 95,
                    filename: finalFilename,
                  });
                }
              } catch (transmuxErr) {
                cleanupMEMFS();
                console.warn(
                  "[OFFSCREEN] Transmux failed or skipped, falling back to raw TS:",
                  transmuxErr,
                );

                // Validate fallback blob URL exists before using it
                if (!msgData.blobUrl) {
                  throw new Error(
                    `Transmux failed and no fallback URL available: ${transmuxErr.message}`,
                  );
                }

                finalBlobUrl = msgData.blobUrl;
                finalFilename = guessExtension(
                  filename,
                  msgData.mimeType || msgData.contentType,
                );
                finalSize = msgData.size || 0;
              }
            } else {
              finalBlobUrl = msgData.blobUrl;
              const ct = msgData.mimeType || msgData.contentType;
              finalFilename = msgData.needsMerge
                ? filename
                : guessExtension(filename, ct);
              finalSize = msgData.size || 0;
            }

            const opfsCleanup = msgData.opfsCleanupInfo || null;

            chrome.downloads.download(
              {
                url: finalBlobUrl,
                filename: finalFilename,
                saveAs: true,
              },
              (dlId) => {
                if (chrome.runtime.lastError) {
                  console.error(
                    "[OFFSCREEN] Worker download error:",
                    chrome.runtime.lastError.message,
                  );

                  URL.revokeObjectURL(finalBlobUrl);
                  if (opfsCleanup) cleanupOPFS(opfsCleanup.folder);
                  return;
                }

                const onChanged = (delta) => {
                  if (delta.id !== dlId) return;
                  if (
                    delta.state &&
                    (delta.state.current === "complete" ||
                      delta.state.current === "interrupted")
                  ) {
                    chrome.downloads.onChanged.removeListener(onChanged);
                    console.log(
                      `[OFFSCREEN] Download ${dlId} ${delta.state.current} — cleaning up`,
                    );
                    URL.revokeObjectURL(finalBlobUrl);
                    if (opfsCleanup) cleanupOPFS(opfsCleanup.folder);
                  }
                };
                chrome.downloads.onChanged.addListener(onChanged);

                setTimeout(
                  () => {
                    chrome.downloads.onChanged.removeListener(onChanged);
                    URL.revokeObjectURL(finalBlobUrl);
                    if (opfsCleanup) cleanupOPFS(opfsCleanup.folder);
                  },
                  30 * 60 * 1000, // 30min safety net (primary cleanup is via onChanged listener)
                );
              },
            );

            chrome.runtime
              .sendMessage({
                target: "background",
                action: "WORKER_COMPLETE",
                downloadId,
                success: true,
                filename: finalFilename,
                size: finalSize,
              })
              .catch(() => {});
          } catch (err) {
            console.error("[OFFSCREEN] Worker result handling error:", err);
            chrome.runtime
              .sendMessage({
                target: "background",
                action: "WORKER_COMPLETE",
                downloadId,
                success: false,
                error: err.message,
                filename,
              })
              .catch(() => {});
          }

          worker.terminate();
          activeWorkers.delete(downloadId);
          cleanupAllHeaders();
          break;

        case "download_error":
          console.error("[OFFSCREEN] Worker error:", msgData.error);
          // Clean up any OPFS folders created for this download
          cleanupOPFSByPrefix(`m3u8_${downloadId}_`);
          chrome.runtime
            .sendMessage({
              target: "background",
              action: "WORKER_COMPLETE",
              downloadId,
              success: false,
              error: msgData.error,
              filename,
            })
            .catch(() => {});

          worker.terminate();
          activeWorkers.delete(downloadId);
          cleanupAllHeaders();
          break;

        case "key_domains_discovered":
          // Key URIs may be on a different domain than the stream segments.
          // Create additional DNR header rules so auth/referer headers are sent.
          if (
            e.data.hosts?.length > 0 &&
            headers &&
            Object.keys(headers).length > 0
          ) {
            chrome.runtime
              .sendMessage({
                target: "background",
                action: "ADD_KEY_HOST_HEADERS",
                hosts: e.data.hosts,
                headers,
              })
              .then((resp) => {
                if (resp?.ruleIds) extraRuleIds.push(...resp.ruleIds);
              })
              .catch(() => {});
          }
          break;
      }
    };

    worker.onerror = (e) => {
      console.error("[OFFSCREEN] Worker crash:", e.message);
      chrome.runtime
        .sendMessage({
          target: "background",
          action: "WORKER_COMPLETE",
          downloadId,
          success: false,
          error: "Worker crashed: " + (e.message || "unknown error"),
          filename,
        })
        .catch(() => {});
      activeWorkers.delete(downloadId);
      cleanupAllHeaders();
      // Clean up any OPFS folders created for this download
      cleanupOPFSByPrefix(`m3u8_${downloadId}_`);
    };

    worker.postMessage({
      name: "start_download",
      data: {
        download_id: downloadId,
        url,
        type,
        filename,
        headers: headers || {},
        tabId, // S35 fix: Pass tabId for URL refresh
      },
    });

    console.log(`[OFFSCREEN] Started download worker: ${downloadId} (${type})`);
    sendResponse({ success: true, downloadId });
  } catch (err) {
    console.error("[OFFSCREEN] Failed to start worker:", err);
    cleanupAllHeaders();
    sendResponse({ success: false, error: err.message });
  }
}

function handleCancelWorkerDownload(msg, sendResponse) {
  const { downloadId } = msg;
  const worker = activeWorkers.get(downloadId);

  if (worker) {
    worker.postMessage({
      name: "cancel_download",
      data: { download_id: downloadId },
    });
    // Clean up any OPFS folders created for this download
    cleanupOPFSByPrefix(`m3u8_${downloadId}_`);
    setTimeout(() => {
      worker.terminate();
      activeWorkers.delete(downloadId);
    }, 1000);
    sendResponse({ success: true });
  } else {
    sendResponse({ success: false, error: "No active worker found" });
  }
}

async function cleanupOPFS(folderName) {
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(folderName, { recursive: true });
    console.log(`[OFFSCREEN] OPFS cleanup: removed ${folderName}`);
  } catch (e) {
    console.warn(`[OFFSCREEN] OPFS cleanup failed (non-critical):`, e.message);
  }
}

/**
 * Remove all OPFS directories whose name starts with the given prefix.
 * Used to clean up m3u8_{downloadId}_ folders on error/cancel when
 * the exact folder name (which includes a timestamp) is unknown.
 */
async function cleanupOPFSByPrefix(prefix) {
  try {
    const root = await navigator.storage.getDirectory();
    for await (const [name, handle] of root) {
      if (handle.kind === "directory" && name.startsWith(prefix)) {
        await root.removeEntry(name, { recursive: true }).catch(() => {});
        console.log(`[OFFSCREEN] OPFS prefix cleanup: removed ${name}`);
      }
    }
  } catch (e) {
    console.warn(`[OFFSCREEN] OPFS prefix cleanup error:`, e.message);
  }
}

function cleanupSessionHeaders(sessionRuleId) {
  if (sessionRuleId) {
    chrome.runtime
      .sendMessage({
        target: "background",
        action: "REMOVE_SESSION_HEADERS",
        ruleId: sessionRuleId,
      })
      .catch(() => {});
  }
}

function guessExtension(filename, contentType) {
  if (!filename) return "video.mp4";

  const ext = filename.match(/\.(\w+)$/)?.[1]?.toLowerCase();
  if (ext && ["mp4", "webm", "mkv", "ts", "m4a", "mp3", "aac"].includes(ext)) {
    return filename;
  }

  const extMap = {
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "video/mp2t": ".ts",
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",
    "audio/aac": ".aac",
    "audio/ogg": ".ogg",
    "audio/webm": ".webm",
  };

  const guessed = extMap[contentType] || ".mp4";
  return filename.replace(/\.\w*$/, "") + guessed;
}
