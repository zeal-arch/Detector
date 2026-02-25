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
  // YouTube's player.js is wrapped in (function(g){...})(window._yt_player || ...).
  // N-sig functions extracted from inside the IIFE may reference `g` (the parameter).
  // Provide a Proxy-based mock so these references don't throw ReferenceError.
  // The Proxy returns stub functions for unknown properties, preventing
  // "g.YB is not a function" crashes when the bundler misses a dependency.
  const ytPlayerMock = new Proxy(
    {},
    {
      get(target, prop) {
        if (prop in target) return target[prop];
        // Symbol properties and internal JS methods — pass through
        if (typeof prop === "symbol") return undefined;
        // Return a no-op function stub for any unknown property access.
        // This won't produce correct results, but prevents fatal crashes
        // so that validation can detect the transform failed and fall back
        // to the full player.js AST solver (Try 3).
        const stub = function () {
          return undefined;
        };
        console.warn("[Sandbox] Mock g." + String(prop) + " accessed (stub)");
        target[prop] = stub; // cache it for repeated access
        return stub;
      },
      set(target, prop, value) {
        target[prop] = value;
        return true;
      },
    },
  );
  mockWindow._yt_player = ytPlayerMock;
  mockWindow.g = ytPlayerMock;
  // Other common IIFE parameter names YouTube has used historically
  mockWindow.h = new Proxy(
    {},
    {
      get(target, prop) {
        if (prop in target) return target[prop];
        if (typeof prop === "symbol") return undefined;
        const stub = function () {
          return undefined;
        };
        target[prop] = stub;
        return stub;
      },
      set(target, prop, value) {
        target[prop] = value;
        return true;
      },
    },
  );

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
    case "SOLVE_PLAYER":
      handleSolvePlayer(e, id, e.data);
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

// ─── yt-dlp-style full player.js solver ───────────────────────────────────
// Uses meriyah (JS parser) + astring (AST→code) + yt.solver.core.js to:
// 1. Parse the full ~1MB player.js into an AST
// 2. Find n-sig and cipher functions via structural pattern matching
// 3. Inject solver wrappers (_result.n / _result.sig)
// 4. Execute the entire modified player.js via Function()
// 5. Return solved values for each challenge

let preparedPlayerCache = null;
let preparedPlayerUrl = null;

/**
 * Handle the full player.js solver request.
 *
 * @param {MessageEvent} e - The incoming message event.
 * @param {string|number} id - Correlation identifier.
 * @param {Object} data - { playerJs, playerUrl, nChallenges, sigChallenges }
 *   playerJs: full source of YouTube's base.js
 *   playerUrl: URL for cache keying
 *   nChallenges: array of n-sig parameter values to solve
 *   sigChallenges: array of { sig, sp } objects for cipher solving
 */
function handleSolvePlayer(e, id, data) {
  const startTime = performance.now();
  try {
    // Validate that jsc (yt.solver.core.js) is loaded
    if (typeof jsc !== "function") {
      throw new Error("yt.solver.core.js not loaded — jsc is " + typeof jsc);
    }

    const { playerJs, playerUrl, nChallenges, sigChallenges } = data;
    if (!playerJs || typeof playerJs !== "string") {
      throw new Error("No player.js source provided");
    }

    // Build the request in the format jsc() expects
    const requests = [];
    if (nChallenges && nChallenges.length > 0) {
      requests.push({ type: "n", challenges: nChallenges });
    }
    if (sigChallenges && sigChallenges.length > 0) {
      // For sig: yt-dlp sends sequential char strings as challenges.
      // The result is a permutation that tells which indices to pick.
      // Our caller sends actual signature strings, so we pass them directly.
      requests.push({ type: "sig", challenges: sigChallenges });
    }

    if (requests.length === 0) {
      e.source.postMessage(
        { id, nResults: {}, sigResults: {}, cached: false },
        "*",
      );
      return;
    }

    // Check if we have a cached preprocessed player for this URL
    let input;
    if (preparedPlayerCache && preparedPlayerUrl === playerUrl) {
      input = {
        type: "preprocessed",
        preprocessed_player: preparedPlayerCache,
        requests,
      };
      console.log("[Sandbox] Using cached preprocessed player for", playerUrl);
    } else {
      input = {
        type: "player",
        player: playerJs,
        requests,
        output_preprocessed: true,
      };
      console.log(
        "[Sandbox] Preprocessing player.js (",
        playerJs.length,
        "bytes)",
      );
    }

    // Run the solver
    const output = jsc(input);

    if (output.type === "error") {
      throw new Error("Solver error: " + output.error);
    }

    // Cache the preprocessed player for future calls
    if (output.preprocessed_player) {
      preparedPlayerCache = output.preprocessed_player;
      preparedPlayerUrl = playerUrl;
      console.log(
        "[Sandbox] Cached preprocessed player (",
        preparedPlayerCache.length,
        "ch) for",
        playerUrl,
      );
    }

    // Parse responses: map them back to n/sig results
    const nResults = {};
    const sigResults = {};
    let responseIdx = 0;

    if (nChallenges && nChallenges.length > 0) {
      const resp = output.responses[responseIdx++];
      if (resp.type === "result") {
        Object.assign(nResults, resp.data);
      } else {
        console.warn("[Sandbox] N-sig solver error:", resp.error);
      }
    }
    if (sigChallenges && sigChallenges.length > 0) {
      const resp = output.responses[responseIdx++];
      if (resp.type === "result") {
        Object.assign(sigResults, resp.data);
      } else {
        console.warn("[Sandbox] Sig solver error:", resp.error);
      }
    }

    const elapsed = (performance.now() - startTime).toFixed(1);
    console.log(
      `[Sandbox] Solver completed in ${elapsed}ms:`,
      `n=${Object.keys(nResults).length}`,
      `sig=${Object.keys(sigResults).length}`,
      input.type === "preprocessed" ? "(cached)" : "(fresh)",
    );

    e.source.postMessage(
      {
        id,
        nResults,
        sigResults,
        cached: input.type === "preprocessed",
        elapsed: parseFloat(elapsed),
      },
      "*",
    );
  } catch (ex) {
    const elapsed = (performance.now() - startTime).toFixed(1);
    console.error(`[Sandbox] Solver fatal error (${elapsed}ms):`, ex);
    e.source.postMessage(
      {
        id,
        error: ex.message || String(ex),
        nResults: {},
        sigResults: {},
      },
      "*",
    );
  }
}

console.log(
  "[Sandbox] Ready (N-sig + Cipher eval + Player solver)",
  typeof jsc === "function" ? "[jsc OK]" : "[jsc MISSING]",
);
