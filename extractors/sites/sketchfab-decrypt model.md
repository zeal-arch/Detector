const fs = require('fs');
const path = require('path');

const keyB = "kikUHYEH6+gYLooRTALmincacTbmRKva5eaEasiYt2KKKYh/iNox6WIJsZEQj1SW3zyfaP2mBJ7RhJgZIORj3WiLyN5SyhQwADAAMwAxEmdwyCReuRNkj1XG2TEnjD9HRYN86vQXVwLMt6porYWDlS6FxMhaYlWCag4giegauJ/wc4E8crJeIpNmvUQnrRf6oAiX3fWOz3MHTUG87Shw0yWdY65jnR2DHMYoUTgwMt2CvVAIgDQS1uKf2BhxKq9HnAqDOxqDT3/xf4wn3YsorP4SotMgCWapEEvPUqGWvin6GXXRdHW1OcPm+oJNKV5+aGKcXR3RVHU1xdtUxunxSo+BWMcl5uzepMnZggUiKOAkmLHygArNjdNmYH4x5Rg2hS12LBLQncuBGwN3w4s4Bl7rtDErAOy2IsQkZq0OaBLWrWowqIbARgO82z+j544HwogQD2M=";
const E_k = "6a74e5202122eb8b0e2ee4010cc9a6fba519fee5";

async function decrypt() {
    const url = "https://static.sketchfab.com/static/builds/web/dist/ea48ef388b3819bb685ec4de2633e165-v2.js";
    console.log("Fetching main bundle to extract WASM...");
    const res = await fetch(url);
    const text = await res.text();

    let startTarget = '"kbo/":';
    let pos = text.indexOf(startTarget);
    if (pos === -1) {
        startTarget = "'kbo/':";
        pos = text.indexOf(startTarget);
    }
    if (pos === -1) {
        console.error("kbo/ module not found!");
        return;
    }

    let endPos = pos + 800000;
    if (endPos > text.length) endPos = text.length;
    let moduleText = text.substring(pos, endPos);

    let wasmIdx = moduleText.indexOf('"AGFzbQ');
    if (wasmIdx === -1) {
        console.error("WASM binary string not found!");
        return;
    }

    let wasmEndIdx = moduleText.indexOf('"', wasmIdx + 7);
    if (wasmEndIdx === -1) {
        console.error("WASM end quote not found!");
        return;
    }

    let base64Wasm = moduleText.substring(wasmIdx + 1, wasmEndIdx);
    base64Wasm = base64Wasm.replace(/\\n/g, '').replace(/\n/g, '').trim();
    let wasmBuf = Buffer.from(base64Wasm, 'base64');
    console.log(`Extracted WASM binary, length: ${wasmBuf.length} bytes`);

    let wasmMemory = new WebAssembly.Memory({ initial: 256, maximum: 8192 });
    let wasmMemArray = new Uint8Array(wasmMemory.buffer);

    // Parse WASM to find the data segment offset (h)
    let h = 65536;
    let r = wasmBuf;
    for (let p, y, I, d = 8; d < r.length; d = p) {
        function v() { return r[d++] }
        function _() {
            for (var t = d, n = 0, e = 128; 128 & e; d++) n |= (127 & (e = r[d])) << 7 * (d - t);
            return n
        }
        if (y = _(), I = _(), p = d + I, y < 0 || y > 11 || I <= 0 || p > r.length) break;
        if (6 === y) { _(), v(), v(), _(); let w = _(); _(), h = w }
        if (11 === y) for (let A = _(), Z = 0; Z !== A && d < p; Z++) { v(), _(); _(); _(); let k = _(); d += k }
    }
    console.log(`Parsed initial heap offset (sbrk): ${h}`);
    let sbrkOffset = h; // Initial heap pointer
    let imports = {
        env: {
            sbrk: (n) => {
                let prev = sbrkOffset;
                sbrkOffset += n;
                // If heap grows beyond current memory size, grow it
                let bytesNeeded = sbrkOffset - wasmMemory.buffer.byteLength;
                if (bytesNeeded > 0) {
                    let pagesToGrow = Math.ceil(bytesNeeded / 65536);
                    wasmMemory.grow(pagesToGrow);
                    wasmMemArray = new Uint8Array(wasmMemory.buffer);
                }
                return prev;
            },
            time: (n) => {
                let now = Math.floor(Date.now() / 1000);
                if (n) {
                    let view = new Int32Array(wasmMemory.buffer);
                    view[n >> 2] = now;
                }
                return now;
            },
            gettimeofday: (n) => {
                let now = Date.now();
                let view = new Int32Array(wasmMemory.buffer);
                view[n >> 2] = Math.floor(now / 1000);
                view[(n + 4) >> 2] = (now % 1000) * 1000;
            },
            abort: () => { throw new Error("WASM abort called"); },
            __lock: () => { },
            __unlock: () => { },
            memory: wasmMemory
        }
    };

    const wasmModule = await WebAssembly.instantiate(wasmBuf, imports);
    const exports = wasmModule.instance.exports;
    console.log("WebAssembly instantiated successfully.");

    // Call __wasm_call_ctors if exists
    if (exports.__wasm_call_ctors) {
        exports.__wasm_call_ctors();
    }

    // Request ID
    const D = 0;

    // Key Derivation (Phase 3 in worker)
    console.log("Setting up decryption keys...");
    let o_key = E_k.toLowerCase();
    let M_val = 2000;
    let y_val = M_val;
    let c_vals = [];
    for (let F = 0; F < 10; ++F) {
        let G = parseInt(o_key.slice(4 * F, 4 * F + 4), 16);
        y_val ^= G;
        c_vals.push(G ^ M_val);
        c_vals.push(y_val);
    }

    let i_val = c_vals[19];
    for (let t = 0; t < 10; ++t) {
        i_val ^= c_vals[2 * t];
    }
    let u_vals = new Array(10);
    for (let t = 0; t < 10; ++t) {
        u_vals[t] = c_vals[2 * t] ^ i_val;
    }

    // Setup deobfuscated SHA1 hash in WASM memory
    // exports.Umlja1JvbGxlZDRV is RickRolled4U
    console.log("Calling RickRolled4U...");
    let keySetupOffset = exports["Umlja1JvbGxlZDRV"](D, 40);
    console.log(`RickRolled4U returned offset ${keySetupOffset}`);
    for (let t = 0; t < 10; ++t) {
        let s_str = u_vals[t].toString(16);
        s_str = "0".repeat(4 - s_str.length) + s_str;
        for (let n = 0; n < s_str.length; ++n) {
            wasmMemArray[keySetupOffset + n + 4 * t] = s_str.charCodeAt(n);
        }
    }

    // Decryption Setup (Phase 2 in worker)
    // Decode base64 key B
    let b_key_buf = Buffer.from(keyB, 'base64');

    // exports.__unlock if exported, else imports.env.__unlock
    if (exports.__unlock) {
        console.log("Calling __unlock...");
        exports.__unlock();
        console.log("__unlock returned.");
    }

    // Call worker-side initialization function never_gonna_let_you_down_Ne
    console.log("Calling never_gonna_let_you_down_Ne...");
    exports["mV2ZXIgZ29ubmEgbGV0IHlvdSBkb3duCk5l"]();
    console.log("never_gonna_let_you_down_Ne returned.");

    // never_gonna_run_around_and_desert_you (ver gonna run around and) -> exports["dmVyIGdvbm5hIHJ1biBhcm91bmQgYW5kI"]
    console.log("Calling dmVyIGdvbm5hIHJ1biBhcm91bmQgYW5kI...");
    let keyOffset = exports["dmVyIGdvbm5hIHJ1biBhcm91bmQgYW5kI"](b_key_buf.length);
    console.log(`dmVyIGdvbm5hIHJ1biBhcm91bmQgYW5kI returned offset ${keyOffset}`);
    let mem = new Uint8Array(wasmMemory.buffer);
    for (let r = 0; r < b_key_buf.length; ++r) {
        mem[keyOffset + r] = b_key_buf[r];
    }

    // desert_you_never_gonna_m (GRlc2VydCB5b3UKTmV2ZXIgZ29ubmEgbW)
    exports["GRlc2VydCB5b3UKTmV2ZXIgZ29ubmEgbW"](0);

    // Decrypt the geometry file
    const encGeoPath = "d:\\Detector-main\\Cat_Simple_Model\\geometry.binz";
    console.log(`Reading encrypted geometry from: ${encGeoPath}`);
    const encGeo = fs.readFileSync(encGeoPath);

    console.log(`Encrypted size: ${encGeo.length} bytes`);

    let decryptedChunks = [];
    for (let n = 0; n < encGeo.length; n += 10240) {
        let chunkSize = Math.min(10240, encGeo.length - n);

        // allocate_input_buffer (heSBnb29kYnllCk5ldmVyIGdvbm5hIHRl)
        let inputOffset = exports["heSBnb29kYnllCk5ldmVyIGdvbm5hIHRl"](chunkSize);
        mem = new Uint8Array(wasmMemory.buffer);
        for (let t = 0; t < chunkSize; ++t) {
            mem[inputOffset + t] = encGeo[n + t];
        }

        // decrypt_chunk (GRlc2VydCB5b3UKTmV2ZXIgZ29ubmEgbW) with parameter 1
        let hasOutput = exports["GRlc2VydCB5b3UKTmV2ZXIgZ29ubmEgbW"](1);
        while (hasOutput) {
            // get_output_offset (TmV2ZXIgZ29ubmEgZ2l2ZSB5b3UgdXAKT)
            let outOffset = exports["TmV2ZXIgZ29ubmEgZ2l2ZSB5b3UgdXAKT"]();
            // get_output_length (bGwgYSBsaWUgYW5kIGh1cnQgeW91Cg)
            let outLength = exports["bGwgYSBsaWUgYW5kIGh1cnQgeW91Cg"]();

            mem = new Uint8Array(wasmMemory.buffer);
            let outChunk = mem.subarray(outOffset, outOffset + outLength);
            let copied = new Uint8Array(outLength);
            copied.set(outChunk);
            decryptedChunks.push(copied);

            // next_chunk (FrZSB5b3UgY3J5Ck5ldmVyIGdvbm5hIHN)
            exports["FrZSB5b3UgY3J5Ck5ldmVyIGdvbm5hIHN"]();

            // check if there's more output
            hasOutput = exports["GRlc2VydCB5b3UKTmV2ZXIgZ29ubmEgbW"](0);
        }
    }

    // Assemble decrypted output
    let totalLen = decryptedChunks.reduce((acc, val) => acc + val.length, 0);
    let decryptedData = new Uint8Array(totalLen);
    let offset = 0;
    for (let chunk of decryptedChunks) {
        decryptedData.set(chunk, offset);
        offset += chunk.length;
    }

    console.log(`Successfully decrypted! Decrypted size: ${decryptedData.length} bytes`);

    const outPath = "d:\\Detector-main\\Cat_Simple_Model\\geometry_decrypted.osgjs.gz";
    fs.writeFileSync(outPath, decryptedData);
    console.log(`Decrypted file saved to: ${outPath}`);

    // Try to unzip it or check if it's gzip compressed
    if (decryptedData[0] === 0x1f && decryptedData[1] === 0x8b) {
        console.log("Decrypted file is Gzipped, extracting...");
        const zlib = require('zlib');
        try {
            const unzipped = zlib.gunzipSync(decryptedData);
            console.log(`Unzipped size: ${unzipped.length} bytes`);
            fs.writeFileSync("d:\\Detector-main\\Cat_Simple_Model\\geometry_decrypted.osgjs", unzipped);
            console.log("Unzipped JSON saved to: d:\\Detector-main\\Cat_Simple_Model\\geometry_decrypted.osgjs");
        } catch (e) {
            console.error("Gzip decompression failed:", e);
        }
    }
}

decrypt();
