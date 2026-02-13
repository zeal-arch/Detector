(function () {
  "use strict";

  const detectionLog = [];
  const MAX_LOG_ENTRIES = 100;

  function logDetection(source, url, metadata = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      source: source,
      url: url.substring(0, 100),
      hostname: window.location.hostname,
      pageUrl: window.location.href,
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
      UNKNOWN: "#9E9E9E",
    };

    const color = colors[source] || colors["UNKNOWN"];
    const priority =
      source === "SITE_SPECIALIST"
        ? "1️⃣"
        : source === "GENERIC_IE"
          ? "2️⃣"
          : source === "MSE_INTERCEPTOR"
            ? "3️⃣"
            : "❓";

    console.log(
      `%c[Detection] ${priority} ${source}%c found video on %c${entry.hostname}`,
      `color: ${color}; font-weight: bold`,
      "color: inherit",
      "color: #2196F3; font-weight: bold",
    );
    console.log(`  URL: ${entry.url}${entry.url.length >= 100 ? "..." : ""}`);
    if (metadata.title) console.log(`  Title: ${metadata.title}`);
    if (metadata.type) console.log(`  Type: ${metadata.type}`);
  }

  function getDetectionLog() {
    return [...detectionLog];
  }

  function getDetectionSummary() {
    const summary = {
      total: detectionLog.length,
      bySource: {},
      byHostname: {},
    };

    for (const entry of detectionLog) {
      summary.bySource[entry.source] =
        (summary.bySource[entry.source] || 0) + 1;
      summary.byHostname[entry.hostname] =
        (summary.byHostname[entry.hostname] || 0) + 1;
    }

    return summary;
  }

  window.addEventListener("message", (event) => {
    if (event.data?.type === "MAGIC_M3U8_DETECTION") {
      const source = event.data.source || "UNKNOWN";
      const data = event.data.data || {};

      logDetection(source, data.url || "unknown", {
        title: data.options?.customTitle,
        type: data.type,
        platform: data.options?.platform,
      });
    }
  });

  if (typeof window !== "undefined") {
    window.__DETECTION_LOG = {
      getLog: getDetectionLog,
      getSummary: getDetectionSummary,
      clear: () => {
        detectionLog.length = 0;
      },
    };
  }

  console.log(
    "[Detection Logger] Initialized - Use window.__DETECTION_LOG.getLog() to view detection history",
  );
})();
