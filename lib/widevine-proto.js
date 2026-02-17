/**
 * widevine-proto.js — Minimal Widevine Protobuf Parser
 * =====================================================
 * Educational implementation of protobuf decoding for Widevine license messages.
 *
 * The Widevine DRM protocol uses Google Protocol Buffers for its wire format.
 * We only need to parse/create a few specific message types:
 *
 *   SignedMessage {
 *     MessageType type = 1;           // varint enum
 *     bytes msg = 2;                  // embedded LicenseRequest
 *     bytes signature = 3;
 *   }
 *
 *   LicenseRequest {
 *     ClientId client_id = 1;
 *     ContentId content_id = 2;       // embedded
 *   }
 *
 *   ContentId {
 *     WidevinePsshData widevine_pssh_data = 1;  // embedded
 *   }
 *
 *   WidevinePsshData {
 *     repeated bytes pssh_data = 1;   // the actual PSSH init data
 *     LicenseType license_type = 2;
 *   }
 *
 * Protobuf wire format:
 *   - Each field = varint tag + data
 *   - Tag = (field_number << 3) | wire_type
 *   - Wire type 0 = varint, 2 = length-delimited (bytes/string/embedded)
 *
 * This lets us extract PSSH from a browser-generated challenge WITHOUT
 * needing the full protobuf.js library (saves ~200KB).
 */

// eslint-disable-next-line no-unused-vars
var WidevineProto = (function () {
  "use strict";

  // ─── Protobuf Varint Decoding ────────────────────────────────────

  /**
   * Read a varint from a Uint8Array at the given offset.
   * Returns { value: BigInt|number, bytesRead: number }
   */
  function readVarint(buf, offset) {
    let result = 0;
    let shift = 0;
    let bytesRead = 0;

    while (offset < buf.length) {
      const byte = buf[offset++];
      bytesRead++;
      result |= (byte & 0x7f) << shift;

      if ((byte & 0x80) === 0) {
        return { value: result >>> 0, bytesRead };
      }
      shift += 7;
      if (shift >= 35) {
        // Overflow — skip remaining bytes
        while (offset < buf.length && buf[offset++] & 0x80) {
          bytesRead++;
        }
        bytesRead++;
        return { value: result >>> 0, bytesRead };
      }
    }

    return { value: result >>> 0, bytesRead };
  }

  // ─── Low-Level Field Parser ──────────────────────────────────────

  /**
   * Parse all fields from a protobuf-encoded buffer.
   * Returns an array of { fieldNumber, wireType, data } entries.
   *
   * For wire type 0 (varint): data = number
   * For wire type 2 (length-delimited): data = Uint8Array slice
   * For other wire types: data = raw bytes (best-effort)
   */
  function parseFields(buf) {
    const fields = [];
    let offset = 0;

    while (offset < buf.length) {
      // Read tag
      const tag = readVarint(buf, offset);
      offset += tag.bytesRead;

      const fieldNumber = tag.value >>> 3;
      const wireType = tag.value & 0x7;

      if (fieldNumber === 0) break; // Invalid

      switch (wireType) {
        case 0: {
          // Varint
          const val = readVarint(buf, offset);
          offset += val.bytesRead;
          fields.push({ fieldNumber, wireType, data: val.value });
          break;
        }

        case 2: {
          // Length-delimited (bytes, string, or embedded message)
          const len = readVarint(buf, offset);
          offset += len.bytesRead;
          const data = buf.slice(offset, offset + len.value);
          offset += len.value;
          fields.push({ fieldNumber, wireType, data });
          break;
        }

        case 1: {
          // 64-bit fixed
          const data = buf.slice(offset, offset + 8);
          offset += 8;
          fields.push({ fieldNumber, wireType, data });
          break;
        }

        case 5: {
          // 32-bit fixed
          const data = buf.slice(offset, offset + 4);
          offset += 4;
          fields.push({ fieldNumber, wireType, data });
          break;
        }

        default:
          // Unknown wire type — stop parsing to avoid corruption
          return fields;
      }
    }

    return fields;
  }

  // ─── High-Level Widevine Message Parsers ─────────────────────────

  /**
   * Extract PSSH data from a Widevine license challenge (SignedMessage).
   *
   * Path: SignedMessage.msg(2) → LicenseRequest.content_id(2) →
   *       ContentId.widevine_pssh_data(1) → WidevinePsshData.pssh_data(1)
   *
   * @param {Uint8Array} challengeBytes - The raw license challenge
   * @returns {Uint8Array|null} - The PSSH init data, or null if not found
   */
  function extractPsshFromChallenge(challengeBytes) {
    try {
      // Level 1: SignedMessage
      const signedMsg = parseFields(challengeBytes);
      const msgField = signedMsg.find(
        (f) => f.fieldNumber === 2 && f.wireType === 2,
      );
      if (!msgField) return null;

      // Level 2: LicenseRequest
      const licenseReq = parseFields(msgField.data);
      const contentIdField = licenseReq.find(
        (f) => f.fieldNumber === 2 && f.wireType === 2,
      );
      if (!contentIdField) return null;

      // Level 3: ContentId
      const contentId = parseFields(contentIdField.data);
      const psshDataField = contentId.find(
        (f) => f.fieldNumber === 1 && f.wireType === 2,
      );
      if (!psshDataField) return null;

      // Level 4: WidevinePsshData
      const psshData = parseFields(psshDataField.data);
      const psshBytesField = psshData.find(
        (f) => f.fieldNumber === 1 && f.wireType === 2,
      );
      if (!psshBytesField) return null;

      return psshBytesField.data;
    } catch (e) {
      console.error("[WV-Proto] Failed to extract PSSH:", e);
      return null;
    }
  }

  /**
   * Extract the MessageType from a SignedMessage.
   *
   * MessageType enum:
   *   1 = LICENSE_REQUEST
   *   2 = LICENSE
   *   3 = ERROR_RESPONSE
   *   4 = SERVICE_CERTIFICATE_REQUEST
   *   5 = SERVICE_CERTIFICATE
   */
  function getMessageType(signedMessageBytes) {
    try {
      const fields = parseFields(signedMessageBytes);
      const typeField = fields.find(
        (f) => f.fieldNumber === 1 && f.wireType === 0,
      );
      return typeField ? typeField.data : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Extract the session ID (request_id) from a license response (SignedMessage → License).
   * Used to correlate challenge/response pairs.
   *
   * Path: SignedMessage.msg(2) → License.id(1) → LicenseIdentification.request_id(2)
   */
  function extractRequestIdFromLicense(licenseBytes) {
    try {
      const signedMsg = parseFields(licenseBytes);
      const msgField = signedMsg.find(
        (f) => f.fieldNumber === 2 && f.wireType === 2,
      );
      if (!msgField) return null;

      const license = parseFields(msgField.data);
      const idField = license.find(
        (f) => f.fieldNumber === 1 && f.wireType === 2,
      );
      if (!idField) return null;

      const licenseId = parseFields(idField.data);
      const requestId = licenseId.find(
        (f) => f.fieldNumber === 2 && f.wireType === 2,
      );
      return requestId ? requestId.data : null;
    } catch (e) {
      return null;
    }
  }

  // ─── PSSH Box Utilities ──────────────────────────────────────────

  // Widevine System ID: edef8ba9-79d6-4ace-a3c8-27dcd51d21ed
  const WIDEVINE_SYSTEM_ID = new Uint8Array([
    0xed, 0xef, 0x8b, 0xa9, 0x79, 0xd6, 0x4a, 0xce, 0xa3, 0xc8, 0x27, 0xdc,
    0xd5, 0x1d, 0x21, 0xed,
  ]);

  /**
   * Wrap raw PSSH init data into a standard PSSH box (version 0).
   * This is what Remote CDM APIs expect: a full PSSH box in base64.
   *
   * PSSH Box structure:
   *   [4 bytes] size (big-endian)
   *   [4 bytes] "pssh"
   *   [1 byte]  version (0)
   *   [3 bytes] flags (0x000000)
   *   [16 bytes] systemId (Widevine)
   *   [4 bytes] dataSize (big-endian)
   *   [N bytes] data (the PSSH init data)
   */
  function psshDataToPsshBox(psshData) {
    const dataLen = psshData.length;
    const boxSize = 4 + 4 + 4 + 16 + 4 + dataLen; // size + type + version+flags + systemId + dataSize + data
    const box = new Uint8Array(boxSize);
    const view = new DataView(box.buffer);

    let offset = 0;

    // Box size
    view.setUint32(offset, boxSize, false);
    offset += 4;

    // Box type "pssh"
    box[offset++] = 0x70; // p
    box[offset++] = 0x73; // s
    box[offset++] = 0x73; // s
    box[offset++] = 0x68; // h

    // Version (0) + flags (0x000000)
    view.setUint32(offset, 0, false);
    offset += 4;

    // System ID (Widevine)
    box.set(WIDEVINE_SYSTEM_ID, offset);
    offset += 16;

    // Data size
    view.setUint32(offset, dataLen, false);
    offset += 4;

    // Data
    box.set(psshData, offset);

    return box;
  }

  /**
   * Extract PSSH init data from a PSSH box.
   * Returns null if not a valid Widevine PSSH box.
   */
  function psshBoxToData(psshBox) {
    if (psshBox.length < 32) return null;

    const view = new DataView(
      psshBox.buffer,
      psshBox.byteOffset,
      psshBox.byteLength,
    );

    // Verify "pssh" box type
    if (
      psshBox[4] !== 0x70 ||
      psshBox[5] !== 0x73 ||
      psshBox[6] !== 0x73 ||
      psshBox[7] !== 0x68
    ) {
      return null;
    }

    const version = psshBox[8];
    let offset = 12; // skip size(4) + type(4) + version(1) + flags(3)

    // System ID
    const systemId = psshBox.slice(offset, offset + 16);
    offset += 16;

    // Version 1 has KID list before data
    if (version === 1) {
      const kidCount = view.getUint32(offset, false);
      offset += 4 + kidCount * 16;
    }

    // Data size + data
    const dataSize = view.getUint32(offset, false);
    offset += 4;

    return psshBox.slice(offset, offset + dataSize);
  }

  // ─── Encoding Utilities ──────────────────────────────────────────

  function toBase64(bytes) {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  function fromBase64(str) {
    const binary = atob(str);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  function toHex(bytes) {
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  function fromHex(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
    }
    return bytes;
  }

  // ─── Full Widevine Schema Constants (from eme-fingerprinting) ────
  //
  // These enums and field maps come from the license_protocol.proto
  // used in the eme-fingerprinting repo. They enable full parsing of
  // Widevine license challenges and responses.

  const SignedMessageType = {
    1: "LICENSE_REQUEST",
    2: "LICENSE",
    3: "ERROR_RESPONSE",
    4: "SERVICE_CERTIFICATE_REQUEST",
    5: "SERVICE_CERTIFICATE",
    6: "SUB_LICENSE",
    7: "CAS_LICENSE_REQUEST",
    8: "CAS_LICENSE",
    9: "EXTERNAL_LICENSE_REQUEST",
    10: "EXTERNAL_LICENSE",
  };

  const LicenseRequestType = {
    1: "NEW",
    2: "RENEWAL",
    3: "RELEASE",
  };

  const LicenseType = {
    1: "STREAMING",
    2: "OFFLINE",
    3: "AUTOMATIC",
  };

  const ProtocolVersion = {
    20: "VERSION_2_0",
    21: "VERSION_2_1",
    22: "VERSION_2_2",
  };

  const KeyContainerSecurityLevel = {
    1: "SW_SECURE_CRYPTO",
    2: "SW_SECURE_DECODE",
    3: "HW_SECURE_CRYPTO",
    4: "HW_SECURE_DECODE",
    5: "HW_SECURE_ALL",
  };

  const KeyContainerType = {
    1: "SIGNING",
    2: "CONTENT",
    3: "KEY_CONTROL",
    4: "OPERATOR_SESSION",
  };

  const PlatformVerificationStatus = {
    0: "PLATFORM_UNVERIFIED",
    1: "PLATFORM_TAMPERED",
    2: "PLATFORM_SOFTWARE_VERIFIED",
    3: "PLATFORM_HARDWARE_VERIFIED",
    4: "PLATFORM_NO_VERIFICATION",
    5: "PLATFORM_SECURE_STORAGE_SOFTWARE_VERIFIED",
  };

  const HdcpVersion = {
    0: "HDCP_NONE",
    1: "HDCP_V1",
    2: "HDCP_V2",
    3: "HDCP_V2_1",
    4: "HDCP_V2_2",
    5: "HDCP_V2_3",
    255: "HDCP_NO_DIGITAL_OUTPUT",
  };

  const TokenType = {
    0: "KEYBOX",
    1: "DRM_DEVICE_CERTIFICATE",
    2: "REMOTE_ATTESTATION_CERTIFICATE",
    3: "OEM_DEVICE_CERTIFICATE",
  };

  // ─── Deep Challenge/License Parser ───────────────────────────────
  //
  // Parse the full LicenseRequest with ClientIdentification for
  // device fingerprinting (from eme-fingerprinting analysis).

  /**
   * Parse a SignedMessage and return a structured object.
   * @param {Uint8Array} bytes - Raw SignedMessage bytes
   * @returns {Object} Parsed message with type, msg, signature, sessionKey, etc.
   */
  function parseSignedMessage(bytes) {
    const fields = parseFields(bytes);
    const result = {};

    for (const f of fields) {
      switch (f.fieldNumber) {
        case 1:
          result.type = f.data;
          result.typeName = SignedMessageType[f.data] || "UNKNOWN";
          break;
        case 2:
          result.msg = f.data;
          break;
        case 3:
          result.signature = f.data;
          break;
        case 4:
          result.sessionKey = f.data;
          break;
        case 5:
          result.remoteAttestation = f.data;
          break;
        case 8:
          result.sessionKeyType = f.data;
          break; // 0=UNDEFINED, 1=WRAPPED_AES_KEY, 2=EPHEMERAL_ECC
        case 9:
          result.oemcryptoCoreMessage = f.data;
          break;
      }
    }

    return result;
  }

  /**
   * Parse a LicenseRequest message.
   * @param {Uint8Array} bytes - Raw LicenseRequest bytes (from SignedMessage.msg)
   * @returns {Object} Parsed LicenseRequest
   */
  function parseLicenseRequest(bytes) {
    const fields = parseFields(bytes);
    const result = {};

    for (const f of fields) {
      switch (f.fieldNumber) {
        case 1:
          if (f.wireType === 2)
            result.clientId = parseClientIdentification(f.data);
          break;
        case 2:
          if (f.wireType === 2)
            result.contentId = parseContentIdentification(f.data);
          break;
        case 3:
          result.type = f.data;
          result.typeName = LicenseRequestType[f.data] || "UNKNOWN";
          break;
        case 4:
          result.requestTime = f.data;
          break;
        case 6:
          result.protocolVersion = f.data;
          result.protocolVersionName = ProtocolVersion[f.data];
          break;
        case 7:
          result.keyControlNonce = f.data;
          break;
        case 8:
          if (f.wireType === 2)
            result.encryptedClientId = parseEncryptedClientId(f.data);
          break;
      }
    }

    return result;
  }

  /**
   * Parse ClientIdentification — the fingerprinting gold (eme-fingerprinting).
   */
  function parseClientIdentification(bytes) {
    const fields = parseFields(bytes);
    const result = { clientInfo: [] };

    for (const f of fields) {
      switch (f.fieldNumber) {
        case 1:
          result.type = f.data;
          result.typeName = TokenType[f.data] || "UNKNOWN";
          break;
        case 2:
          result.token = f.data;
          break;
        case 3:
          // Repeated NameValue pairs
          if (f.wireType === 2) {
            const nv = parseNameValue(f.data);
            if (nv) result.clientInfo.push(nv);
          }
          break;
        case 4:
          result.providerClientToken = f.data;
          break;
        case 5:
          result.licenseCounter = f.data;
          break;
        case 6:
          if (f.wireType === 2)
            result.clientCapabilities = parseClientCapabilities(f.data);
          break;
        case 7:
          result.vmpData = f.data;
          break;
      }
    }

    return result;
  }

  function parseNameValue(bytes) {
    const fields = parseFields(bytes);
    const nv = {};
    for (const f of fields) {
      if (f.fieldNumber === 1 && f.wireType === 2)
        nv.name = new TextDecoder().decode(f.data);
      if (f.fieldNumber === 2 && f.wireType === 2)
        nv.value = new TextDecoder().decode(f.data);
    }
    return nv.name ? nv : null;
  }

  function parseClientCapabilities(bytes) {
    const fields = parseFields(bytes);
    const result = {};

    for (const f of fields) {
      switch (f.fieldNumber) {
        case 1:
          result.clientToken = !!f.data;
          break;
        case 2:
          result.sessionToken = !!f.data;
          break;
        case 3:
          result.videoResolutionConstraints = !!f.data;
          break;
        case 4:
          result.maxHdcpVersion = f.data;
          result.maxHdcpVersionName = HdcpVersion[f.data];
          break;
        case 5:
          result.oemCryptoApiVersion = f.data;
          break;
        case 6:
          result.antiRollbackUsageTable = !!f.data;
          break;
        case 7:
          result.srmVersion = f.data;
          break;
        case 12:
          result.resourceRatingTier = f.data;
          break;
      }
    }

    return result;
  }

  function parseContentIdentification(bytes) {
    const fields = parseFields(bytes);
    const result = {};

    for (const f of fields) {
      if (f.fieldNumber === 1 && f.wireType === 2) {
        result.widevinePsshData = parseWidevinePsshData(f.data);
      }
    }

    return result;
  }

  function parseWidevinePsshData(bytes) {
    const fields = parseFields(bytes);
    const result = { psshData: [], keyIds: [] };

    for (const f of fields) {
      if (f.fieldNumber === 1 && f.wireType === 2) result.psshData.push(f.data);
      if (f.fieldNumber === 2 && f.wireType === 0) result.licenseType = f.data;
      if (f.fieldNumber === 3 && f.wireType === 2) result.contentId = f.data;
      if (f.fieldNumber === 4 && f.wireType === 2) result.keyIds.push(f.data);
    }

    return result;
  }

  function parseEncryptedClientId(bytes) {
    const fields = parseFields(bytes);
    const result = {};

    for (const f of fields) {
      switch (f.fieldNumber) {
        case 1:
          if (f.wireType === 2)
            result.providerId = new TextDecoder().decode(f.data);
          break;
        case 2:
          result.serviceCertSerialNumber = f.data;
          break;
        case 3:
          result.encryptedClientId = f.data;
          break;
        case 4:
          result.encryptedClientIdIv = f.data;
          break;
        case 5:
          result.encryptedPrivacyKey = f.data;
          break;
      }
    }

    return result;
  }

  /**
   * Parse a License message (from license response SignedMessage.msg).
   * Extracts key containers with type, ID, IV, and encrypted key data.
   */
  function parseLicenseMessage(bytes) {
    const fields = parseFields(bytes);
    const result = { keys: [], policy: null };

    for (const f of fields) {
      if (f.fieldNumber === 1 && f.wireType === 2) {
        // LicenseIdentification
        result.id = parseLicenseIdentification(f.data);
      }
      if (f.fieldNumber === 2 && f.wireType === 2) {
        // Policy (we skip detailed parsing for now)
        result.policy = { raw: f.data };
      }
      if (f.fieldNumber === 3 && f.wireType === 2) {
        // KeyContainer
        result.keys.push(parseKeyContainer(f.data));
      }
    }

    return result;
  }

  function parseLicenseIdentification(bytes) {
    const fields = parseFields(bytes);
    const result = {};

    for (const f of fields) {
      switch (f.fieldNumber) {
        case 1:
          if (f.wireType === 2) result.requestId = f.data;
          break;
        case 2:
          if (f.wireType === 2) result.sessionId = f.data;
          break;
        case 3:
          if (f.wireType === 2) result.purchaseId = f.data;
          break;
        case 4:
          result.type = f.data;
          result.typeName = LicenseType[f.data];
          break;
        case 5:
          result.version = f.data;
          break;
        case 6:
          if (f.wireType === 2) result.providerSessionToken = f.data;
          break;
      }
    }

    return result;
  }

  function parseKeyContainer(bytes) {
    const fields = parseFields(bytes);
    const result = {};

    for (const f of fields) {
      switch (f.fieldNumber) {
        case 1:
          if (f.wireType === 2) result.id = f.data;
          break; // KID
        case 2:
          if (f.wireType === 2) result.iv = f.data;
          break; // IV for decryption
        case 3:
          if (f.wireType === 2) result.key = f.data;
          break; // Encrypted content key
        case 4:
          result.type = f.data;
          result.typeName = KeyContainerType[f.data];
          break;
        case 5:
          result.securityLevel = f.data;
          result.securityLevelName = KeyContainerSecurityLevel[f.data];
          break;
      }
    }

    return result;
  }

  /**
   * Full challenge analysis: parse SignedMessage → LicenseRequest → all fields.
   * Returns a comprehensive object useful for debugging and fingerprinting.
   */
  function analyzeChallenge(challengeBytes) {
    try {
      const signed = parseSignedMessage(challengeBytes);
      if (!signed.msg) return { signed, error: "No msg field" };

      const request = parseLicenseRequest(signed.msg);

      return {
        messageType: signed.typeName,
        protocolVersion: request.protocolVersionName,
        requestType: request.typeName,
        requestTime: request.requestTime,
        hasEncryptedClientId: !!request.encryptedClientId,
        clientInfo: request.clientId
          ? {
              type: request.clientId.typeName,
              info: request.clientId.clientInfo,
              capabilities: request.clientId.clientCapabilities,
            }
          : null,
        psshData:
          request.contentId?.widevinePsshData?.psshData?.map((d) =>
            toBase64(d),
          ) || [],
        keyIds:
          request.contentId?.widevinePsshData?.keyIds?.map((d) => toHex(d)) ||
          [],
        raw: { signed, request },
      };
    } catch (e) {
      return { error: e.message };
    }
  }

  /**
   * Analyze a license response: parse SignedMessage → License → key containers.
   */
  function analyzeLicenseResponse(responseBytes) {
    try {
      const signed = parseSignedMessage(responseBytes);
      if (!signed.msg) return { signed, error: "No msg field" };
      if (signed.type !== 2)
        return {
          signed,
          error: "Not a LICENSE message (type=" + signed.type + ")",
        };

      const license = parseLicenseMessage(signed.msg);

      return {
        messageType: signed.typeName,
        requestId: license.id?.requestId
          ? toBase64(license.id.requestId)
          : null,
        licenseType: license.id?.typeName,
        keys: license.keys.map((k) => ({
          kid: k.id ? toHex(k.id) : null,
          type: k.typeName,
          securityLevel: k.securityLevelName,
          hasIv: !!k.iv,
          hasKey: !!k.key,
        })),
        contentKeys: license.keys.filter((k) => k.type === 2).length,
        raw: { signed, license },
      };
    } catch (e) {
      return { error: e.message };
    }
  }

  // ─── Public API ──────────────────────────────────────────────────

  return {
    // Low-level
    parseFields,
    readVarint,

    // PSSH extraction
    extractPsshFromChallenge,
    psshDataToPsshBox,
    psshBoxToData,

    // Message parsing
    getMessageType,
    extractRequestIdFromLicense,
    parseSignedMessage,
    parseLicenseRequest,
    parseLicenseMessage,
    parseClientIdentification,

    // High-level analysis
    analyzeChallenge,
    analyzeLicenseResponse,

    // Encoding
    toBase64,
    fromBase64,
    toHex,
    fromHex,

    // Constants
    WIDEVINE_SYSTEM_ID,
    SignedMessageType,
    LicenseRequestType,
    LicenseType,
    KeyContainerType,
    KeyContainerSecurityLevel,
    PlatformVerificationStatus,
    HdcpVersion,
    TokenType,
    ProtocolVersion,
  };
})();
