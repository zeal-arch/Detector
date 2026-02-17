/**
 * DRM Detection Utility for Video Streams
 * Detects various DRM protection schemes in video manifests and streams
 */

class DRMDetection {
  /**
   * Detect DRM in HLS (M3U8) manifest content
   * @param {string} manifest - The M3U8 manifest content
   * @returns {boolean} - True if DRM is detected
   */
  static detectHLS(manifest) {
    if (!manifest || typeof manifest !== "string") return false;

    // yt-dlp style DRM detection patterns
    const drmPatterns = [
      // Apple FairPlay
      /#EXT-X-(?:SESSION-)?KEY:.*?URI="skd:\/\//,
      /#EXT-X-(?:SESSION-)?KEY:.*?KEYFORMAT="com\.apple\.streamingkeydelivery"/,
      // Microsoft PlayReady
      /#EXT-X-(?:SESSION-)?KEY:.*?KEYFORMAT="com\.microsoft\.playready"/,
      // Adobe Flash Access
      /#EXT-X-FAXS-CM:/,
      // Widevine (generic)
      /#EXT-X-(?:SESSION-)?KEY:.*?KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/,
      // PlayReady (alternative)
      /#EXT-X-(?:SESSION-)?KEY:.*?KEYFORMAT="urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95"/,
      // FairPlay (alternative)
      /#EXT-X-(?:SESSION-)?KEY:.*?KEYFORMAT="urn:uuid:94ce86fb-07bb-4b99-9ad1-faa2c2f86ce"/,
    ];

    return drmPatterns.some((pattern) => pattern.test(manifest));
  }

  /**
   * Detect DRM in DASH (MPD) manifest content
   * @param {string} manifest - The MPD manifest content
   * @returns {boolean} - True if DRM is detected
   */
  static detectDASH(manifest) {
    if (!manifest || typeof manifest !== "string") return false;

    // Check for ContentProtection elements
    const contentProtectionPattern = /<ContentProtection[^>]*>/i;
    return contentProtectionPattern.test(manifest);
  }

  /**
   * Detect DRM in format objects (from extractors)
   * @param {Array} formats - Array of format objects
   * @returns {boolean} - True if any format has DRM
   */
  static detectInFormats(formats) {
    if (!Array.isArray(formats)) return false;

    return formats.some((format) => {
      // Check for explicit DRM flags
      if (format.has_drm === true) return true;
      if (format.drm === true) return true;

      // Check URL patterns that indicate DRM
      if (format.url) {
        const drmUrlPatterns = [
          /[?&]drm=/,
          /[?&]widevine=/,
          /[?&]playready=/,
          /[?&]fairplay=/,
        ];
        if (drmUrlPatterns.some((pattern) => pattern.test(format.url)))
          return true;
      }

      // Check for DRM-related format notes
      if (format.format_note) {
        const drmNotes = [
          /drm/i,
          /protected/i,
          /encrypted/i,
          /widevine/i,
          /playready/i,
          /fairplay/i,
        ];
        if (drmNotes.some((note) => note.test(format.format_note))) return true;
      }

      return false;
    });
  }

  /**
   * Get DRM type from manifest content
   * @param {string} manifest - Manifest content
   * @param {string} type - 'hls' or 'dash'
   * @returns {string|null} - DRM type or null if none detected
   */
  static getDRMType(manifest, type = "hls") {
    if (!manifest || typeof manifest !== "string") return null;

    if (type === "hls") {
      if (/KEYFORMAT="com\.apple\.streamingkeydelivery"/.test(manifest))
        return "FairPlay";
      if (/KEYFORMAT="com\.microsoft\.playready"/.test(manifest))
        return "PlayReady";
      if (
        /KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/.test(
          manifest,
        )
      )
        return "Widevine";
      if (/URI="skd:\/\//.test(manifest)) return "FairPlay";
      if (/#EXT-X-FAXS-CM:/.test(manifest)) return "Flash Access";
    } else if (type === "dash") {
      if (/<ContentProtection[^>]*>/.test(manifest)) return "DASH DRM";
    }

    return null;
  }

  /**
   * Check if a URL likely contains DRM-protected content
   * @param {string} url - The URL to check
   * @returns {boolean} - True if likely DRM-protected
   */
  static isDRMLikely(url) {
    if (!url || typeof url !== "string") return false;

    const drmIndicators = [
      // Known DRM service domains
      /netflix\.com/,
      /amazon\.com/,
      /hulu\.com/,
      /disney\+/,
      /hbomax\.com/,
      /crave\.ca/,
      /paramount\+/,
      /peacocktv\.com/,
      // DRM-specific URL patterns
      /[?&]drm=/,
      /[?&]widevine=/,
      /[?&]playready=/,
      /[?&]fairplay=/,
      /[?&]license=/,
      // Encrypted stream indicators
      /[?&]encrypted=/,
      /[?&]protection=/,
    ];

    return drmIndicators.some((pattern) => pattern.test(url));
  }

  /**
   * Comprehensive DRM check for video data
   * @param {Object} videoData - Video data object
   * @returns {Object} - DRM detection result
   */
  static checkVideoData(videoData) {
    const result = {
      hasDRM: false,
      drmType: null,
      drmSources: [],
      confidence: "unknown",
    };

    if (!videoData) return result;

    // Check formats
    if (videoData.formats && Array.isArray(videoData.formats)) {
      const formatDRM = this.detectInFormats(videoData.formats);
      if (formatDRM) {
        result.hasDRM = true;
        result.drmSources.push("formats");
        result.confidence = "high";
      }
    }

    // Check manifest URLs
    if (videoData.manifestUrl) {
      if (this.isDRMLikely(videoData.manifestUrl)) {
        result.hasDRM = true;
        result.drmSources.push("manifest_url");
        result.confidence = "medium";
      }
    }

    // Check page URL
    if (videoData.pageUrl) {
      if (this.isDRMLikely(videoData.pageUrl)) {
        result.hasDRM = true;
        result.drmSources.push("page_url");
        result.confidence = "low";
      }
    }

    // Check for manifest content if available
    if (videoData.manifestContent) {
      if (this.detectHLS(videoData.manifestContent)) {
        result.hasDRM = true;
        result.drmType = this.getDRMType(videoData.manifestContent, "hls");
        result.drmSources.push("hls_manifest");
        result.confidence = "high";
      } else if (this.detectDASH(videoData.manifestContent)) {
        result.hasDRM = true;
        result.drmType = this.getDRMType(videoData.manifestContent, "dash");
        result.drmSources.push("dash_manifest");
        result.confidence = "high";
      }
    }

    return result;
  }
}

// Export for use in other modules
if (typeof module !== "undefined" && module.exports) {
  module.exports = DRMDetection;
} else if (typeof globalThis !== "undefined") {
  globalThis.DRMDetection = DRMDetection;
} else if (typeof self !== "undefined") {
  self.DRMDetection = DRMDetection;
} else if (typeof window !== "undefined") {
  window.DRMDetection = DRMDetection;
}
