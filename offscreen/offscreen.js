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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== "offscreen") return false;

  switch (msg.action) {
    case "EVAL_NSIG":
      handleEvalNSig(msg, sendResponse);
      return true;

    case "EVAL_CIPHER":
      handleEvalCipher(msg, sendResponse);
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

window.addEventListener("message", (e) => {
  if (e.source !== sandbox.contentWindow) return;
  const { id, results, error } = e.data || {};
  if (!id || !pending.has(id)) return;

  const respond = pending.get(id);
  pending.delete(id);

  if (error) {
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

      console.log("[OFFSCREEN] Initializing libav.js...");

      const wasmUrl = chrome.runtime.getURL(
        "lib/libav-6.5.7.1-h264-aac-mp3.wasm.wasm",
      );
      const wasmResp = await fetch(wasmUrl);
      if (!wasmResp.ok) {
        throw new Error(`Failed to fetch WASM binary: HTTP ${wasmResp.status}`);
      }
      const wasmBinary = await wasmResp.arrayBuffer();
      console.log(
        `[OFFSCREEN] WASM binary loaded: ${(wasmBinary.byteLength / 1024 / 1024).toFixed(2)} MB`,
      );

      libavInstance = await LibAVFactory({
        wasmBinary: new Uint8Array(wasmBinary),
      });

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
    response = await fetch(url, {
      credentials: "include",
      mode: "cors",
      cache: "no-cache",
      signal,
    });
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
    for await (const [name] of root) {
      if (
        name.startsWith("merge_video_") ||
        name.startsWith("merge_audio_") ||
        name.startsWith("merge_output_")
      ) {
        await root.removeEntry(name).catch(() => {});
      }
    }
    console.log("[OFFSCREEN] OPFS merge cleanup done");
  } catch (e) {
    console.warn("[OFFSCREEN] OPFS merge cleanup error:", e.message);
  }
}

function cleanupMEMFS() {
  if (!libavInstance) return;
  // Clean up all possible input/output filenames (both MP4 and WebM variants)
  for (const f of [
    "input_video.mp4", "input_video.webm",
    "input_audio.mp4", "input_audio.webm",
    "output.mp4", "output.webm",
  ]) {
    try { libavInstance.unlink(f); } catch (e) {}
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

async function handleMergeAndDownload(msg, sendResponse) {
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
    const blobUrl = URL.createObjectURL(blob);
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
  const { downloadId, url, type, filename, headers, sessionRuleId } = msg;

  try {
    const workerUrl = chrome.runtime.getURL("workers/download-worker.js");
    const worker = new Worker(workerUrl);
    activeWorkers.set(downloadId, worker);

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

        case "download_result":
          try {
            let finalBlobUrl;
            let finalFilename = filename;
            let finalSize = msgData.size || 0;

            const TRANSMUX_MAX = 2 * 1024 * 1024 * 1024;
            if (msgData.needsTransmux && (msgData.size || 0) < TRANSMUX_MAX) {
              try {
                bc.postMessage({
                  type: "WORKER_PROGRESS",
                  downloadId,
                  phase: "transmuxing",
                  message: "Converting TS → MP4...",
                  percent: 85,
                  filename,
                });

                const tsResp = await fetch(msgData.blobUrl);
                const tsBuffer = new Uint8Array(await tsResp.arrayBuffer());

                URL.revokeObjectURL(msgData.blobUrl);

                console.log(
                  `[OFFSCREEN] Transmuxing TS → MP4: ${(tsBuffer.byteLength / 1024 / 1024).toFixed(2)} MB`,
                );

                const libav = await getLibAV();

                try {
                  libav.unlink("input.ts");
                } catch (e) {}
                try {
                  libav.unlink("output.mp4");
                } catch (e) {}

                libav.writeFile("input.ts", tsBuffer);

                const exitCode = await libav.ffmpeg([
                  "-y",
                  "-i",
                  "input.ts",
                  "-c:v",
                  "copy",
                  "-c:a",
                  "copy",
                  "-bsf:a",
                  "aac_adtstoasc",
                  "-movflags",
                  "+faststart",
                  "output.mp4",
                ]);

                if (exitCode !== 0) {
                  throw new Error(
                    `FFmpeg transmux failed with exit code ${exitCode}`,
                  );
                }

                const mp4Data = libav.readFile("output.mp4");
                console.log(
                  `[OFFSCREEN] Transmux complete: ${(mp4Data.byteLength / 1024 / 1024).toFixed(2)} MB`,
                );

                const mp4Blob = new Blob([mp4Data], { type: "video/mp4" });
                finalBlobUrl = URL.createObjectURL(mp4Blob);
                finalFilename = ensureMp4Extension(filename);
                finalSize = mp4Blob.size;

                try {
                  libav.unlink("input.ts");
                } catch (e) {}
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
              } catch (transmuxErr) {
                console.warn(
                  "[OFFSCREEN] Transmux failed, falling back to raw TS:",
                  transmuxErr,
                );

                finalBlobUrl = msgData.blobUrl;
                finalFilename = guessExtension(
                  filename,
                  msgData.mimeType || msgData.contentType,
                );
                finalSize = msgData.size || 0;
              }
            } else {
              if (
                msgData.needsTransmux &&
                (msgData.size || 0) >= TRANSMUX_MAX
              ) {
                console.warn(
                  `[OFFSCREEN] File too large for transmux (${(msgData.size / 1024 / 1024 / 1024).toFixed(2)} GB). Downloading as raw .ts`,
                );
              }
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
                  6 * 60 * 60 * 1000,
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
          cleanupSessionHeaders(sessionRuleId);
          break;

        case "download_error":
          console.error("[OFFSCREEN] Worker error:", msgData.error);
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
          cleanupSessionHeaders(sessionRuleId);
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
      cleanupSessionHeaders(sessionRuleId);
    };

    worker.postMessage({
      name: "start_download",
      data: {
        download_id: downloadId,
        url,
        type,
        filename,
        headers: headers || {},
      },
    });

    console.log(`[OFFSCREEN] Started download worker: ${downloadId} (${type})`);
    sendResponse({ success: true, downloadId });
  } catch (err) {
    console.error("[OFFSCREEN] Failed to start worker:", err);
    cleanupSessionHeaders(sessionRuleId);
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
