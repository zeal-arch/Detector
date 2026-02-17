/**
 * Robust segment download pool with adaptive rate-limiting and content validation.
 *
 * Features:
 *   - Parses Retry-After header from 429 responses
 *   - Jitter on all backoff delays to prevent thundering herd
 *   - Adaptive concurrency: halves on 429, gradually restores on success
 *   - Per-domain request spacing (min delay between fetches)
 *   - Separate retry budgets for rate-limits vs server errors
 *   - Exponential backoff with configurable base and cap
 *   - Content-Type validation: rejects HTML/JS/ad responses from pirate CDNs
 *   - Segment data magic-byte validation (TS sync byte / fMP4 box headers)
 *   - Ad-server response header detection (DCLK-AdSvr etc.)
 *   - Minimum segment size threshold to reject tracker pixels
 */
class SegmentPool {
  /**
   * @param {number} concurrency  Max parallel fetches (default 4)
   * @param {number} maxRetries   Base retry count for non-429 errors (default 3)
   * @param {object} opts         Optional overrides
   */
  constructor(concurrency = 6, maxRetries = 3, opts = {}) {
    this.concurrency = concurrency;
    this._originalConcurrency = concurrency;
    // Allow ramp-up above original when consistently succeeding (auto-scaling)
    this._maxConcurrency = opts.maxConcurrency ?? Math.min(concurrency + 4, 10);
    this.maxRetries = maxRetries;

    this._requestSpacingMs = opts.requestSpacingMs ?? 50;
    this._rateRetryExtra = opts.rateRetryExtra ?? 5;
    this._rateBackoffBaseMs = opts.rateBackoffBaseMs ?? 2000;
    this._rateBackoffCapMs = opts.rateBackoffCapMs ?? 60000;
    this._errorBackoffBaseMs = opts.errorBackoffBaseMs ?? 500;
    this._errorBackoffCapMs = opts.errorBackoffCapMs ?? 16000;
    this._timeoutMs = opts.timeoutMs ?? 30000;

    // Content validation settings
    this._validateContent = opts.validateContent !== false; // on by default
    this._minSegmentBytes = opts.minSegmentBytes ?? 512; // reject tiny ad pixels
    this._maxAdRetries = opts.maxAdRetries ?? 3; // retries for ad-like responses

    // Known ad-server signatures in response headers
    this._adServerSignatures = [
      "DCLK-AdSvr",
      "DoubleClick",
      "googlesyndication",
      "googleads",
      "adservice",
      "adnxs",
      "amazon-adsystem",
    ];

    // Content-Types that are never valid video segments
    this._invalidContentTypes = [
      "text/html",
      "text/javascript",
      "application/javascript",
      "application/json",
      "text/css",
      "text/xml",
      "application/xml",
      "image/gif",
      "image/png",
      "image/jpeg",
      "image/webp",
    ];

    this._queue = [];
    this._active = 0;
    this._aborted = false;
    this._consecutive429 = 0;
    this._successesSinceThrottle = 0; // Dedicated counter for predictable concurrency restoration
    this._lastFetchTime = 0;
    this._globalPauseUntil = 0;
    this._completedCount = 0;
    this._failedCount = 0;
    this._adBlockedCount = 0;
    // S27 fix: track in-flight AbortControllers so cancel() can abort them
    this._inflightControllers = new Set();
    // S33 fix: enforce atomic request spacing to prevent TOCTOU race
    this._spacingQueue = Promise.resolve();

    // S35 fix: URL refresh support for expired YouTube URLs
    this._onUrlRefreshNeeded = opts.onUrlRefreshNeeded || null;
    this._urlRefreshInProgress = false;
    this._urlMap = new Map(); // maps old URL to new URL after refresh
    this._consecutive403 = 0; // track persistent 403s on YouTube

    // S36 fix: Sleep/wake detection for laptop suspend scenario
    this._lastSuccessTime = Date.now();
    this._lastSuccessPerfTime = performance.now();
    this._onSleepWakeDetected = opts.onSleepWakeDetected || null;
    this._sleepDetectionThreshold = opts.sleepDetectionThreshold || 60000; // 60s gap suggests sleep

    // S40 fix: Network change detection (WiFi switch, VPN disconnect)
    this._onNetworkChange = opts.onNetworkChange || null;
    this._setupNetworkMonitoring();

    // S46 fix: VPN disconnect detection via IP signature mismatch pattern
    this._recent403Timestamps = [];
    this._vpnDisconnectThreshold = 3; // 3+ 403s within short window = likely IP change
    this._vpnDisconnectWindow = 10000; // 10 seconds

    // S52 fix: Video removal detection via 404 patterns
    this._recent404Timestamps = [];
    this._404BurstThreshold = 5; // 5+ 404s in short window = video removed mid-download
    this._404BurstWindow = 5000; // 5 seconds
    this._segmentCount = 0; // track total segments to detect early vs late 404s
  }

  // S40 fix: Monitor network changes using Network Information API
  _setupNetworkMonitoring() {
    if (
      typeof navigator !== "undefined" &&
      navigator.connection &&
      typeof navigator.connection.addEventListener === "function"
    ) {
      navigator.connection.addEventListener("change", () => {
        const conn = navigator.connection;
        console.warn(
          `[SegmentPool] Network change detected: type=${conn.effectiveType}, downlink=${conn.downlink}Mbps`,
        );
        if (this._onNetworkChange) {
          this._onNetworkChange({
            effectiveType: conn.effectiveType,
            downlink: conn.downlink,
            rtt: conn.rtt,
          });
        }
      });
    }
  }

  /** Enqueue a segment download. Returns Promise<Uint8Array>. */
  fetch(url, index, options = {}) {
    if (this._aborted) return Promise.reject(new Error("Pool aborted"));

    // S52: Track total segment count for early vs late 404 detection
    if (index >= this._segmentCount) {
      this._segmentCount = index + 1;
    }

    return new Promise((resolve, reject) => {
      this._queue.push({
        url,
        index,
        options,
        resolve,
        reject,
        retries: 0,
        rateRetries: 0,
      });
      this._processQueue();
    });
  }

  /** Get stats about pool state */
  get stats() {
    return {
      concurrency: this.concurrency,
      originalConcurrency: this._originalConcurrency,
      active: this._active,
      queued: this._queue.length,
      completed: this._completedCount,
      failed: this._failedCount,
      consecutive429: this._consecutive429,
      adBlocked: this._adBlockedCount,
    };
  }

  // ───────────────── Queue management ─────────────────

  _processQueue() {
    while (
      this._active < this.concurrency &&
      this._queue.length > 0 &&
      !this._aborted
    ) {
      const task = this._queue.shift();
      this._active++;
      this._runTask(task);
    }
  }

  async _runTask(task) {
    try {
      const data = await this._fetchWithRetry(task);
      this._active--;
      this._completedCount++;
      this._onSuccess();
      task.resolve(data);
    } catch (err) {
      this._active--;
      this._failedCount++;
      task.reject(err);
    }
    this._processQueue();
  }

  // ───────────────── Rate-limit management ─────────────────

  /** Called on every successful fetch — gradually restore concurrency */
  _onSuccess() {
    this._consecutive429 = 0;
    this._successesSinceThrottle++;
    // S35 fix: Reset consecutive 403 counter on successful fetch
    this._consecutive403 = 0;

    // S36 fix: Detect sleep/wake by tracking time gaps
    const now = Date.now();
    const perfNow = performance.now();
    const wallClockElapsed = now - this._lastSuccessTime;
    const perfElapsed = perfNow - this._lastSuccessPerfTime;
    const timeDrift = wallClockElapsed - perfElapsed;

    // If wall clock jumped forward significantly more than performance.now(),
    // system likely entered sleep (performance.now() pauses during sleep)
    if (
      timeDrift > this._sleepDetectionThreshold &&
      this._lastSuccessTime > 0
    ) {
      console.warn(
        `[SegmentPool] Sleep/wake detected: ${Math.round(timeDrift / 1000)}s time gap`,
      );
      if (this._onSleepWakeDetected) {
        this._onSleepWakeDetected({ timeDrift, wallClockElapsed, perfElapsed });
      }
    }

    this._lastSuccessTime = now;
    this._lastSuccessPerfTime = perfNow;

    if (this.concurrency < this._originalConcurrency) {
      // Restore +1 slot every 3 successful fetches since last throttle
      if (this._successesSinceThrottle % 3 === 0) {
        this.concurrency = Math.min(
          this.concurrency + 1,
          this._originalConcurrency,
        );
        console.log(`[SegmentPool] Restored concurrency → ${this.concurrency}`);
      }
    } else if (this.concurrency < this._maxConcurrency) {
      // Auto-scale above initial: ramp up +1 every 15 consecutive successes
      if (this._successesSinceThrottle % 15 === 0) {
        this.concurrency = Math.min(this.concurrency + 1, this._maxConcurrency);
        console.log(
          `[SegmentPool] Auto-scaled concurrency → ${this.concurrency} (max ${this._maxConcurrency})`,
        );
      }
    }
  }

  /** Called on 429 — reduce concurrency and set global pause */
  _throttleOnRateLimit(retryAfterMs) {
    this._consecutive429++;
    this._successesSinceThrottle = 0; // Reset restoration counter

    if (this._consecutive429 >= 2 && this.concurrency > 1) {
      const prev = this.concurrency;
      this.concurrency = Math.max(1, Math.floor(this.concurrency / 2));
      if (this.concurrency !== prev) {
        console.warn(
          `[SegmentPool] Rate limited — concurrency ${prev} → ${this.concurrency}`,
        );
      }
    }

    // Set a global pause so other tasks also wait
    if (retryAfterMs > 0) {
      const pauseUntil = Date.now() + retryAfterMs;
      if (pauseUntil > this._globalPauseUntil) {
        this._globalPauseUntil = pauseUntil;
      }
    }
  }

  /**
   * Parse Retry-After header from a 429 response.
   * Supports both seconds and HTTP-date formats.
   */
  _parseRetryAfter(resp) {
    const val = resp.headers.get("Retry-After");
    if (!val) return 0;

    const secs = parseInt(val, 10);
    if (!isNaN(secs) && secs > 0) return secs * 1000;

    const date = Date.parse(val);
    if (!isNaN(date)) {
      const ms = date - Date.now();
      return ms > 0 ? ms : 0;
    }
    return 0;
  }

  /**
   * Compute backoff with full jitter: random in [delay/2, delay].
   * Prevents thundering herd when many segments retry simultaneously.
   */
  _backoff(attempt, baseMs, capMs) {
    const expDelay = Math.min(capMs, baseMs * Math.pow(2, attempt));
    return Math.floor(expDelay / 2 + Math.random() * (expDelay / 2));
  }

  /** Enforce minimum spacing between requests */
  async _enforceSpacing() {
    if (this._requestSpacingMs <= 0) return;

    // S33 fix: Chain onto the previous spacing operation to prevent
    // concurrent tasks from all reading the same stale _lastFetchTime.
    // This makes the check-then-set operation atomic across concurrent calls.
    await this._spacingQueue;

    this._spacingQueue = (async () => {
      const now = Date.now();
      const elapsed = now - this._lastFetchTime;
      if (elapsed < this._requestSpacingMs) {
        await new Promise((r) =>
          setTimeout(r, this._requestSpacingMs - elapsed),
        );
      }
      this._lastFetchTime = Date.now();
    })();

    await this._spacingQueue;
  }

  /** Wait for any global pause (set by Retry-After) */
  async _waitForGlobalPause() {
    const now = Date.now();
    if (this._globalPauseUntil > now) {
      const wait = this._globalPauseUntil - now;
      console.log(`[SegmentPool] Global pause: waiting ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  // ───────────────── Content validation (anti-ad) ─────────────────

  /**
   * Check if a response's headers indicate it's from an ad server.
   * Inspired by IDM's DCLK-AdSvr detection in its qc() decision function.
   */
  _isAdServerResponse(resp) {
    const server = resp.headers.get("Server") || "";
    const via = resp.headers.get("Via") || "";
    const xServed = resp.headers.get("X-Served-By") || "";
    const combined = `${server} ${via} ${xServed}`.toLowerCase();

    for (const sig of this._adServerSignatures) {
      if (combined.includes(sig.toLowerCase())) {
        return sig;
      }
    }
    return null;
  }

  /**
   * Check Content-Type to see if the response is clearly NOT video data.
   * Valid segment types: video/MP2T, video/mp4, application/octet-stream,
   * binary/octet-stream, or empty/missing content-type (common for CDNs).
   */
  _isInvalidContentType(resp) {
    const ct = (resp.headers.get("Content-Type") || "").toLowerCase().trim();
    if (
      !ct ||
      ct === "application/octet-stream" ||
      ct === "binary/octet-stream"
    ) {
      return false; // Unknown/binary = likely fine
    }
    for (const invalid of this._invalidContentTypes) {
      if (ct.startsWith(invalid)) {
        return ct;
      }
    }
    return false;
  }

  /**
   * Validate downloaded segment data using magic bytes.
   * MPEG-TS segments start with sync byte 0x47.
   * fMP4 segments contain ISO BMFF box headers (moof, mdat, styp, ftyp, sidx).
   * Also detects HTML/JS responses that pirate CDNs may return as ad redirects.
   */
  _validateSegmentData(data) {
    if (!this._validateContent || !data || data.byteLength === 0) {
      return { valid: true };
    }

    // Too small — likely an ad tracker pixel or empty response
    if (data.byteLength < this._minSegmentBytes) {
      return {
        valid: false,
        reason: `too_small`,
        detail: `Segment only ${data.byteLength} bytes (min: ${this._minSegmentBytes})`,
      };
    }

    // Check for HTML response (pirate CDNs return ad pages with HTTP 200)
    // HTML starts with <!DOCTYPE, <html, <head, <script, <body, <meta, etc.
    const head = data.slice(0, Math.min(512, data.byteLength));
    const headStr = String.fromCharCode.apply(null, head).trim().toLowerCase();

    if (
      headStr.startsWith("<!doctype") ||
      headStr.startsWith("<html") ||
      headStr.startsWith("<head") ||
      headStr.startsWith("<script") ||
      headStr.startsWith("<body") ||
      headStr.startsWith("<meta") ||
      headStr.startsWith("<iframe") ||
      headStr.startsWith("<div")
    ) {
      return {
        valid: false,
        reason: "html_response",
        detail: "Response is HTML (likely ad redirect)",
      };
    }

    // Check for JavaScript response
    if (
      headStr.startsWith("var ") ||
      headStr.startsWith("function ") ||
      headStr.startsWith("(function") ||
      headStr.startsWith("window.") ||
      headStr.startsWith("document.") ||
      headStr.startsWith('"use strict"') ||
      headStr.startsWith("'use strict'")
    ) {
      return {
        valid: false,
        reason: "js_response",
        detail: "Response is JavaScript (likely ad script)",
      };
    }

    // Check for JSON response (API error or ad config)
    if (headStr.startsWith("{") || headStr.startsWith("[")) {
      // Small JSON is almost certainly not a video segment
      if (data.byteLength < 10000) {
        return {
          valid: false,
          reason: "json_response",
          detail: "Response is small JSON (likely ad config or error)",
        };
      }
    }

    // Positive identification: MPEG-TS sync byte
    if (data[0] === 0x47) {
      return { valid: true, type: "mpegts" };
    }

    // Positive identification: ISO BMFF / fMP4 box
    // Box structure: [4 bytes size][4 bytes type]
    if (data.byteLength >= 8) {
      const boxType = String.fromCharCode(data[4], data[5], data[6], data[7]);
      const knownBoxes = [
        "ftyp",
        "moov",
        "moof",
        "mdat",
        "styp",
        "sidx",
        "emsg",
        "prft",
        "free",
        "skip",
      ];
      if (knownBoxes.includes(boxType)) {
        return { valid: true, type: "fmp4" };
      }
    }

    // Check for ID3 tag (some HLS segments start with ID3 before TS data)
    if (
      data.byteLength >= 3 &&
      data[0] === 0x49 && // 'I'
      data[1] === 0x44 && // 'D'
      data[2] === 0x33 // '3'
    ) {
      return { valid: true, type: "id3_ts" };
    }

    // Check for WebM/Matroska EBML header
    if (
      data.byteLength >= 4 &&
      data[0] === 0x1a &&
      data[1] === 0x45 &&
      data[2] === 0xdf &&
      data[3] === 0xa3
    ) {
      return { valid: true, type: "webm" };
    }

    // If we can't positively identify it but it's not clearly bad,
    // allow it through (many CDNs serve segments with no recognizable header)
    return { valid: true, type: "unknown" };
  }

  // ───────────────── Core fetch logic ─────────────────

  async _fetchWithRetry(task) {
    const timeout = task.options.timeout || this._timeoutMs;
    const headers = { ...(task.options.headers || {}) };
    const maxRateRetries = this.maxRetries + this._rateRetryExtra;
    let adRetries = 0; // Track ad-response retries separately

    // S41 fix: Track redirect chain to detect loops
    const redirectChain = [];
    const MAX_REDIRECTS = 10; // More conservative than browser's default 20

    // ── EXT-X-BYTERANGE support (RFC 8216 §4.3.2.2) ──
    // When the HLS playlist uses byte-range addressing, add a Range header
    // so we fetch only the required slice instead of the entire resource.
    if (task.options.byteRange) {
      const { offset, length } = task.options.byteRange;
      headers["Range"] = `bytes=${offset}-${offset + length - 1}`;
    }

    while (true) {
      if (this._aborted) throw new Error("Pool aborted");

      // Respect global pause and spacing
      await this._waitForGlobalPause();
      await this._enforceSpacing();

      if (this._aborted) throw new Error("Pool aborted");

      let controller, timer;
      try {
        controller = new AbortController();
        this._inflightControllers.add(controller);
        timer = setTimeout(() => controller.abort(), timeout);

        // S35 fix: Use refreshed URL if available (YouTube URL expiry)
        let fetchUrl = this._urlMap.get(task.url) || task.url;

        // S41 fix: Manual redirect handling to detect loops
        let resp;
        let redirectCount = 0;

        while (redirectCount <= MAX_REDIRECTS) {
          try {
            resp = await fetch(fetchUrl, {
              headers,
              signal: controller.signal,
              cache: "no-cache",
              redirect: "manual", // S41: Handle redirects manually
            });
          } finally {
            // Cleanup handled below
          }

          // S41: Check for redirect responses (3xx status codes)
          if (resp.status >= 300 && resp.status < 400) {
            const location = resp.headers.get("Location");
            if (!location) {
              throw new Error(
                `Segment ${task.index}: HTTP ${resp.status} redirect with no Location header`,
              );
            }

            // Resolve relative URLs
            const redirectUrl = new URL(location, fetchUrl).toString();

            // S41: Detect redirect loops by checking if we've seen this URL before
            if (redirectChain.includes(redirectUrl)) {
              const loopStart = redirectChain.indexOf(redirectUrl);
              const loop = redirectChain.slice(loopStart).concat(redirectUrl);
              console.error(
                `[SegmentPool] Redirect loop detected for segment ${task.index}: ${loop.join(" → ")}`,
              );
              throw new Error(
                `Segment ${task.index}: Redirect loop detected (${redirectChain.length} redirects). CDN configuration error.`,
              );
            }

            redirectChain.push(fetchUrl);
            redirectCount++;

            if (redirectCount > MAX_REDIRECTS) {
              throw new Error(
                `Segment ${task.index}: Too many redirects (${redirectCount}). Chain: ${redirectChain.slice(0, 3).join(" → ")} ...`,
              );
            }

            console.log(
              `[SegmentPool] Seg ${task.index}: Redirect ${redirectCount}/${MAX_REDIRECTS} to ${redirectUrl}`,
            );

            fetchUrl = redirectUrl;
            continue; // Follow the redirect
          }

          // Not a redirect — break out of redirect loop
          break;
        }

        this._inflightControllers.delete(controller);
        clearTimeout(timer);

        if (!resp.ok) {
          // ──── HTTP 429 Too Many Requests ────
          if (resp.status === 429) {
            task.rateRetries++;
            if (task.rateRetries > maxRateRetries) {
              throw new Error(
                `Segment ${task.index}: HTTP 429 after ${task.rateRetries} rate-limit retries`,
              );
            }

            const retryAfterMs = this._parseRetryAfter(resp);
            this._throttleOnRateLimit(retryAfterMs);

            // Use Retry-After if available, otherwise exponential backoff
            const delay =
              retryAfterMs > 0
                ? retryAfterMs + Math.floor(Math.random() * 1000)
                : this._backoff(
                    task.rateRetries - 1,
                    this._rateBackoffBaseMs,
                    this._rateBackoffCapMs,
                  );

            console.warn(
              `[SegmentPool] Seg ${task.index}: 429, retry ${task.rateRetries}/${maxRateRetries}, wait ${delay}ms` +
                (retryAfterMs > 0 ? ` (Retry-After: ${retryAfterMs}ms)` : ""),
            );
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }

          // ──── 5xx Server Errors ────
          if (resp.status >= 500) {
            task.retries++;
            if (task.retries > this.maxRetries) {
              throw new Error(
                `Segment ${task.index}: HTTP ${resp.status} after ${task.retries} retries`,
              );
            }
            const delay = this._backoff(
              task.retries - 1,
              this._errorBackoffBaseMs,
              this._errorBackoffCapMs,
            );
            console.warn(
              `[SegmentPool] Seg ${task.index}: ${resp.status}, retry ${task.retries}/${this.maxRetries}, wait ${delay}ms`,
            );
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }

          // ──── 403 Forbidden — retry once (may be expired token) ────
          if (resp.status === 403 && task.retries < 1) {
            task.retries++;

            // S46 fix: Track 403s for VPN disconnect detection
            const now = Date.now();
            this._recent403Timestamps.push(now);
            // Keep only recent 403s within detection window
            this._recent403Timestamps = this._recent403Timestamps.filter(
              (ts) => now - ts < this._vpnDisconnectWindow,
            );

            // If we get multiple 403s across different segments rapidly, likely IP changed (VPN disconnect)
            if (
              this._recent403Timestamps.length >= this._vpnDisconnectThreshold
            ) {
              console.error(
                `[SegmentPool] Detected ${this._recent403Timestamps.length} 403s in ${this._vpnDisconnectWindow / 1000}s — possible VPN disconnect or IP change`,
              );
              throw new Error(
                `Multiple 403 Forbidden errors detected. This usually means your IP address changed (VPN disconnect or network switch). Please reconnect your VPN and restart the download.`,
              );
            }

            const delay = 1000 + Math.floor(Math.random() * 1000);
            console.warn(
              `[SegmentPool] Seg ${task.index}: 403, retry once after ${delay}ms`,
            );
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }

          // S35 fix: Detect YouTube URL expiry (persistent 403 on googlevideo.com)
          if (resp.status === 403 && /googlevideo\.com/.test(task.url)) {
            this._consecutive403++;
            if (
              this._consecutive403 >= 3 &&
              this._onUrlRefreshNeeded &&
              !this._urlRefreshInProgress
            ) {
              console.warn(
                `[SegmentPool] Multiple 403s on YouTube URLs — requesting URL refresh`,
              );
              this._urlRefreshInProgress = true;
              try {
                const freshUrls = await this._onUrlRefreshNeeded();
                if (freshUrls && typeof freshUrls === "object") {
                  this.updateUrls(freshUrls);
                  console.log(
                    `[SegmentPool] URLs refreshed, retrying segment ${task.index}`,
                  );
                  // Reset 403 counter and retry with fresh URL
                  this._consecutive403 = 0;
                  continue;
                }
              } catch (e) {
                console.error(`[SegmentPool] URL refresh failed: ${e.message}`);
              } finally {
                this._urlRefreshInProgress = false;
              }
            }
          }

          // S40 fix: Handle 451 (Unavailable For Legal Reasons) — no retries
          // This typically means geo-blocking or region change (WiFi/VPN switch)
          if (resp.status === 451) {
            throw new Error(
              `Segment ${task.index}: HTTP 451 Unavailable For Legal Reasons (geo-blocked or network change detected)`,
            );
          }

          // S52 fix: Handle 404 (Not Found) — Content removal detection
          if (resp.status === 404) {
            const now = Date.now();
            this._recent404Timestamps.push(now);
            // Keep only recent 404s within detection window
            this._recent404Timestamps = this._recent404Timestamps.filter(
              (ts) => now - ts < this._404BurstWindow,
            );

            const completed = this._completedCount;
            const total = this._segmentCount > 0 ? this._segmentCount : 9999;

            // Early 404s (first 3 segments) = video was removed/never existed
            if (completed < 3) {
              console.error(
                `[SegmentPool] HTTP 404 on segment ${task.index} (early download) — video likely removed or unavailable`,
              );
              throw new Error(
                `Video not found (HTTP 404). The video may have been removed due to copyright claim, privacy settings, or account deletion. Segment ${task.index} returned 404 Not Found.`,
              );
            }

            // Burst of 404s mid-download = video removed during download (DMCA takedown)
            if (
              this._recent404Timestamps.length >= this._404BurstThreshold &&
              completed >= 3
            ) {
              console.error(
                `[SegmentPool] Detected ${this._recent404Timestamps.length} 404s in ${this._404BurstWindow / 1000}s after downloading ${completed} segments — video likely removed mid-download`,
              );
              throw new Error(
                `Video removed during download (DMCA/copyright claim). Successfully downloaded ${completed}/${total} segments before removal. The video was taken down by the content owner or platform.`,
              );
            }

            // Late-download occasional 404 on a single segment — may be CDN cache miss
            // Retry once with exponential backoff (some CDNs return 404 for segments still encoding)
            if (task.retries < 1) {
              task.retries++;
              const delay = 2000 + Math.floor(Math.random() * 1000);
              console.warn(
                `[SegmentPool] Seg ${task.index}: 404 (${completed}/${total} completed), retry once after ${delay}ms (CDN cache miss?)`,
              );
              await new Promise((r) => setTimeout(r, delay));
              continue;
            }

            // Multiple retries on same 404 = permanent failure
            console.error(
              `[SegmentPool] Seg ${task.index}: Permanent 404 after retry`,
            );
            throw new Error(
              `Segment ${task.index}: Permanent 404 Not Found (video segment unavailable after retry)`,
            );
          }

          throw new Error(`Segment ${task.index}: HTTP ${resp.status}`);
        }

        // ──── Ad-server header detection (IDM technique) ────
        if (this._validateContent) {
          const adSig = this._isAdServerResponse(resp);
          if (adSig) {
            this._adBlockedCount++;
            adRetries++;
            if (adRetries > this._maxAdRetries) {
              throw new Error(
                `Segment ${task.index}: Ad server detected (${adSig}) after ${adRetries} retries`,
              );
            }
            console.warn(
              `[SegmentPool] Seg ${task.index}: Ad server "${adSig}" detected, retry ${adRetries}/${this._maxAdRetries}`,
            );
            const delay = 1500 + Math.floor(Math.random() * 1500);
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }

          // ──── Content-Type validation ────
          const badCT = this._isInvalidContentType(resp);
          if (badCT) {
            this._adBlockedCount++;
            adRetries++;
            if (adRetries > this._maxAdRetries) {
              throw new Error(
                `Segment ${task.index}: Invalid content-type "${badCT}" after ${adRetries} retries`,
              );
            }
            console.warn(
              `[SegmentPool] Seg ${task.index}: Invalid content-type "${badCT}", retry ${adRetries}/${this._maxAdRetries}`,
            );
            const delay = 1000 + Math.floor(Math.random() * 1000);
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }
        }

        // ──── Success — download body ────
        const buffer = await resp.arrayBuffer();
        const data = new Uint8Array(buffer);

        // ──── Segment data validation (magic bytes) ────
        if (this._validateContent) {
          const validation = this._validateSegmentData(data);
          if (!validation.valid) {
            this._adBlockedCount++;
            adRetries++;
            if (adRetries > this._maxAdRetries) {
              throw new Error(
                `Segment ${task.index}: ${validation.detail} after ${adRetries} retries`,
              );
            }
            console.warn(
              `[SegmentPool] Seg ${task.index}: ${validation.reason} — ${validation.detail}, retry ${adRetries}/${this._maxAdRetries}`,
            );
            const delay = 1500 + Math.floor(Math.random() * 1500);
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }
        }

        return data;
      } catch (err) {
        // Always clean up controller and timer on error before retry
        if (controller) this._inflightControllers.delete(controller);
        if (timer) clearTimeout(timer);

        if (this._aborted) throw new Error("Pool aborted");

        // Timeout (AbortError)
        if (err.name === "AbortError" || err.message.includes("aborted")) {
          task.retries++;
          if (task.retries > this.maxRetries) {
            throw new Error(
              `Segment ${task.index}: Timeout after ${task.retries} retries`,
            );
          }
          const delay = this._backoff(
            task.retries - 1,
            this._errorBackoffBaseMs,
            this._errorBackoffCapMs,
          );
          console.warn(
            `[SegmentPool] Seg ${task.index}: Timeout, retry ${task.retries}/${this.maxRetries}, wait ${delay}ms`,
          );
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }

        // Network error
        task.retries++;
        if (task.retries > this.maxRetries) {
          throw err;
        }
        const delay = this._backoff(
          task.retries - 1,
          this._errorBackoffBaseMs,
          this._errorBackoffCapMs,
        );
        console.warn(
          `[SegmentPool] Seg ${task.index}: ${err.message}, retry ${task.retries}/${this.maxRetries}, wait ${delay}ms`,
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  // ───────────────── Lifecycle ─────────────────

  /**
   * S35 fix: Update URLs after refresh (e.g., YouTube format URL expiry).
   * Accepts a map of {oldUrl: newUrl} and updates pending tasks in the queue.
   * @param {Object} urlMap - Object mapping old URLs to new URLs
   */
  updateUrls(urlMap) {
    if (!urlMap || typeof urlMap !== "object") return;

    // Store URL mappings for future segment fetches
    for (const [oldUrl, newUrl] of Object.entries(urlMap)) {
      this._urlMap.set(oldUrl, newUrl);
    }

    // Update URLs for queued tasks that haven't started yet
    for (const task of this._queue) {
      const freshUrl = this._urlMap.get(task.url);
      if (freshUrl) {
        console.log(`[SegmentPool] Updated queued segment ${task.index} URL`);
        task.url = freshUrl;
      }
    }

    console.log(
      `[SegmentPool] URL refresh applied to ${this._urlMap.size} URLs`,
    );
  }

  cancel() {
    this._aborted = true;
    // S27 fix: abort all in-flight fetch requests immediately so cancel
    // doesn't have to wait up to SEGMENT_TIMEOUT (30s) per stuck fetch.
    for (const ctrl of this._inflightControllers) {
      try {
        ctrl.abort();
      } catch {}
    }
    this._inflightControllers.clear();
    for (const task of this._queue) {
      task.reject(new Error("Pool cancelled"));
    }
    this._queue = [];
  }

  reset() {
    this.cancel();
    this._aborted = false;
    this._active = 0;
    this._consecutive429 = 0;
    this._consecutive403 = 0;
    this._successesSinceThrottle = 0;
    this._globalPauseUntil = 0;
    this._completedCount = 0;
    this._failedCount = 0;
    this._adBlockedCount = 0;
    this._inflightControllers.clear();
    this._recent403Timestamps = [];
    this._recent404Timestamps = [];
    this.concurrency = this._originalConcurrency;
  }
}
