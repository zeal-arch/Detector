# Sketchfab Model Extraction & Decryption Internals

This document summarizes the internal mechanisms of Sketchfab's 3D model delivery, encryption, and extraction pipeline as reverse-engineered during our sessions. This can be used as the foundation for building a robust `sketchfab-extractor` (similar to `yt-dlp` for YouTube).

---

## 1. Network Data Acquisition

Models can be downloaded by intercepting browser traffic or fetching the API directly. However, direct API calls are often protected by CloudFront.

### The API Config (`/i/models/{model_id}`)
When a model loads, the page fetches an API endpoint containing the configuration.

**Target Data**: 
1. Look inside the `files` array for an item containing `osgjsUrl`.
2. Inside that same object, there is a `p` array. `p[0].b` contains the **base64 encoded decryption key**.

**Example: Fetching the Config**
```javascript
const url = "https://sketchfab.com/i/models/cbb45602331f4ccf9f230634ac257cde";
const res = await fetch(url, {
    headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36...",
        "Referer": "https://sketchfab.com/3d-models/cat-fat-cbb45602331f4ccf9f230634ac257cde"
    }
});

const data = await res.json();
const fileUrl = data.files.find(f => f.osgjsUrl).osgjsUrl; 
const key = data.files.find(f => f.osgjsUrl).p[0].b;
// fileUrl: https://media.sketchfab.com/models/.../file.binz
```
> **Note**: To avoid CloudFront `403` blocks, it is highly recommended to extract these requests directly from a `.har` network dump instead of fetching them via raw Node.js scripts.

### The Files
Once you have the `osgjsUrl`, there are two primary files you must download:
1.  **`file.binz`**: The structural file containing the encrypted OSGJS JSON tree.
2.  **`model_file.binz`**: The geometry buffers (located in the same remote directory as `file.binz`), containing encrypted binary vertex/face data.

---

## 2. Decryption Pipeline (The "Rickroll" WASM)

Sketchfab encrypts `.binz` files. Decrypting them requires extracting a WebAssembly module shipped inside their main JavaScript bundle.

### Extracting the WASM
The WASM is embedded inside one of Sketchfab's core JS bundles (e.g., `ea48ef38...-v2.js`).
```javascript
// 1. Fetch the JS bundle
const res = await fetch("https://static.sketchfab.com/static/builds/web/dist/ea48ef388b3819bb685ec4de2633e165-v2.js");
const text = await res.text();

// 2. Locate the obfuscated worker module ('kbo/')
let pos = text.indexOf('"kbo/":'); 
let moduleText = text.substring(pos, pos + 800000);

// 3. Extract the base64 WASM binary string (starts with '\0asm' in base64)
let wasmIdx = moduleText.indexOf('"AGFzbQ');
let wasmEndIdx = moduleText.indexOf('"', wasmIdx + 7);
let base64Wasm = moduleText.substring(wasmIdx + 1, wasmEndIdx);

// 4. Decode to buffer
let wasmBuf = Buffer.from(base64Wasm, 'base64');
```

### Decrypting the Binaries
The WASM binary is heavily obfuscated. The exported functions are named using base64 encoded strings (like "RickRolled4U"). 

> **CRITICAL**: The WASM memory heap is dynamically offset. You must parse the WASM binary data segments (`sbrk`) to find the initial heap pointer (`h`). Hardcoding memory offsets will result in fatal corruption.

**Full Decryption Example:**
```javascript
const E_k = "6a74e5202122eb8b0e2ee4010cc9a6fba519fee5"; // Static Salt

// 1. Parse initial heap pointer (h) from WASM buffer
let h = 65536;
for (let p, y, I, d = 8; d < wasmBuf.length; d = p) {
    function v() { return wasmBuf[d++] }
    function _() {
        for (var t = d, n = 0, e = 128; 128 & e; d++) n |= (127 & (e = wasmBuf[d])) << 7 * (d - t);
        return n
    }
    if (y = _(), I = _(), p = d + I, y < 0 || y > 11 || I <= 0 || p > wasmBuf.length) break;
    if (6 === y) { _(), v(), v(), _(); let w = _(); _(), h = w }
    if (11 === y) for (let A = _(), Z = 0; Z !== A && d < p; Z++) { v(), _(); _(); _(); let k = _(); d += k }
}

let sbrkOffset = h;
let wasmMemory = new WebAssembly.Memory({ initial: 256, maximum: 8192 });

const wasmModule = await WebAssembly.instantiate(wasmBuf, {
    env: {
        sbrk: (n) => {
            let prev = sbrkOffset;
            sbrkOffset += n;
            let bytesNeeded = sbrkOffset - wasmMemory.buffer.byteLength;
            if (bytesNeeded > 0) wasmMemory.grow(Math.ceil(bytesNeeded / 65536));
            return prev;
        },
        time: () => Math.floor(Date.now() / 1000),
        gettimeofday: () => {},
        abort: () => { throw new Error("WASM abort"); },
        __lock: () => {}, __unlock: () => {},
        memory: wasmMemory
    }
});
const exports = wasmModule.instance.exports;

// 2. Setup Secondary Keys
let o_key = E_k.toLowerCase();
let M_val = 2000, y_val = M_val;
let c_vals = [];
for (let F = 0; F < 10; ++F) {
    let G = parseInt(o_key.slice(4 * F, 4 * F + 4), 16);
    y_val ^= G;
    c_vals.push(G ^ M_val);
    c_vals.push(y_val);
}
let i_val = c_vals[19];
for (let t = 0; t < 10; ++t) i_val ^= c_vals[2 * t];
let u_vals = new Array(10);
for (let t = 0; t < 10; ++t) u_vals[t] = c_vals[2 * t] ^ i_val;

// 3. Initialize "RickRolled4U"
let wasmMemArray = new Uint8Array(wasmMemory.buffer);
let keySetupOffset = exports["Umlja1JvbGxlZDRV"](0, 40);
for (let t = 0; t < 10; ++t) {
    let s_str = u_vals[t].toString(16).padStart(4, "0");
    for (let n = 0; n < s_str.length; ++n) {
        wasmMemArray[keySetupOffset + n + 4 * t] = s_str.charCodeAt(n);
    }
}

// 4. Load the Model's Base64 Key
let b_key_buf = Buffer.from(keyB, 'base64');
exports["mV2ZXIgZ29ubmEgbGV0IHlvdSBkb3duCk5l"](); // never gonna let you down
let keyOffset = exports["dmVyIGdvbm5hIHJ1biBhcm91bmQgYW5kI"](b_key_buf.length); // ver gonna run around and
wasmMemArray = new Uint8Array(wasmMemory.buffer);
for (let r = 0; r < b_key_buf.length; ++r) wasmMemArray[keyOffset + r] = b_key_buf[r];

// 5. Decrypt Chunk by Chunk
exports["GRlc2VydCB5b3UKTmV2ZXIgZ29ubmEgbW"](0); // desert you \n Never gonna m
const encGeo = fs.readFileSync("encrypted_file.binz");
let decryptedChunks = [];

for (let n = 0; n < encGeo.length; n += 10240) {
    let chunkSize = Math.min(10240, encGeo.length - n);
    let inputOffset = exports["heSBnb29kYnllCk5ldmVyIGdvbm5hIHRl"](chunkSize);
    let mem = new Uint8Array(wasmMemory.buffer);
    for (let t = 0; t < chunkSize; ++t) mem[inputOffset + t] = encGeo[n + t];
    
    let hasOutput = exports["GRlc2VydCB5b3UKTmV2ZXIgZ29ubmEgbW"](1);
    while (hasOutput) {
        let outOffset = exports["TmV2ZXIgZ29ubmEgZ2l2ZSB5b3UgdXAKT"]();
        let outLength = exports["bGwgYSBsaWUgYW5kIGh1cnQgeW91Cg"]();
        
        mem = new Uint8Array(wasmMemory.buffer);
        let copied = new Uint8Array(mem.subarray(outOffset, outOffset + outLength));
        decryptedChunks.push(copied);
        
        exports["FrZSB5b3UgY3J5Ck5ldmVyIGdvbm5hIHN"]();
        hasOutput = exports["GRlc2VydCB5b3UKTmV2ZXIgZ29ubmEgbW"](0);
    }
}
```

---

## 3. Parsing the OSGJS Output

Once decrypted, `file.binz` will yield a raw string (or Gzipped buffer) of JSON data representing an `osg.Node` tree. `model_file.binz` will yield the pure binary buffers.

### Finding Geometries
Traverse the JSON tree to find `osg.Geometry` or `osgAnimation.RigGeometry.SourceGeometry` nodes.
```javascript
let attrs = geometryNode.VertexAttributeList;
let vertexConfig = attrs.Vertex; 
// e.g. { UniqueID: 39037, Array: { Int32Array: { File: 'model_file.binz', Size: 8095, Offset: 94396, Encoding: 'varint' } }, ItemSize: 3, ... }
```

### Buffer Extraction
The vertex data is *not* stored inline in the JSON. Instead, they are stored as references to the `model_file.binz` buffer.

> **VARINT ENCODING WARNING**: Sketchfab heavily compresses their buffers. If a buffer in the JSON states `Encoding: 'varint'`, you cannot simply read it using `Buffer.readInt32LE()`. You must decode the delta-encoded varints before the vertices and faces will make mathematical sense!

Once the buffers are decoded, you can build a standard 3D file (`.obj` or `.glb`) by grouping the Vertex (`v`), Normal (`vn`), and Texture (`vt`) arrays alongside the Primitive Faces (`f`).
