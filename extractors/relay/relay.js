(function () {

  let failureCount = 0;
  const MAX_FAILURES = 10;
  let lastFailureTime = 0;
  const FAILURE_RESET_MS = 60000;
  let extensionInvalidated = false;

  function sendMessageWithRetry(messageData) {

    if (extensionInvalidated || !chrome?.runtime?.sendMessage) {

      return;
    }

    chrome.runtime.sendMessage(messageData).catch((err) => {

      if (
        err.message &&
        err.message.includes("Extension context invalidated")
      ) {
        console.log("[relay] Extension reloaded, stopping message relay");
        extensionInvalidated = true;
        return;
      }

      if (
        err.message &&
        (err.message.includes("Cannot read properties") ||
          err.message.includes("Cannot access"))
      ) {
        extensionInvalidated = true;
        return;
      }

      const now = Date.now();

      if (now - lastFailureTime > FAILURE_RESET_MS) {
        failureCount = 0;
      }

      failureCount++;
      lastFailureTime = now;

      console.error(
        `[relay] Message failed (${failureCount}/${MAX_FAILURES}):`,
        err.message,
      );

      if (failureCount >= MAX_FAILURES) {
        const errorMsg =
          "Recording connection lost! Extension may have crashed. Please refresh the page.";
        console.error(`[relay] ${errorMsg}`);

        if (failureCount === MAX_FAILURES) {
          alert(`⚠️ Video Downloader Error\n\n${errorMsg}`);
        }
      }
    });
  }

  window.addEventListener("message", (event) => {

    if (!event || event.source !== window) return;
    if (!event.data || typeof event.data !== "object") return;

    try {
      const { type, source, data, payload } = event.data;

      if (type === "MAGIC_M3U8_DETECTION" && source === "SITE_SPECIALIST") {
        console.log("[Relay] Received MAGIC_M3U8_DETECTION from specialist");
        sendMessageWithRetry({
          action: "video_detected",
          payload: data || payload,
        });
      }

      if (type === "YOUTUBE_FRESH_URL_RESPONSE") {
        sendMessageWithRetry({
          action: "YOUTUBE_FRESH_URL_RESPONSE",
          requestId: event.data.requestId,
          success: event.data.success,
          data: event.data.data,
          error: event.data.error,
        });
      }

      if (type === "YOUTUBE_DOWNLOAD_RESULT") {
        sendMessageWithRetry({
          action: "YOUTUBE_DOWNLOAD_RESULT",
          requestId: event.data.requestId,
          success: event.data.success,
          error: event.data.error,
        });
      }

      if (type === "YOUTUBE_DOWNLOAD_INITIATED") {
        sendMessageWithRetry({
          action: "YOUTUBE_DOWNLOAD_INITIATED",
          filename: event.data.filename,
          size: event.data.size,
        });
      }

      if (type === "YOUTUBE_DOWNLOAD_PROGRESS") {
        sendMessageWithRetry({
          action: "download_progress",
          progress: event.data.progress,
          speed: event.data.speed,
        });
      }

      if (type === "EXECUTE_JS_REQUEST") {
        chrome.runtime.sendMessage(
          {
            action: "execute_js",
            code: event.data.code,
            input: event.data.input,
            requestId: event.data.requestId,
          },
          (response) => {

            window.postMessage(
              {
                type: "EXECUTE_JS_RESPONSE",
                requestId: event.data.requestId,
                success: response?.success || false,
                result: response?.result,
                error: response?.error || chrome.runtime.lastError?.message,
              },
              "*",
            );
          },
        );
      }

      if (type === "YOUTUBE_INTERCEPTED_FORMATS") {
        sendMessageWithRetry({
          action: "youtube_intercepted_formats",
          videoId: event.data.videoId,
          formats: event.data.formats,
          sabrMode: event.data.sabrMode || false,
          source: event.data.source,
        });
      }

      if (type === "YOUTUBE_TRANSFORM_URL_REQUEST") {
        chrome.runtime.sendMessage(
          {
            action: "youtube_transform_url",
            url: event.data.url,
            fullDecipher: event.data.fullDecipher || false,
            requestId: event.data.requestId,
          },
          (response) => {

            window.postMessage(
              {
                type: "YOUTUBE_TRANSFORM_URL_RESPONSE",
                requestId: event.data.requestId,
                success: response?.success || false,
                url: response?.url || event.data.url,
                transformed: response?.transformed || false,
                error: response?.error || chrome.runtime.lastError?.message,
              },
              "*",
            );
          },
        );
      }

      if (
        type === "SPECIALIST_MSE_INIT" ||
        type === "SPECIALIST_MSE_DATA" ||
        type === "SPECIALIST_MSE_DATA_BATCH"
      ) {

        if (type === "SPECIALIST_MSE_DATA_BATCH") {
          const chunks = payload?.chunks || [];
          console.log(
            `[relay] Forwarding batch of ${chunks.length} buffered chunks`,
          );

          chunks.forEach((chunk) => {
            sendMessageWithRetry({
              action: "mse_activity",
              type: "SPECIALIST_MSE_DATA",
              payload: chunk,
            });
          });
          return;
        }

        const msePayload =
          type === "SPECIALIST_MSE_INIT"
            ? {
                mimeType: event.data.mimeType || "unknown",
                groupId: event.data.groupId || null,
                streamId: event.data.streamId || null,
                streamType: event.data.streamType || "unknown",
                hasVideo: event.data.hasVideo || false,
                hasAudio: event.data.hasAudio || false,
                isMultiTrack: event.data.isMultiTrack || false,
              }
            : payload || event.data.payload || {};

        if (
          type === "SPECIALIST_MSE_DATA" &&
          (msePayload.data || msePayload.dataBase64)
        ) {

          if (!window.__MSE_CHUNK_COUNT) window.__MSE_CHUNK_COUNT = 0;
          window.__MSE_CHUNK_COUNT++;
          if (window.__MSE_CHUNK_COUNT % 100 === 0) {
            const encoding = msePayload.encoding || "array";
            console.log(
              `[relay] Forwarded ${window.__MSE_CHUNK_COUNT} chunks to background (${encoding} encoding)`,
            );
          }
        }

        sendMessageWithRetry({
          action: "mse_activity",
          type: type,
          payload: msePayload,
        });
      }

      if (type === "SPECIALIST_MSE_THUMBNAIL") {
        sendMessageWithRetry({
          action: "mse_thumbnail",
          payload: payload || event.data.payload || {},
        });
      }

      if (type === "SPECIALIST_PAGE_UNLOAD") {

        sendMessageWithRetry({
          action: "page_unload_during_recording",
          timestamp: event.data.timestamp,
        });
      }
    } catch (err) {

      if (
        err.message &&
        err.message.includes("Extension context invalidated")
      ) {
        extensionInvalidated = true;
        return;
      }

      if (err.message && !err.message.includes("Cannot read properties")) {
        console.warn("[relay] Message handling error:", err.message);
      }
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {

    if (message.action === "YOUTUBE_GET_FRESH_URL") {
      window.postMessage(
        {
          type: "YOUTUBE_GET_FRESH_URL",
          videoId: message.videoId,
          requestId: message.requestId,
        },
        "*",
      );
    }

    if (message.action === "YOUTUBE_PERFORM_DOWNLOAD") {
      window.postMessage(
        {
          type: "YOUTUBE_PERFORM_DOWNLOAD",
          url: message.url,
          filename: message.filename,
          requestId: message.requestId,
        },
        "*",
      );
    }

    if (message.action === "GET_YOUTUBE_PAGE_DATA") {
      const requestId = Math.random().toString(36).substring(7);

      const handleResponse = (event) => {
        if (event.source !== window) return;
        if (event.data?.type !== "YOUTUBE_PAGE_DATA_RESPONSE") return;
        if (event.data?.requestId !== requestId) return;

        window.removeEventListener("message", handleResponse);

        if (event.data.success) {
          sendResponse({ success: true, data: event.data.data });
        } else {
          sendResponse({ success: false, error: event.data.error });
        }
      };

      window.addEventListener("message", handleResponse);

      window.postMessage(
        {
          type: "GET_YOUTUBE_PAGE_DATA",
          requestId,
        },
        "*",
      );

      setTimeout(() => {
        window.removeEventListener("message", handleResponse);
        sendResponse({
          success: false,
          error: "Timeout waiting for page data",
        });
      }, 5000);

      return true;
    }

    if (message.action === "YOUTUBE_GET_PLAYER_QUALITY") {
      try {
        const video = document.querySelector("video.html5-main-video");
        const player = document.querySelector("#movie_player");

        let quality = null;
        let availableQualities = [];

        if (player && typeof player.getPlaybackQuality === "function") {
          quality = player.getPlaybackQuality();
        }
        if (player && typeof player.getAvailableQualityLevels === "function") {
          availableQualities = player.getAvailableQualityLevels();
        }

        const height = video?.videoHeight || 0;
        const width = video?.videoWidth || 0;

        sendResponse({
          height,
          width,
          quality,
          availableQualities,
        });
      } catch (err) {
        sendResponse({ height: 0, width: 0, quality: null });
      }
      return true;
    }

    if (message.action === "YOUTUBE_SET_QUALITY_AND_CAPTURE") {
      (async () => {
        try {
          const targetQuality = message.targetQuality;
          const player = document.querySelector("#movie_player");
          const video = document.querySelector("video.html5-main-video");

          if (!player || typeof player.setPlaybackQualityRange !== "function") {
            sendResponse({ success: false, error: "Player not available" });
            return;
          }

          console.log("[Relay] Setting quality to:", targetQuality);

          const wasPlaying = video && !video.paused;
          const currentTime = video?.currentTime || 0;

          player.setPlaybackQualityRange(targetQuality, targetQuality);

          if (!wasPlaying && video) {
            video.muted = true;
            video.play().catch(() => {});

            await new Promise((resolve) => setTimeout(resolve, 2000));

            video.pause();
            video.currentTime = currentTime;
            video.muted = false;
          } else {

            await new Promise((resolve) => setTimeout(resolve, 1500));
          }

          const actualQuality = player.getPlaybackQuality?.() || "unknown";
          const actualHeight = video?.videoHeight || 0;

          console.log("[Relay] Quality set result:", {
            targetQuality,
            actualQuality,
            actualHeight,
          });

          sendResponse({
            success: true,
            targetQuality,
            actualQuality,
            actualHeight,
          });
        } catch (err) {
          console.error("[Relay] Set quality failed:", err);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    return false;
  });
})();
