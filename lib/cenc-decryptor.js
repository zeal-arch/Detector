/**
 * cenc-decryptor.js — Common Encryption (CENC / CBCS) Decryption via WebCrypto
 * ==============================================================================
 * Educational implementation of MPEG CENC / CBCS decryption.
 *
 * Encryption Schemes:
 * ┌──────┬─────────────┬──────────────────────────────────────┐
 * │ Mode │ Algorithm   │ Description                          │
 * ├──────┼─────────────┼──────────────────────────────────────┤
 * │ cenc │ AES-128-CTR │ Full-sample encryption               │
 * │ cens │ AES-128-CTR │ Sub-sample encryption (NAL-unit)     │
 * │ cbc1 │ AES-128-CBC │ Full-sample encryption               │
 * │ cbcs │ AES-128-CBC │ Sub-sample + pattern encryption      │
 * └──────┴─────────────┴──────────────────────────────────────┘
 *
 * Decryption Flow:
 *   1. Parse init segment → get default KID, IV size, scheme (tenc/schm)
 *   2. Look up content key for that KID
 *   3. For each media segment:
 *      a. Parse senc box → get per-sample IVs and subsample maps
 *      b. Locate samples in mdat
 *      c. Decrypt each sample using the correct algorithm
 *   4. Reassemble the decrypted segment
 *
 * AES-CTR (cenc/cens):
 *   - IV is zero-padded to 16 bytes (if 8-byte IV: IV || 0x0000000000000000)
 *   - Counter increments per 16-byte block (big-endian increment of last 8 bytes)
 *   - For subsamples: only "protected" ranges are decrypted
 *
 * AES-CBC (cbcs):
 *   - IV is 16 bytes (from senc or constantIV)
 *   - Pattern encryption: crypt_byte_block of every (crypt + skip) blocks
 *   - Each NAL unit starts with a fresh IV
 */

// eslint-disable-next-line no-unused-vars
var CENCDecryptor = (function () {
  "use strict";

  // ─── Key Import ──────────────────────────────────────────────────

  /**
   * Import a raw key (Uint8Array or hex string) for AES decryption.
   * Returns a CryptoKey for the specified algorithm.
   */
  async function importKey(key, scheme) {
    const keyBytes = typeof key === "string" ? hexToBytes(key) : key;

    if (keyBytes.length !== 16) {
      throw new Error(`Invalid key length: ${keyBytes.length} (expected 16)`);
    }

    const algorithm =
      scheme === "cbc1" || scheme === "cbcs" ? "AES-CBC" : "AES-CTR";

    return crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: algorithm },
      false,
      ["decrypt"],
    );
  }

  // ─── AES-CTR Decryption (cenc / cens) ───────────────────────────

  /**
   * Decrypt a buffer using AES-128-CTR.
   * @param {CryptoKey} key - Imported AES-CTR key
   * @param {Uint8Array} iv - Initialization vector (8 or 16 bytes)
   * @param {Uint8Array} data - Encrypted data
   * @returns {Promise<Uint8Array>} Decrypted data
   */
  async function decryptAesCtr(key, iv, data) {
    // Zero-pad IV to 16 bytes if needed
    const counter = new Uint8Array(16);
    counter.set(iv.slice(0, Math.min(iv.length, 16)));

    const decrypted = await crypto.subtle.decrypt(
      {
        name: "AES-CTR",
        counter: counter,
        length: 64, // Counter bits (last 64 bits = 8 bytes)
      },
      key,
      data,
    );

    return new Uint8Array(decrypted);
  }

  /**
   * Decrypt a buffer using AES-128-CBC.
   * @param {CryptoKey} key - Imported AES-CBC key
   * @param {Uint8Array} iv - Initialization vector (16 bytes)
   * @param {Uint8Array} data - Encrypted data (must be multiple of 16)
   * @returns {Promise<Uint8Array>} Decrypted data
   */
  async function decryptAesCbc(key, iv, data) {
    // Pad IV to 16 bytes
    const ivPadded = new Uint8Array(16);
    ivPadded.set(iv.slice(0, Math.min(iv.length, 16)));

    // WebCrypto CBC removes PKCS#7 padding by default.
    // CENC uses no padding — data is always block-aligned.
    // We need to handle this by appending a dummy block.
    const blockSize = 16;
    const paddedData = new Uint8Array(data.length + blockSize);
    paddedData.set(data);
    // PKCS#7 padding for the dummy block
    for (let i = data.length; i < paddedData.length; i++) {
      paddedData[i] = blockSize;
    }

    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-CBC", iv: ivPadded },
      key,
      paddedData,
    );

    // Strip the dummy block padding
    return new Uint8Array(decrypted).slice(0, data.length);
  }

  // ─── Full Sample Decryption ──────────────────────────────────────

  /**
   * Decrypt a full sample (no subsample map).
   */
  async function decryptFullSample(cryptoKey, scheme, iv, sample) {
    if (scheme === "cbc1" || scheme === "cbcs") {
      // For CBC, only decrypt full 16-byte blocks
      const blockCount = Math.floor(sample.length / 16);
      if (blockCount === 0) return sample; // Too short to decrypt

      const encryptedPart = sample.slice(0, blockCount * 16);
      const remainder = sample.slice(blockCount * 16);

      const decrypted = await decryptAesCbc(cryptoKey, iv, encryptedPart);
      const result = new Uint8Array(sample.length);
      result.set(decrypted);
      result.set(remainder, decrypted.length);
      return result;
    } else {
      // AES-CTR: decrypt entire sample
      return decryptAesCtr(cryptoKey, iv, sample);
    }
  }

  /**
   * Decrypt a sample with subsample encryption.
   * Subsamples define clear/protected byte ranges within the sample.
   *
   * Sample layout with subsamples:
   *   [clear_1][protected_1][clear_2][protected_2]...[remaining]
   *
   * Only "protected" ranges are decrypted; "clear" ranges pass through.
   */
  async function decryptSubsampleSample(
    cryptoKey,
    scheme,
    iv,
    sample,
    subsamples,
    cryptByteBlock,
    skipByteBlock,
  ) {
    const output = new Uint8Array(sample.length);
    let offset = 0;
    let outOffset = 0;

    // For AES-CTR, we need to track the block counter across subsamples
    const counter = new Uint8Array(16);
    counter.set(iv.slice(0, Math.min(iv.length, 16)));
    let blockIndex = 0;

    for (const sub of subsamples) {
      // Copy clear bytes
      if (sub.clearBytes > 0) {
        output.set(sample.slice(offset, offset + sub.clearBytes), outOffset);
        offset += sub.clearBytes;
        outOffset += sub.clearBytes;
      }

      // Decrypt protected bytes
      if (sub.protectedBytes > 0) {
        const protectedData = sample.slice(offset, offset + sub.protectedBytes);

        if (scheme === "cbcs") {
          // CBCS pattern encryption
          const decrypted = decryptCbcsPattern(
            cryptoKey,
            iv,
            protectedData,
            cryptByteBlock,
            skipByteBlock,
          );
          output.set(await decrypted, outOffset);
        } else if (scheme === "cbc1") {
          const decrypted = await decryptAesCbc(cryptoKey, iv, protectedData);
          output.set(decrypted, outOffset);
        } else {
          // cenc/cens: AES-CTR with counter continuity
          const subCounter = incrementCounter(counter, blockIndex);
          const decrypted = await decryptAesCtr(
            cryptoKey,
            subCounter,
            protectedData,
          );
          output.set(decrypted, outOffset);
          blockIndex += Math.ceil(sub.protectedBytes / 16);
        }

        offset += sub.protectedBytes;
        outOffset += sub.protectedBytes;
      }
    }

    // Copy any remaining bytes (clear)
    if (offset < sample.length) {
      output.set(sample.slice(offset), outOffset);
    }

    return output;
  }

  /**
   * CBCS pattern encryption: decrypt crypt_byte_block out of every
   * (crypt_byte_block + skip_byte_block) blocks.
   * Default pattern: 1:9 (encrypt 1 block, skip 9 blocks).
   */
  async function decryptCbcsPattern(
    cryptoKey,
    iv,
    data,
    cryptByteBlock,
    skipByteBlock,
  ) {
    if (cryptByteBlock === 0 && skipByteBlock === 0) {
      // No pattern — decrypt all full blocks
      cryptByteBlock = 1;
      skipByteBlock = 0;
    }

    const blockSize = 16;
    const patternLength = (cryptByteBlock + skipByteBlock) * blockSize;
    const output = new Uint8Array(data.length);
    let offset = 0;

    while (offset < data.length) {
      const cryptBytes = cryptByteBlock * blockSize;
      const skipBytes = skipByteBlock * blockSize;

      // Encrypt block(s)
      if (offset + cryptBytes <= data.length) {
        const encrypted = data.slice(offset, offset + cryptBytes);
        const decrypted = await decryptAesCbc(cryptoKey, iv, encrypted);
        output.set(decrypted, offset);
      } else {
        // Remaining data < cryptBytes — copy as-is
        output.set(data.slice(offset), offset);
        break;
      }
      offset += cryptBytes;

      // Skip block(s) — copy as-is
      const skipEnd = Math.min(offset + skipBytes, data.length);
      output.set(data.slice(offset, skipEnd), offset);
      offset = skipEnd;
    }

    return output;
  }

  // ─── Segment Decryption (High-Level) ─────────────────────────────

  /**
   * Decrypt an entire MP4 media segment.
   *
   * @param {Uint8Array} segmentData - The full segment (moof + mdat)
   * @param {Object} encInfo - Encryption info from MP4Parser.analyzeEncryption()
   * @param {string|Uint8Array} contentKey - The content key (hex string or bytes)
   * @returns {Promise<Uint8Array>} Decrypted segment
   */
  async function decryptSegment(segmentData, encInfo, contentKey) {
    if (!encInfo.isEncrypted) {
      return segmentData; // Not encrypted, return as-is
    }

    const scheme = encInfo.scheme || "cenc";
    const cryptoKey = await importKey(contentKey, scheme);

    // Parse senc from the segment to get per-sample IVs
    const buf = new Uint8Array(segmentData);
    const senc = MP4Parser.parseSenc(buf, encInfo.perSampleIVSize);

    if (!senc && !encInfo.constantIV) {
      console.warn("[CENC] No senc box and no constantIV — cannot decrypt");
      return segmentData;
    }

    // Find mdat box — contains the actual encrypted media data
    const mdat = MP4Parser.findBox(buf, "mdat");
    if (!mdat) {
      console.warn("[CENC] No mdat box found in segment");
      return segmentData;
    }

    // Find trun box — contains per-sample sizes
    const trunSamples = parseTrun(buf);
    if (!trunSamples || trunSamples.length === 0) {
      // If no trun, try a simple full-mdat decryption
      const iv = senc ? senc.samples[0].iv : encInfo.constantIV;
      const decrypted = await decryptFullSample(
        cryptoKey,
        scheme,
        iv,
        mdat.data,
      );

      // Replace mdat content in the output
      const output = new Uint8Array(buf);
      output.set(decrypted, mdat.dataOffset);
      return output;
    }

    // Decrypt each sample individually
    const output = new Uint8Array(buf);
    let mdatOffset = 0;

    for (let i = 0; i < trunSamples.length; i++) {
      const sampleSize = trunSamples[i].size;
      if (sampleSize <= 0) continue;

      const sampleData = mdat.data.slice(mdatOffset, mdatOffset + sampleSize);
      const sencSample = senc ? senc.samples[i] : null;
      const iv = sencSample ? sencSample.iv : encInfo.constantIV;

      if (!iv) {
        mdatOffset += sampleSize;
        continue;
      }

      let decryptedSample;
      if (sencSample && sencSample.subsamples.length > 0) {
        decryptedSample = await decryptSubsampleSample(
          cryptoKey,
          scheme,
          iv,
          sampleData,
          sencSample.subsamples,
          encInfo.cryptByteBlock,
          encInfo.skipByteBlock,
        );
      } else {
        decryptedSample = await decryptFullSample(
          cryptoKey,
          scheme,
          iv,
          sampleData,
        );
      }

      output.set(decryptedSample, mdat.dataOffset + mdatOffset);
      mdatOffset += sampleSize;
    }

    return output;
  }

  // ─── trun Box Parser ─────────────────────────────────────────────

  /**
   * Parse a trun (Track Run) box to get per-sample sizes.
   * Needed to know the boundaries of each sample in mdat.
   *
   * trun flags:
   *   0x001 = data-offset-present
   *   0x004 = first-sample-flags-present
   *   0x100 = sample-duration-present
   *   0x200 = sample-size-present
   *   0x400 = sample-flags-present
   *   0x800 = sample-composition-time-offsets-present
   */
  function parseTrun(buf) {
    const trunBoxes = MP4Parser.findBoxesDeep(buf, "trun");
    if (trunBoxes.length === 0) return null;

    const data = trunBoxes[0].data;
    if (data.length < 8) return null;

    const version = data[0];
    const flags = (data[1] << 16) | (data[2] << 8) | data[3];
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const sampleCount = view.getUint32(4, false);

    let offset = 8;
    if (flags & 0x001) offset += 4; // data_offset
    if (flags & 0x004) offset += 4; // first_sample_flags

    const samples = [];
    for (let i = 0; i < sampleCount && offset < data.length; i++) {
      const sample = {};
      if (flags & 0x100) {
        sample.duration = view.getUint32(offset, false);
        offset += 4;
      }
      if (flags & 0x200) {
        sample.size = view.getUint32(offset, false);
        offset += 4;
      }
      if (flags & 0x400) {
        sample.flags = view.getUint32(offset, false);
        offset += 4;
      }
      if (flags & 0x800) {
        sample.compositionTimeOffset =
          version === 0
            ? view.getUint32(offset, false)
            : view.getInt32(offset, false);
        offset += 4;
      }
      samples.push(sample);
    }

    return samples;
  }

  // ─── Utility ─────────────────────────────────────────────────────

  function hexToBytes(hex) {
    const clean = hex.replace(/[^0-9a-fA-F]/g, "");
    const bytes = new Uint8Array(clean.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
    }
    return bytes;
  }

  function incrementCounter(counter, blockCount) {
    if (blockCount === 0) return counter;
    const result = new Uint8Array(counter);
    // Increment the last 8 bytes as a big-endian 64-bit integer
    let carry = blockCount;
    for (let i = 15; i >= 8 && carry > 0; i--) {
      carry += result[i];
      result[i] = carry & 0xff;
      carry >>= 8;
    }
    return result;
  }

  // ─── Public API ──────────────────────────────────────────────────

  return {
    importKey,
    decryptAesCtr,
    decryptAesCbc,
    decryptFullSample,
    decryptSubsampleSample,
    decryptCbcsPattern,
    decryptSegment,
    parseTrun,
  };
})();
