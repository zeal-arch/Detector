/**
 * manifest-parser.js — DASH MPD + HLS M3U8 + MSS Manifest Parser
 * ================================================================
 * Educational implementation of streaming manifest parsers.
 *
 * DASH (Dynamic Adaptive Streaming over HTTP):
 *   - XML-based manifest (.mpd)
 *   - ContentProtection elements contain PSSH data
 *   - SegmentTemplate/SegmentList define segment URLs
 *
 * HLS (HTTP Live Streaming):
 *   - Text-based playlist (.m3u8)
 *   - EXT-X-KEY defines encryption (AES-128 / SAMPLE-AES)
 *   - EXT-X-SESSION-KEY for Widevine/PlayReady PSSH
 *   - EXT-X-MAP for initialization segments
 *
 * MSS (Microsoft Smooth Streaming):
 *   - XML-based manifest (.ism/manifest)
 *   - ProtectionHeader elements contain PRO/PSSH
 */

// eslint-disable-next-line no-unused-vars
var ManifestParser = (function () {
  "use strict";

  // ─── DASH MPD Parser ─────────────────────────────────────────────

  const WIDEVINE_SYSTEM_ID = "edef8ba9-79d6-4ace-a3c8-27dcd51d21ed";
  const PLAYREADY_SYSTEM_ID = "9a04f079-9840-4286-ab92-e65be0885f95";
  const CLEARKEY_SYSTEM_ID = "1077efec-c0b2-4d02-ace3-3c1e52e2fb4b";

  /**
   * Parse a DASH MPD (Media Presentation Description) manifest.
   *
   * Returns:
   * {
   *   type: "dash",
   *   duration: "PT2H30M",
   *   baseUrl: "...",
   *   periods: [{
   *     adaptationSets: [{
   *       contentType: "video" | "audio" | ...
   *       mimeType: "video/mp4",
   *       representations: [{
   *         id, bandwidth, width, height, codecs,
   *         segmentTemplate: { ... },
   *         segmentList: { ... },
   *         baseUrl: "..."
   *       }],
   *       contentProtection: [{
   *         schemeIdUri, systemId, pssh (base64), defaultKID
   *       }]
   *     }]
   *   }]
   * }
   */
  function parseMPD(xmlText, baseUrl = "") {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, "application/xml");
    const mpd = doc.querySelector("MPD");
    if (!mpd) throw new Error("Invalid MPD: no MPD element");

    const result = {
      type: "dash",
      duration: mpd.getAttribute("mediaPresentationDuration") || "",
      minBufferTime: mpd.getAttribute("minBufferTime") || "",
      baseUrl: getBaseUrl(mpd) || baseUrl,
      periods: [],
    };

    const periods = mpd.querySelectorAll("Period");
    for (const period of periods) {
      const periodObj = {
        id: period.getAttribute("id") || "",
        duration: period.getAttribute("duration") || "",
        adaptationSets: [],
      };

      const periodBaseUrl = getBaseUrl(period) || result.baseUrl;
      const adaptationSets = period.querySelectorAll("AdaptationSet");

      for (const as of adaptationSets) {
        const asObj = parseAdaptationSet(as, periodBaseUrl);
        periodObj.adaptationSets.push(asObj);
      }

      result.periods.push(periodObj);
    }

    return result;
  }

  function parseAdaptationSet(as, parentBaseUrl) {
    const contentType =
      as.getAttribute("contentType") ||
      (as.getAttribute("mimeType") || "").split("/")[0] ||
      "";

    const asObj = {
      id: as.getAttribute("id") || "",
      contentType,
      mimeType: as.getAttribute("mimeType") || "",
      codecs: as.getAttribute("codecs") || "",
      lang: as.getAttribute("lang") || "",
      baseUrl: getBaseUrl(as) || parentBaseUrl,
      contentProtection: [],
      representations: [],
    };

    // Parse ContentProtection elements (PSSH / KID extraction)
    const cpElements = as.querySelectorAll("ContentProtection");
    for (const cp of cpElements) {
      const cpObj = parseContentProtection(cp);
      if (cpObj) asObj.contentProtection.push(cpObj);
    }

    // Parse SegmentTemplate at AdaptationSet level (inherited by representations)
    const asSegTemplate = parseSegmentTemplate(
      as.querySelector(":scope > SegmentTemplate"),
    );

    // Parse Representations
    const reps = as.querySelectorAll("Representation");
    for (const rep of reps) {
      const repObj = parseRepresentation(rep, asObj, asSegTemplate);
      asObj.representations.push(repObj);
    }

    return asObj;
  }

  function parseContentProtection(cp) {
    const schemeIdUri = cp.getAttribute("schemeIdUri") || "";
    const defaultKID =
      cp.getAttribute("cenc:default_KID") ||
      cp.getAttribute("default_KID") ||
      "";

    // Look for PSSH in child elements
    let pssh = "";
    const psshEl = cp.querySelector("pssh") || cp.querySelector("cenc\\:pssh");
    if (psshEl) {
      pssh = (psshEl.textContent || "").trim();
    }

    // Determine system ID
    let systemId = "";
    const uri = schemeIdUri.toLowerCase();
    if (uri.includes("edef8ba9")) systemId = WIDEVINE_SYSTEM_ID;
    else if (uri.includes("9a04f079")) systemId = PLAYREADY_SYSTEM_ID;
    else if (uri.includes("1077efec")) systemId = CLEARKEY_SYSTEM_ID;
    else if (uri === "urn:mpeg:dash:mp4protection:2011")
      systemId = "mp4protection";
    else systemId = uri.replace("urn:uuid:", "");

    return {
      schemeIdUri,
      systemId,
      defaultKID: defaultKID.replace(/-/g, ""),
      pssh,
    };
  }

  function parseSegmentTemplate(el) {
    if (!el) return null;
    return {
      initialization: el.getAttribute("initialization") || "",
      media: el.getAttribute("media") || "",
      timescale: parseInt(el.getAttribute("timescale") || "1", 10),
      duration: parseInt(el.getAttribute("duration") || "0", 10),
      startNumber: parseInt(el.getAttribute("startNumber") || "1", 10),
      timeline: parseSegmentTimeline(el.querySelector("SegmentTimeline")),
    };
  }

  function parseSegmentTimeline(el) {
    if (!el) return null;
    const segments = [];
    const entries = el.querySelectorAll("S");
    for (const s of entries) {
      segments.push({
        t: parseInt(s.getAttribute("t") || "0", 10),
        d: parseInt(s.getAttribute("d") || "0", 10),
        r: parseInt(s.getAttribute("r") || "0", 10),
      });
    }
    return segments;
  }

  function parseRepresentation(rep, asObj, inheritedSegTemplate) {
    const repObj = {
      id: rep.getAttribute("id") || "",
      bandwidth: parseInt(rep.getAttribute("bandwidth") || "0", 10),
      width: parseInt(rep.getAttribute("width") || "0", 10),
      height: parseInt(rep.getAttribute("height") || "0", 10),
      codecs: rep.getAttribute("codecs") || asObj.codecs,
      mimeType: rep.getAttribute("mimeType") || asObj.mimeType,
      baseUrl: getBaseUrl(rep) || asObj.baseUrl,
    };

    // SegmentTemplate at Representation level overrides AdaptationSet level
    const repSegTemplate = parseSegmentTemplate(
      rep.querySelector(":scope > SegmentTemplate"),
    );
    repObj.segmentTemplate = repSegTemplate || inheritedSegTemplate;

    // SegmentList
    repObj.segmentList = parseSegmentList(rep.querySelector("SegmentList"));

    // ContentProtection (can also be at Representation level)
    repObj.contentProtection = [];
    const cpElements = rep.querySelectorAll("ContentProtection");
    for (const cp of cpElements) {
      const cpObj = parseContentProtection(cp);
      if (cpObj) repObj.contentProtection.push(cpObj);
    }

    return repObj;
  }

  function parseSegmentList(el) {
    if (!el) return null;
    const initUrl = el.querySelector("Initialization");
    const segments = [];
    const segUrls = el.querySelectorAll("SegmentURL");
    for (const s of segUrls) {
      segments.push({
        media: s.getAttribute("media") || s.getAttribute("mediaURL") || "",
        mediaRange: s.getAttribute("mediaRange") || "",
      });
    }
    return {
      initialization: initUrl ? initUrl.getAttribute("sourceURL") || "" : "",
      segments,
    };
  }

  function getBaseUrl(el) {
    const bu = el.querySelector(":scope > BaseURL");
    return bu ? (bu.textContent || "").trim() : "";
  }

  /**
   * Generate segment URLs from a DASH MPD representation.
   */
  function generateSegmentUrls(representation, baseUrl) {
    const st = representation.segmentTemplate;
    const sl = representation.segmentList;
    const repBase = representation.baseUrl || baseUrl;

    const urls = { init: null, segments: [] };

    if (st) {
      // SegmentTemplate-based
      if (st.initialization) {
        urls.init = resolveTemplate(st.initialization, representation, 0, 0);
      }

      if (st.timeline) {
        // SegmentTimeline
        let time = 0;
        let number = st.startNumber;
        for (const entry of st.timeline) {
          if (entry.t) time = entry.t;
          const repeat = entry.r >= 0 ? entry.r : 0;
          for (let i = 0; i <= repeat; i++) {
            const url = resolveTemplate(st.media, representation, number, time);
            urls.segments.push({ url, time, duration: entry.d });
            time += entry.d;
            number++;
          }
        }
      } else if (st.duration > 0) {
        // Number-based (duration / timescale = segment duration)
        // Caller needs total duration to calculate segment count
        urls.segmentDuration = st.duration / st.timescale;
        urls.mediaTemplate = st.media;
        urls.startNumber = st.startNumber;
      }
    } else if (sl) {
      // SegmentList-based
      urls.init = sl.initialization || null;
      for (const seg of sl.segments) {
        urls.segments.push({ url: seg.media, range: seg.mediaRange });
      }
    } else if (representation.baseUrl) {
      // Single-segment representation
      urls.segments.push({ url: representation.baseUrl });
    }

    // Resolve relative URLs
    if (urls.init && !urls.init.startsWith("http")) {
      urls.init = resolveUrl(repBase, urls.init);
    }
    for (const seg of urls.segments) {
      if (seg.url && !seg.url.startsWith("http")) {
        seg.url = resolveUrl(repBase, seg.url);
      }
    }

    return urls;
  }

  function resolveTemplate(template, rep, number, time) {
    return template
      .replace(/\$RepresentationID\$/g, rep.id)
      .replace(/\$Bandwidth\$/g, rep.bandwidth)
      .replace(/\$Number\$/g, number)
      .replace(/\$Number%(\d+)d\$/g, (_, w) =>
        String(number).padStart(parseInt(w), "0"),
      )
      .replace(/\$Time\$/g, time);
  }

  // ─── HLS M3U8 Parser ────────────────────────────────────────────

  /**
   * Parse an HLS M3U8 playlist.
   *
   * Returns:
   * {
   *   type: "hls",
   *   isMaster: true/false,
   *   variants: [{ bandwidth, resolution, codecs, uri }],      // master
   *   segments: [{ uri, duration, title }],                      // media
   *   keys: [{ method, uri, iv, keyformat }],
   *   map: { uri, byterange },
   *   sessionKeys: [{ method, uri, keyformat, keyformatversions }]
   * }
   */
  function parseM3U8(text, baseUrl = "") {
    const lines = text.split(/\r?\n/);
    const result = {
      type: "hls",
      isMaster: false,
      variants: [],
      segments: [],
      keys: [],
      sessionKeys: [],
      map: null,
      totalDuration: 0,
    };

    let currentSegmentDuration = 0;
    let currentSegmentTitle = "";
    let pendingVariant = null;
    let currentByteRange = null; // EXT-X-BYTERANGE support

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.startsWith("#EXT-X-STREAM-INF:")) {
        result.isMaster = true;
        const attrs = parseAttributes(line.substring(18));
        pendingVariant = {
          bandwidth: parseInt(attrs.BANDWIDTH || "0", 10),
          resolution: attrs.RESOLUTION || "",
          codecs: attrs.CODECS || "",
          audio: attrs.AUDIO || "",
          uri: "", // next line
        };
      } else if (pendingVariant && !line.startsWith("#") && line.length > 0) {
        pendingVariant.uri = resolveUrl(baseUrl, line);
        result.variants.push(pendingVariant);
        pendingVariant = null;
      } else if (line.startsWith("#EXT-X-KEY:")) {
        const attrs = parseAttributes(line.substring(11));
        result.keys.push({
          method: attrs.METHOD || "",
          uri: attrs.URI ? resolveUrl(baseUrl, attrs.URI) : "",
          iv: attrs.IV || "",
          keyformat: attrs.KEYFORMAT || "",
          keyformatversions: attrs.KEYFORMATVERSIONS || "",
        });
      } else if (line.startsWith("#EXT-X-SESSION-KEY:")) {
        const attrs = parseAttributes(line.substring(19));
        result.sessionKeys.push({
          method: attrs.METHOD || "",
          uri: attrs.URI || "",
          keyformat: attrs.KEYFORMAT || "",
          keyformatversions: attrs.KEYFORMATVERSIONS || "",
        });
      } else if (line.startsWith("#EXT-X-MAP:")) {
        const attrs = parseAttributes(line.substring(11));
        result.map = {
          uri: resolveUrl(baseUrl, attrs.URI || ""),
          byterange: attrs.BYTERANGE || "",
        };
      } else if (line.startsWith("#EXT-X-BYTERANGE:")) {
        // EXT-X-BYTERANGE:length[@offset]
        currentByteRange = line.substring(17).trim();
      } else if (line.startsWith("#EXTINF:")) {
        const match = line.match(/#EXTINF:([\d.]+)/);
        currentSegmentDuration = match ? parseFloat(match[1]) : 0;
        const commaIdx = line.indexOf(",");
        currentSegmentTitle = commaIdx >= 0 ? line.substring(commaIdx + 1) : "";
      } else if (!line.startsWith("#") && line.length > 0) {
        if (currentSegmentDuration > 0 || !result.isMaster) {
          result.segments.push({
            uri: resolveUrl(baseUrl, line),
            duration: currentSegmentDuration,
            title: currentSegmentTitle,
            byterange: currentByteRange || "",
          });
          result.totalDuration += currentSegmentDuration;
          currentSegmentDuration = 0;
          currentSegmentTitle = "";
          currentByteRange = null;
        }
      }
    }

    return result;
  }

  /**
   * Extract PSSH from HLS session keys.
   * Widevine PSSH is delivered as a URI like:
   *   data:text/plain;base64,<PSSH_BOX_BASE64>
   * Or in EXT-X-KEY with KEYFORMAT="urn:uuid:edef8ba9-..."
   */
  function extractHlsPssh(parsed) {
    const psshList = [];

    const allKeys = [...parsed.keys, ...parsed.sessionKeys];
    for (const key of allKeys) {
      if (key.keyformat && key.keyformat.toLowerCase().includes("edef8ba9")) {
        // Widevine key
        let psshB64 = "";
        if (key.uri.startsWith("data:")) {
          const base64Idx = key.uri.indexOf("base64,");
          if (base64Idx >= 0) {
            psshB64 = key.uri.substring(base64Idx + 7);
          }
        } else {
          psshB64 = key.uri;
        }
        if (psshB64) {
          psshList.push({
            systemId: WIDEVINE_SYSTEM_ID,
            psshB64,
            source: "hls-key",
          });
        }
      }
    }

    return psshList;
  }

  // ─── MSS (Smooth Streaming) Parser ──────────────────────────────

  /**
   * Parse a Microsoft Smooth Streaming manifest.
   */
  function parseSmoothStreaming(xmlText, baseUrl = "") {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, "application/xml");
    const ss = doc.querySelector("SmoothStreamingMedia");
    if (!ss) throw new Error("Invalid MSS manifest");

    const result = {
      type: "mss",
      duration: parseInt(ss.getAttribute("Duration") || "0", 10) / 10000000,
      timescale: parseInt(ss.getAttribute("TimeScale") || "10000000", 10),
      streams: [],
      protection: [],
    };

    // ProtectionHeader elements
    const protHeaders = doc.querySelectorAll("Protection > ProtectionHeader");
    for (const ph of protHeaders) {
      const systemId = (ph.getAttribute("SystemID") || "")
        .replace(/[{}]/g, "")
        .toLowerCase();
      const b64Data = (ph.textContent || "").trim();
      result.protection.push({ systemId, data: b64Data });
    }

    // Stream indexes
    const streamIndexes = doc.querySelectorAll("StreamIndex");
    for (const si of streamIndexes) {
      const stream = {
        type: si.getAttribute("Type") || "",
        name: si.getAttribute("Name") || "",
        qualityLevels: [],
        chunks: [],
      };

      const qls = si.querySelectorAll("QualityLevel");
      for (const ql of qls) {
        stream.qualityLevels.push({
          index: parseInt(ql.getAttribute("Index") || "0", 10),
          bitrate: parseInt(ql.getAttribute("Bitrate") || "0", 10),
          fourCC: ql.getAttribute("FourCC") || "",
          width: parseInt(ql.getAttribute("MaxWidth") || "0", 10),
          height: parseInt(ql.getAttribute("MaxHeight") || "0", 10),
          codecPrivateData: ql.getAttribute("CodecPrivateData") || "",
        });
      }

      const chunks = si.querySelectorAll("c");
      let time = 0;
      for (const c of chunks) {
        const t = c.getAttribute("t");
        if (t) time = parseInt(t, 10);
        const d = parseInt(c.getAttribute("d") || "0", 10);
        const r = parseInt(c.getAttribute("r") || "1", 10);
        for (let i = 0; i < r; i++) {
          stream.chunks.push({ time, duration: d });
          time += d;
        }
      }

      result.streams.push(stream);
    }

    return result;
  }

  // ─── Content Type Detection ──────────────────────────────────────

  /**
   * Detect manifest type from content or URL.
   */
  function detectManifestType(content, url) {
    const lowerUrl = (url || "").toLowerCase();

    // URL-based detection
    if (lowerUrl.includes(".mpd")) return "dash";
    if (lowerUrl.includes(".m3u8")) return "hls";
    if (lowerUrl.includes(".ism") || lowerUrl.includes("manifest"))
      return "mss";

    // Content-based detection
    const trimmed = content.trim();
    if (trimmed.startsWith("#EXTM3U")) return "hls";
    if (trimmed.startsWith("<?xml") || trimmed.startsWith("<MPD"))
      return trimmed.includes("SmoothStreamingMedia") ? "mss" : "dash";
    if (trimmed.includes("<SmoothStreamingMedia")) return "mss";

    return "unknown";
  }

  /**
   * Parse any manifest automatically.
   */
  function parseManifest(content, url, baseUrl) {
    const type = detectManifestType(content, url);
    const effectiveBase =
      baseUrl ||
      (url ? url.replace(/[?#].*$/, "").replace(/\/[^/]*$/, "/") : "");

    switch (type) {
      case "dash":
        return parseMPD(content, effectiveBase);
      case "hls":
        return parseM3U8(content, effectiveBase);
      case "mss":
        return parseSmoothStreaming(content, effectiveBase);
      default:
        return null;
    }
  }

  /**
   * Extract all PSSH data from a parsed manifest.
   */
  function extractPsshFromManifest(parsed) {
    const psshList = [];

    if (parsed.type === "dash") {
      for (const period of parsed.periods) {
        for (const as of period.adaptationSets) {
          for (const cp of as.contentProtection) {
            if (cp.pssh) {
              psshList.push({
                systemId: cp.systemId,
                defaultKID: cp.defaultKID,
                psshB64: cp.pssh,
                source: "dash-mpd",
              });
            }
          }
        }
      }
    } else if (parsed.type === "hls") {
      psshList.push(...extractHlsPssh(parsed));
    } else if (parsed.type === "mss") {
      for (const prot of parsed.protection) {
        psshList.push({
          systemId: prot.systemId,
          data: prot.data,
          source: "mss-protection",
        });
      }
    }

    return psshList;
  }

  // ─── Utility ─────────────────────────────────────────────────────

  function parseAttributes(str) {
    const attrs = {};
    // Match KEY=VALUE or KEY="VALUE" pairs
    const regex = /([A-Z0-9_-]+)\s*=\s*(?:"([^"]*)"|([^,\s]*))/gi;
    let match;
    while ((match = regex.exec(str)) !== null) {
      attrs[match[1].toUpperCase()] =
        match[2] !== undefined ? match[2] : match[3];
    }
    return attrs;
  }

  function resolveUrl(base, relative) {
    if (!relative) return base;
    if (relative.startsWith("http://") || relative.startsWith("https://")) {
      return relative;
    }
    if (relative.startsWith("//")) {
      const protocol = base.match(/^(https?:)/);
      return (protocol ? protocol[1] : "https:") + relative;
    }
    if (relative.startsWith("/")) {
      const origin = base.match(/^(https?:\/\/[^/]+)/);
      return (origin ? origin[1] : "") + relative;
    }
    // Relative path
    const baseDir = base.replace(/[?#].*$/, "").replace(/\/[^/]*$/, "/");
    return baseDir + relative;
  }

  // ─── Public API ──────────────────────────────────────────────────

  return {
    // DASH
    parseMPD,
    generateSegmentUrls,
    // HLS
    parseM3U8,
    extractHlsPssh,
    // MSS
    parseSmoothStreaming,
    // Generic
    detectManifestType,
    parseManifest,
    extractPsshFromManifest,
    resolveUrl,
    // Constants
    WIDEVINE_SYSTEM_ID,
    PLAYREADY_SYSTEM_ID,
    CLEARKEY_SYSTEM_ID,
  };
})();
