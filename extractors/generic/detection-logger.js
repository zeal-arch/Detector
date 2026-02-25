(function () {
  "use strict";

  const detectionLog = [];
  const MAX_LOG_ENTRIES = 200;
  const performanceMarks = new Map();
  const duplicateTracker = new Map(); // url -> first detection time
  const sessionStart = Date.now();

  // Confidence scoring weights by source
  const SOURCE_CONFIDENCE = {
    SITE_SPECIALIST: 1.0,
    GENERIC_IE: 0.7,
    MSE_INTERCEPTOR: 0.9,
    NETWORK_HOOK: 0.85,
    SSR_FRAMEWORK: 0.8,
    DATA_ATTRIBUTE: 0.65,
    JS_GLOBAL: 0.6,
    CDN_PATTERN: 0.55,
    OBFUSCATED_URL: 0.5,
    BASE64_DECODE: 0.45,
    PRELOAD_LINK: 0.6,
    WEBSOCKET: 0.8,
    EVENTSOURCE: 0.75,
    WEBRTC: 0.7,
    CANVAS_VIDEO: 0.4,
    LAZY_VIDEO: 0.65,
    CUSTOM_ELEMENT: 0.6,
    OBJECT_EMBED: 0.5,
    MEDIA_SESSION: 0.7,
    PERFORMANCE_API: 0.6,
    UNKNOWN: 0.3,
  };

  // Format confidence multipliers
  const FORMAT_CONFIDENCE = {
    "application/x-mpegURL": 1.0,
    "application/vnd.apple.mpegurl": 1.0,
    "application/dash+xml": 0.95,
    "video/mp4": 0.85,
    "video/webm": 0.8,
    "video/mp2t": 0.75,
    "audio/mpeg": 0.6,
    "audio/mp4": 0.6,
  };

  function computeConfidence(source, metadata = {}) {
    let confidence = SOURCE_CONFIDENCE[source] || SOURCE_CONFIDENCE.UNKNOWN;

    // Boost for known format
    if (metadata.type && FORMAT_CONFIDENCE[metadata.type]) {
      confidence *= FORMAT_CONFIDENCE[metadata.type];
    }

    // Boost for presence of title/metadata
    if (metadata.title) confidence = Math.min(confidence + 0.05, 1.0);

    // Boost for HTTPS
    if (metadata.url && metadata.url.startsWith("https://")) {
      confidence = Math.min(confidence + 0.02, 1.0);
    }

    // Penalty for very short URLs (likely false positives)
    if (metadata.url && metadata.url.length < 20) {
      confidence *= 0.5;
    }

    // Penalty for localhost/loopback
    if (metadata.url && /localhost|127\.0\.0\.1|::1/.test(metadata.url)) {
      confidence *= 0.3;
    }

    return Math.round(confidence * 100) / 100;
  }

  function startTiming(label) {
    performanceMarks.set(label, performance.now());
  }

  function endTiming(label) {
    const start = performanceMarks.get(label);
    if (start !== undefined) {
      const elapsed = Math.round((performance.now() - start) * 100) / 100;
      performanceMarks.delete(label);
      return elapsed;
    }
    return null;
  }

  function logDetection(source, url, metadata = {}) {
    const confidence = computeConfidence(source, { ...metadata, url });
    const isDuplicate = duplicateTracker.has(url);
    const now = Date.now();

    if (!isDuplicate) {
      duplicateTracker.set(url, now);
    }

    const entry = {
      timestamp: new Date().toISOString(),
      elapsedMs: now - sessionStart,
      source: source,
      url: url.substring(0, 200),
      fullUrl: url,
      hostname: window.location.hostname,
      pageUrl: window.location.href,
      confidence: confidence,
      isDuplicate: isDuplicate,
      detectionTimeMs: endTiming(source) || null,
      ...metadata,
    };

    detectionLog.push(entry);

    if (detectionLog.length > MAX_LOG_ENTRIES) {
      detectionLog.shift();
    }

    const colors = {
      SITE_SPECIALIST: "#4CAF50",
      GENERIC_IE: "#FF9800",
      MSE_INTERCEPTOR: "#F44336",
      NETWORK_HOOK: "#E91E63",
      SSR_FRAMEWORK: "#9C27B0",
      DATA_ATTRIBUTE: "#673AB7",
      JS_GLOBAL: "#3F51B5",
      CDN_PATTERN: "#00BCD4",
      OBFUSCATED_URL: "#FF5722",
      BASE64_DECODE: "#795548",
      PRELOAD_LINK: "#607D8B",
      WEBSOCKET: "#2196F3",
      EVENTSOURCE: "#009688",
      WEBRTC: "#8BC34A",
      CANVAS_VIDEO: "#CDDC39",
      LAZY_VIDEO: "#FFC107",
      CUSTOM_ELEMENT: "#FF9800",
      OBJECT_EMBED: "#BF360C",
      MEDIA_SESSION: "#1B5E20",
      PERFORMANCE_API: "#0D47A1",
      UNKNOWN: "#9E9E9E",
    };

    const color = colors[source] || colors["UNKNOWN"];
    const priority =
      source === "SITE_SPECIALIST"
        ? "1️⃣"
        : source === "MSE_INTERCEPTOR"
          ? "2️⃣"
          : source === "NETWORK_HOOK" || source === "WEBSOCKET"
            ? "3️⃣"
            : source === "GENERIC_IE"
              ? "4️⃣"
              : source === "SSR_FRAMEWORK"
                ? "5️⃣"
                : "🔍";

    const confBar =
      "█".repeat(Math.round(confidence * 10)) +
      "░".repeat(10 - Math.round(confidence * 10));
    const dupLabel = isDuplicate ? " [DUP]" : "";

    console.log(
      `%c[Detection] ${priority} ${source}%c [${confBar} ${(confidence * 100).toFixed(0)}%%]${dupLabel}%c on %c${entry.hostname}`,
      `color: ${color}; font-weight: bold`,
      `color: ${confidence >= 0.7 ? "#4CAF50" : confidence >= 0.4 ? "#FF9800" : "#F44336"}`,
      "color: inherit",
      "color: #2196F3; font-weight: bold",
    );
    console.log(`  URL: ${entry.url}${url.length > 200 ? "..." : ""}`);
    if (metadata.title) console.log(`  Title: ${metadata.title}`);
    if (metadata.type) console.log(`  Type: ${metadata.type}`);
    if (entry.detectionTimeMs !== null)
      console.log(`  Detection time: ${entry.detectionTimeMs}ms`);
    if (metadata.subtitleCount)
      console.log(`  Subtitles: ${metadata.subtitleCount}`);
  }

  function getDetectionLog() {
    return [...detectionLog];
  }

  function getUniqueDetections() {
    const seen = new Set();
    return detectionLog.filter((entry) => {
      if (seen.has(entry.fullUrl)) return false;
      seen.add(entry.fullUrl);
      return true;
    });
  }

  function getHighConfidenceDetections(threshold = 0.6) {
    return detectionLog.filter((entry) => entry.confidence >= threshold);
  }

  function getBestDetection() {
    if (detectionLog.length === 0) return null;
    return detectionLog.reduce((best, entry) =>
      entry.confidence > best.confidence ? entry : best,
    );
  }

  function getDetectionSummary() {
    const summary = {
      total: detectionLog.length,
      uniqueUrls: duplicateTracker.size,
      duplicates: detectionLog.filter((e) => e.isDuplicate).length,
      averageConfidence: 0,
      sessionDurationMs: Date.now() - sessionStart,
      bySource: {},
      byHostname: {},
      byConfidence: { high: 0, medium: 0, low: 0 },
      byType: {},
      timingStats: {},
    };

    let totalConfidence = 0;

    for (const entry of detectionLog) {
      summary.bySource[entry.source] =
        (summary.bySource[entry.source] || 0) + 1;
      summary.byHostname[entry.hostname] =
        (summary.byHostname[entry.hostname] || 0) + 1;

      totalConfidence += entry.confidence;

      if (entry.confidence >= 0.7) summary.byConfidence.high++;
      else if (entry.confidence >= 0.4) summary.byConfidence.medium++;
      else summary.byConfidence.low++;

      if (entry.type) {
        summary.byType[entry.type] = (summary.byType[entry.type] || 0) + 1;
      }

      if (entry.detectionTimeMs !== null) {
        if (!summary.timingStats[entry.source]) {
          summary.timingStats[entry.source] = {
            count: 0,
            total: 0,
            min: Infinity,
            max: 0,
          };
        }
        const stat = summary.timingStats[entry.source];
        stat.count++;
        stat.total += entry.detectionTimeMs;
        stat.min = Math.min(stat.min, entry.detectionTimeMs);
        stat.max = Math.max(stat.max, entry.detectionTimeMs);
      }
    }

    summary.averageConfidence =
      detectionLog.length > 0
        ? Math.round((totalConfidence / detectionLog.length) * 100) / 100
        : 0;

    // Compute averages for timing stats
    for (const key of Object.keys(summary.timingStats)) {
      const stat = summary.timingStats[key];
      stat.average = Math.round((stat.total / stat.count) * 100) / 100;
    }

    return summary;
  }

  function exportLog(format = "json") {
    const data = {
      exportedAt: new Date().toISOString(),
      summary: getDetectionSummary(),
      entries: getDetectionLog(),
    };

    if (format === "json") {
      return JSON.stringify(data, null, 2);
    }

    if (format === "csv") {
      const headers =
        "timestamp,source,confidence,url,hostname,type,isDuplicate,detectionTimeMs\n";
      return (
        headers +
        detectionLog
          .map(
            (e) =>
              `"${e.timestamp}","${e.source}",${e.confidence},"${e.url}","${e.hostname}","${e.type || ""}",${e.isDuplicate},${e.detectionTimeMs || ""}`,
          )
          .join("\n")
      );
    }

    return data;
  }

  window.addEventListener("message", (event) => {
    if (event.data?.type === "MAGIC_M3U8_DETECTION") {
      const source = event.data.source || "UNKNOWN";
      const data = event.data.data || {};

      logDetection(source, data.url || "unknown", {
        title: data.options?.customTitle,
        type: data.type,
        platform: data.options?.platform,
        subtitleCount: data.options?.subtitleCount,
      });
    }
  });

  if (typeof window !== "undefined") {
    window.__DETECTION_LOG = {
      getLog: getDetectionLog,
      getSummary: getDetectionSummary,
      getUnique: getUniqueDetections,
      getHighConfidence: getHighConfidenceDetections,
      getBest: getBestDetection,
      export: exportLog,
      startTiming: startTiming,
      endTiming: endTiming,
      logDetection: logDetection,
      clear: () => {
        detectionLog.length = 0;
        duplicateTracker.clear();
        performanceMarks.clear();
      },
    };
  }

  console.log(
    "[Detection Logger] GOD-mode initialized — confidence scoring, timing, dedup, export\n" +
      "  Use window.__DETECTION_LOG.getLog() for full history\n" +
      "  Use window.__DETECTION_LOG.getSummary() for stats\n" +
      "  Use window.__DETECTION_LOG.getUnique() for deduplicated results\n" +
      "  Use window.__DETECTION_LOG.getBest() for highest-confidence detection\n" +
      "  Use window.__DETECTION_LOG.export('json'|'csv') to export",
  );
})();
