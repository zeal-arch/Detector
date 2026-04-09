/**
 * remote-cdm.js — Remote CDM API Client
 * ======================================
 * Educational implementation of a Remote Content Decryption Module client.
 *
 * Instead of bundling an entire Widevine CDM implementation (which requires
 * protobuf.js + forge.js + node-widevine + a .wvd device file), we can
 * delegate challenge generation and key extraction to a Remote CDM API.
 *
 * This client speaks the pywidevine Remote CDM API protocol:
 *   POST /open          → { session_id, ... }
 *   POST /get_challenge → { challenge_b64 }
 *   POST /parse_license → { }
 *   POST /get_keys      → [{ kid, key, type }]
 *   POST /close         → { }
 *
 * Compatible with:
 *   - pywidevine serve (https://github.com/devine-dl/pywidevine)
 *   - CDRM-Project API (https://cdrm-project.com/)
 *   - Any pywidevine-compatible Remote CDM endpoint
 *
 *  ┌─────────────┐      ┌──────────────┐      ┌──────────────┐
 *  │  Extension  │ ───► │  Remote CDM  │ ───► │  License     │
 *  │  (Firefox)  │ ◄─── │  API Server  │ ◄─── │  Server      │
 *  └─────────────┘      └──────────────┘      └──────────────┘
 *  Sends PSSH +         Generates challenge   Returns license
 *  license response     with Android L3 CDM   for our CDM device
 */

// eslint-disable-next-line no-unused-vars
var RemoteCDM = (function () {
  "use strict";

  /**
   * RemoteCDM client connected to a pywidevine-compatible API.
   *
   * @param {Object} config
   * @param {string} config.host - API base URL (e.g., "https://cdm.example.com")
   * @param {string} config.secret - API secret/key
   * @param {string} config.device_name - CDM device name on the server
   * @param {string} [config.device_type] - "ANDROID" or "CHROME"
   */
  class Client {
    constructor(config) {
      this.host = (config.host || "").replace(/\/+$/, "");
      this.secret = config.secret || "";
      this.deviceName = config.device_name || "";
      this.deviceType = config.device_type || "ANDROID";
      this.sessionId = null;
    }

    async _request(endpoint, body) {
      const url = `${this.host}${endpoint}`;
      const headers = {
        "Content-Type": "application/json",
      };
      if (this.secret) {
        headers["X-Secret-Key"] = this.secret;
      }

      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`CDM API error ${resp.status}: ${text}`);
      }

      try {
        return await resp.json();
      } catch (parseErr) {
        const raw = await resp.text().catch(() => "(unreadable body)");
        throw new Error(
          `CDM API response is not valid JSON (${resp.status}): ${raw.substring(0, 200)}`,
        );
      }
    }

    /**
     * Open a new CDM session.
     * @returns {Promise<string>} session ID
     */
    async open() {
      const data = await this._request(`/${this.deviceName}/open`, {});
      this.sessionId = data.data?.session_id || data.session_id;
      if (!this.sessionId) {
        throw new Error("No session_id in response: " + JSON.stringify(data));
      }
      console.log("[RemoteCDM] Session opened:", this.sessionId);
      return this.sessionId;
    }

    /**
     * Generate a license challenge for the given PSSH.
     *
     * @param {string} psshB64 - Base64-encoded PSSH box
     * @param {boolean} [privacy=false] - Use privacy mode (service certificate)
     * @returns {Promise<string>} Base64-encoded challenge
     */
    async getChallenge(psshB64, privacy = false) {
      if (!this.sessionId) throw new Error("No session open");

      const data = await this._request(
        `/${this.deviceName}/get_license_challenge/${this.deviceType}`,
        {
          session_id: this.sessionId,
          init_data: psshB64,
          privacy_mode: privacy,
        },
      );

      const challenge =
        data.data?.challenge_b64 ||
        data.data?.challenge ||
        data.challenge_b64 ||
        data.challenge;
      if (!challenge) {
        throw new Error("No challenge in response: " + JSON.stringify(data));
      }

      console.log("[RemoteCDM] Challenge generated, length:", challenge.length);
      return challenge;
    }

    /**
     * Parse a license response from the server.
     *
     * @param {string} licenseB64 - Base64-encoded license response
     */
    async parseLicense(licenseB64) {
      if (!this.sessionId) throw new Error("No session open");

      await this._request(`/${this.deviceName}/parse_license`, {
        session_id: this.sessionId,
        license_message: licenseB64,
      });

      console.log("[RemoteCDM] License parsed successfully");
    }

    /**
     * Extract content keys from the parsed license.
     *
     * @param {string} [keyType="CONTENT"] - Key type filter
     * @returns {Promise<Array<{kid: string, key: string, type: string}>>}
     */
    async getKeys(keyType = "CONTENT") {
      if (!this.sessionId) throw new Error("No session open");

      const data = await this._request(
        `/${this.deviceName}/get_keys/${keyType}`,
        {
          session_id: this.sessionId,
        },
      );

      const keys = data.data?.keys || data.keys || [];
      console.log(`[RemoteCDM] Extracted ${keys.length} ${keyType} key(s)`);
      return keys;
    }

    /**
     * Close the CDM session and release resources.
     */
    async close() {
      if (!this.sessionId) return;

      try {
        await this._request(`/${this.deviceName}/close/${this.sessionId}`, {});
        console.log("[RemoteCDM] Session closed:", this.sessionId);
      } catch (e) {
        console.warn("[RemoteCDM] Close error (non-fatal):", e.message);
      }
      this.sessionId = null;
    }

    /**
     * Full pipeline: PSSH → challenge → (user sends to license server) → license → keys.
     *
     * @param {string} psshB64 - Base64-encoded PSSH box
     * @param {string} licenseUrl - License server URL
     * @param {Object} [headers] - Headers for the license request
     * @returns {Promise<Array<{kid: string, key: string}>>}
     */
    async extractKeys(psshB64, licenseUrl, headers = {}) {
      try {
        await this.open();
        const challengeB64 = await this.getChallenge(psshB64);
        const challengeBytes = WidevineProto.fromBase64(challengeB64);

        // Send challenge to the actual license server
        const licenseHeaders = Object.assign(
          { "Content-Type": "application/octet-stream" },
          headers,
        );

        const resp = await fetch(licenseUrl, {
          method: "POST",
          headers: licenseHeaders,
          body: challengeBytes,
        });

        if (!resp.ok) {
          throw new Error(
            `License server ${resp.status}: ${await resp.text()}`,
          );
        }

        // Handle JSON-wrapped licenses ({"license": "<base64>"})
        const contentType = resp.headers.get("content-type") || "";
        let licenseB64;
        if (contentType.includes("json")) {
          const json = await resp.json();
          licenseB64 =
            json.license || json.License || json.license_data || json.data;
          if (!licenseB64) {
            // Try raw content as base64
            licenseB64 = WidevineProto.toBase64(
              new Uint8Array(await resp.clone().arrayBuffer()),
            );
          }
        } else {
          licenseB64 = WidevineProto.toBase64(
            new Uint8Array(await resp.arrayBuffer()),
          );
        }

        await this.parseLicense(licenseB64);
        const keys = await this.getKeys("CONTENT");
        return keys;
      } finally {
        await this.close();
      }
    }
  }

  /**
   * CDRM-Project API client — alternative to pywidevine Remote CDM.
   * Uses a different API format but same purpose.
   */
  class CDRMClient {
    constructor(apiUrl) {
      this.apiUrl = (apiUrl || "https://cdrm-project.com/wv").replace(
        /\/+$/,
        "",
      );
    }

    /**
     * One-shot key extraction via CDRM API.
     *
     * @param {string} psshB64 - Base64-encoded PSSH
     * @param {string} licenseUrl - License server URL
     * @param {Object} headers - Headers dict
     * @returns {Promise<Array<{kid: string, key: string}>>}
     */
    async extractKeys(psshB64, licenseUrl, headers = {}) {
      const resp = await fetch(this.apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          PSSH: psshB64,
          License: licenseUrl,
          Headers: JSON.stringify(headers),
          JSON: "",
          Cookies: "",
          Data: "",
          Proxy: "",
        }),
      });

      if (!resp.ok) {
        throw new Error(`CDRM API error ${resp.status}`);
      }

      const text = await resp.text();
      // Parse response — CDRM returns keys as "KID:KEY\nKID:KEY"
      const keys = [];
      for (const line of text.split("\n")) {
        const match = line.match(/([0-9a-f]{32}):([0-9a-f]{32})/i);
        if (match) {
          keys.push({
            kid: match[1].toLowerCase(),
            key: match[2].toLowerCase(),
          });
        }
      }
      return keys;
    }
  }

  return { Client, CDRMClient };
})();
