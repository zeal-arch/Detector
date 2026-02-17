/**
 * mp4-parser.js — ISO BMFF (MP4) Box Parser
 * ==========================================
 * Educational implementation of an MP4 box parser for DRM analysis.
 *
 * MP4 files are structured as nested "boxes" (also called "atoms"):
 *
 *   ┌──────────────────────────────────────────┐
 *   │ ftyp (file type)                         │
 *   ├──────────────────────────────────────────┤
 *   │ moov (movie metadata)                    │
 *   │  ├── trak (track)                        │
 *   │  │   ├── tkhd (track header)             │
 *   │  │   └── mdia                            │
 *   │  │       └── minf                        │
 *   │  │           └── stbl                    │
 *   │  │               └── stsd                │
 *   │  │                   └── encv/enca       │  ← encrypted video/audio
 *   │  │                       └── sinf        │  ← scheme info
 *   │  │                           ├── schm    │  ← scheme type (cenc/cbcs)
 *   │  │                           └── schi    │
 *   │  │                               └── tenc│  ← default KID + IV size
 *   │  └── pssh (PSSH boxes at moov level)     │
 *   ├──────────────────────────────────────────┤
 *   │ moof (movie fragment)                    │
 *   │  └── traf (track fragment)               │
 *   │      ├── tfhd                            │
 *   │      ├── trun                            │
 *   │      └── senc (sample encryption)        │  ← per-sample IVs + subsamples
 *   ├──────────────────────────────────────────┤
 *   │ mdat (media data — encrypted samples)    │
 *   └──────────────────────────────────────────┘
 *
 * For CENC decryption we need:
 *   1. `tenc` box → default KID + IV size
 *   2. `senc` box → per-sample IVs (and subsample ranges for CBCS)
 *   3. Content keys (from CDM) to decrypt with AES-CTR or AES-CBC
 */

// eslint-disable-next-line no-unused-vars
var MP4Parser = (function () {
  "use strict";

  // ─── Box Reading ─────────────────────────────────────────────────

  /**
   * Read an MP4 box header at the given offset.
   * Returns { type, size, headerSize, dataOffset } or null.
   */
  function readBoxHeader(buf, offset) {
    if (offset + 8 > buf.length) return null;

    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let size = view.getUint32(offset, false);
    const type = String.fromCharCode(
      buf[offset + 4],
      buf[offset + 5],
      buf[offset + 6],
      buf[offset + 7],
    );
    let headerSize = 8;

    if (size === 1) {
      // Extended size (64-bit)
      if (offset + 16 > buf.length) return null;
      const hi = view.getUint32(offset + 8, false);
      const lo = view.getUint32(offset + 12, false);
      size = hi * 0x100000000 + lo;
      headerSize = 16;
    } else if (size === 0) {
      // Box extends to end of file
      size = buf.length - offset;
    }

    return {
      type,
      size,
      headerSize,
      dataOffset: offset + headerSize,
    };
  }

  /**
   * Iterate over top-level boxes in a buffer.
   * Yields { type, size, headerSize, dataOffset, data } for each box.
   */
  function* iterBoxes(buf, start = 0, end = undefined) {
    let offset = start;
    const limit = end !== undefined ? end : buf.length;

    while (offset < limit) {
      const box = readBoxHeader(buf, offset);
      if (!box || box.size < 8) break;

      box.data = buf.slice(box.dataOffset, offset + box.size);
      yield box;

      offset += box.size;
    }
  }

  /**
   * Find a specific box type within a buffer.
   * Returns the first matching box or null.
   */
  function findBox(buf, type, start = 0, end = undefined) {
    for (const box of iterBoxes(buf, start, end)) {
      if (box.type === type) return box;
    }
    return null;
  }

  /**
   * Find all boxes of a given type (recursive search).
   */
  function findBoxesDeep(buf, type, results = []) {
    for (const box of iterBoxes(buf)) {
      if (box.type === type) {
        results.push(box);
      }
      // Container boxes — recurse into them
      const containers = [
        "moov",
        "trak",
        "mdia",
        "minf",
        "stbl",
        "stsd",
        "sinf",
        "schi",
        "moof",
        "traf",
        "mvex",
        "edts",
        "encv",
        "enca",
        "avc1",
        "avc3",
        "hev1",
        "hvc1",
        "mp4a",
        "ac-3",
        "ec-3",
      ];
      if (containers.includes(box.type) || box.type.startsWith("enc")) {
        findBoxesDeep(box.data, type, results);
      }
    }
    return results;
  }

  // ─── PSSH Box Extraction ─────────────────────────────────────────

  /**
   * Extract all PSSH boxes from an MP4 init segment.
   * Returns array of { systemId: hex, data: Uint8Array, version, kidList }
   */
  function extractPSSH(buf) {
    const results = [];
    const psshBoxes = findBoxesDeep(buf, "pssh");

    for (const box of psshBoxes) {
      const data = box.data;
      if (data.length < 20) continue;

      const version = data[0];
      // flags = data[1..3]
      const systemId = WidevineProto.toHex(data.slice(4, 20));

      let offset = 20;
      const kidList = [];

      if (version === 1) {
        const view = new DataView(
          data.buffer,
          data.byteOffset,
          data.byteLength,
        );
        const kidCount = view.getUint32(offset, false);
        offset += 4;
        for (let i = 0; i < kidCount; i++) {
          kidList.push(WidevineProto.toHex(data.slice(offset, offset + 16)));
          offset += 16;
        }
      }

      const dataView = new DataView(
        data.buffer,
        data.byteOffset,
        data.byteLength,
      );
      const dataSize = dataView.getUint32(offset, false);
      offset += 4;
      const psshData = data.slice(offset, offset + dataSize);

      // Reconstruct the full PSSH box for base64 encoding
      const fullBox = buf.slice(
        box.dataOffset - box.headerSize,
        box.dataOffset - box.headerSize + box.size,
      );

      results.push({
        systemId,
        version,
        kidList,
        data: psshData,
        fullBox,
        fullBoxB64: WidevineProto.toBase64(fullBox),
      });
    }

    return results;
  }

  // ─── tenc Box (Track Encryption) ─────────────────────────────────

  /**
   * Parse a tenc box to get default encryption parameters.
   *
   * tenc box layout:
   *   [1]  version
   *   [3]  flags
   *   [1]  reserved (or crypt_byte_block for version >= 1)
   *   [1]  reserved (or skip_byte_block for version >= 1)
   *   [1]  isProtected
   *   [1]  perSampleIVSize
   *   [16] defaultKID
   *   if perSampleIVSize == 0:
   *     [1] constantIVSize
   *     [N] constantIV
   */
  function parseTenc(buf) {
    const tencBoxes = findBoxesDeep(buf, "tenc");
    if (tencBoxes.length === 0) return null;

    const data = tencBoxes[0].data;
    if (data.length < 24) return null;

    const version = data[0];
    let cryptByteBlock = 0;
    let skipByteBlock = 0;

    if (version >= 1) {
      cryptByteBlock = (data[4] >> 4) & 0x0f;
      skipByteBlock = data[4] & 0x0f;
    }

    const isProtected = data[6];
    const perSampleIVSize = data[7];
    const defaultKID = WidevineProto.toHex(data.slice(8, 24));

    let constantIV = null;
    if (perSampleIVSize === 0 && data.length > 24) {
      const constantIVSize = data[24];
      constantIV = data.slice(25, 25 + constantIVSize);
    }

    return {
      version,
      cryptByteBlock,
      skipByteBlock,
      isProtected,
      perSampleIVSize,
      defaultKID,
      constantIV,
    };
  }

  // ─── schm Box (Scheme Type) ──────────────────────────────────────

  /**
   * Parse a schm box to determine the encryption scheme.
   *
   * Common schemes:
   *   "cenc" — AES-CTR full-sample encryption (Common Encryption)
   *   "cbc1" — AES-CBC full-sample encryption
   *   "cens" — AES-CTR subsample encryption
   *   "cbcs" — AES-CBC subsample encryption (used by Apple/FairPlay)
   */
  function parseSchemeType(buf) {
    const schmBoxes = findBoxesDeep(buf, "schm");
    if (schmBoxes.length === 0) return null;

    const data = schmBoxes[0].data;
    if (data.length < 8) return null;

    // Version(1) + flags(3) + scheme_type(4) + scheme_version(4)
    const schemeType = String.fromCharCode(data[4], data[5], data[6], data[7]);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const schemeVersion = view.getUint32(8, false);

    return { schemeType, schemeVersion };
  }

  // ─── senc Box (Sample Encryption) ────────────────────────────────

  /**
   * Parse a senc box to get per-sample IVs and subsample info.
   *
   * senc box layout:
   *   [1]  version
   *   [3]  flags (0x02 = has subsample info)
   *   [4]  sampleCount
   *   for each sample:
   *     [N]  IV (N = perSampleIVSize from tenc)
   *     if flags & 0x02:
   *       [2]  subsampleCount
   *       for each subsample:
   *         [2]  bytesOfClearData
   *         [4]  bytesOfProtectedData
   */
  function parseSenc(buf, perSampleIVSize) {
    const sencBoxes = findBoxesDeep(buf, "senc");
    if (sencBoxes.length === 0) return null;

    const data = sencBoxes[0].data;
    if (data.length < 8) return null;

    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const flags = (data[1] << 16) | (data[2] << 8) | data[3];
    const hasSubsamples = (flags & 0x02) !== 0;
    const sampleCount = view.getUint32(4, false);

    let offset = 8;
    const samples = [];

    for (let i = 0; i < sampleCount && offset < data.length; i++) {
      const iv = data.slice(offset, offset + perSampleIVSize);
      offset += perSampleIVSize;

      const subsamples = [];
      if (hasSubsamples) {
        const subsampleCount = view.getUint16(offset, false);
        offset += 2;
        for (let j = 0; j < subsampleCount && offset + 6 <= data.length; j++) {
          const clearBytes = view.getUint16(offset, false);
          offset += 2;
          const protectedBytes = view.getUint32(offset, false);
          offset += 4;
          subsamples.push({ clearBytes, protectedBytes });
        }
      }

      samples.push({ iv, subsamples });
    }

    return { sampleCount, hasSubsamples, samples };
  }

  // ─── Detect Encryption ───────────────────────────────────────────

  /**
   * Analyze an MP4 init segment and return all encryption info.
   */
  function analyzeEncryption(initSegment) {
    const psshList = extractPSSH(initSegment);
    const tenc = parseTenc(initSegment);
    const scheme = parseSchemeType(initSegment);

    const isEncrypted = tenc ? tenc.isProtected === 1 : psshList.length > 0;

    return {
      isEncrypted,
      scheme: scheme ? scheme.schemeType : null,
      schemeVersion: scheme ? scheme.schemeVersion : null,
      defaultKID: tenc ? tenc.defaultKID : null,
      perSampleIVSize: tenc ? tenc.perSampleIVSize : 0,
      constantIV: tenc ? tenc.constantIV : null,
      cryptByteBlock: tenc ? tenc.cryptByteBlock : 0,
      skipByteBlock: tenc ? tenc.skipByteBlock : 0,
      psshList,
    };
  }

  // ─── Public API ──────────────────────────────────────────────────

  return {
    readBoxHeader,
    iterBoxes,
    findBox,
    findBoxesDeep,
    extractPSSH,
    parseTenc,
    parseSchemeType,
    parseSenc,
    analyzeEncryption,
  };
})();
