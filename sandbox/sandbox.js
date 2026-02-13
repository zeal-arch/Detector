const fnCache = new Map();

/**
 * Create a sandboxed, window-like environment suitable for evaluating code in isolation.
 *
 * The returned object mimics a browser global with minimal, deterministic implementations of
 * location, navigator, document, localStorage, sessionStorage, common built-in constructors
 * and globals (e.g., Math, String, Array, Object, JSON), console, timing APIs, and Promise.
 *
 * @returns {Object} A mock `window` object containing:
 *  - `location`, `navigator`, `document` (minimal shapes),
 *  - `localStorage` and `sessionStorage` (simple key/value stores with `getItem`, `setItem`, `removeItem`, `clear`, `length`, and `key`),
 *  - common global constructors and functions (Math, String, Array, Object, Number, Boolean, RegExp, Date, JSON, parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent, atob, btoa),
 *  - `console`, `setTimeout`, `clearTimeout`, `setInterval`, `clearInterval`, and `Promise`,
 *  - aliases `window`, `self`, and `globalThis` pointing to the mock object.
 */
function createMockEnv() {
  const createMockStorage = () => {
    const store = {};
    return {
      getItem: (key) => store[key] || null,
      setItem: (key, value) => {
        store[key] = String(value);
      },
      removeItem: (key) => {
        delete store[key];
      },
      clear: () => {
        for (const k in store) delete store[k];
      },
      get length() {
        return Object.keys(store).length;
      },
      key: (i) => Object.keys(store)[i] || null,
    };
  };

  const mockWindow = {
    location: {
      href: "https://www.youtube.com/",
      hostname: "www.youtube.com",
      protocol: "https:",
    },
    navigator: {
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
    document: {
      createElement: () => ({ style: {} }),
      documentElement: { style: {} },
    },
    localStorage: createMockStorage(),
    sessionStorage: createMockStorage(),
    Math,
    String,
    Array,
    Object,
    Number,
    Boolean,
    RegExp,
    Date,
    JSON,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    encodeURIComponent,
    decodeURIComponent,
    atob,
    btoa,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Promise,
  };
  mockWindow.window = mockWindow;
  mockWindow.self = mockWindow;
  mockWindow.globalThis = mockWindow;
  return mockWindow;
}

window.addEventListener("message", (e) => {
  const { id, action, fnCode, params } = e.data || {};
  if (!id || !action) return;

  switch (action) {
    case "EVAL_NSIG":
      handleEvalNSig(e, id, fnCode, params);
      break;
    case "EVAL_CIPHER":
      handleEvalCipher(e, id, e.data);
      break;
    default:
      break;
  }
});

/**
 * Evaluate a provided N-sig function source against multiple inputs and send the results back to the message sender.
 *
 * Compiles and caches a callable function from `fnCode`, executes it for each value in `params`, and posts a reply to `e.source` containing the `id` and an array of results. On successful execution for an input, the function's string result is used; if execution fails or produces a non-string, the original input is returned. If a fatal error occurs, an error message and the original `params` are posted.
 *
 * @param {MessageEvent} e - The incoming message event whose `source` will receive the reply.
 * @param {string|number} id - Correlation identifier included in the reply message.
 * @param {string} fnCode - Source code of the N-sig function to compile and evaluate.
 * @param {Array<any>} params - Array of inputs to pass to the compiled function; results are collected in order.
 */
function handleEvalNSig(e, id, fnCode, params) {
  try {
    let fn = fnCache.get("nsig:" + fnCode);
    if (!fn) {
      const mockEnv = createMockEnv();

      // Detect bundled IIFE format: (function(){...deps...return func;})()
      // vs plain function format: function(a){...}
      const isBundled = fnCode.trimStart().startsWith("(function()");

      if (isBundled) {
        // yt-dlp bundled: IIFE returns the N-sig function with all deps included
        const wrapped =
          "with(this) { var __nSigFn = " + fnCode + "; return __nSigFn(sig); }";
        fn = new Function("sig", wrapped);
      } else {
        // Plain: single function body
        const wrapped = "with(this) { return (" + fnCode + ")(sig); }";
        fn = new Function("sig", wrapped);
      }
      fn = fn.bind(mockEnv);
      fnCache.set("nsig:" + fnCode, fn);
    }

    const results = [];
    for (const param of params) {
      try {
        const result = fn(param);
        results.push(typeof result === "string" ? result : param);
      } catch (ex) {
        console.warn("[Sandbox] N-sig eval error for param:", ex.message);
        results.push(param);
      }
    }

    e.source.postMessage({ id, results }, "*");
  } catch (ex) {
    console.error("[Sandbox] N-sig fatal error:", ex);
    e.source.postMessage({ id, error: ex.message, results: params }, "*");
  }
}

function handleEvalCipher(e, id, data) {
  const { cipherCode, argName, sigs } = data;
  try {
    let fn = fnCache.get("cipher:" + cipherCode);
    if (!fn) {
      fn = new Function(argName || "a", cipherCode);
      fnCache.set("cipher:" + cipherCode, fn);
    }

    const results = [];
    for (const sig of sigs) {
      try {
        const result = fn(sig);
        results.push(typeof result === "string" ? result : sig);
      } catch (ex) {
        console.warn("[Sandbox] Cipher eval error:", ex.message);
        results.push(sig);
      }
    }

    e.source.postMessage({ id, results }, "*");
  } catch (ex) {
    console.error("[Sandbox] Cipher fatal error:", ex);
    e.source.postMessage({ id, error: ex.message, results: sigs }, "*");
  }
}

console.log("[Sandbox] Ready (N-sig + Cipher eval)");