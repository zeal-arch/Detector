(function () {
  "use strict";

  var MAGIC = "__ytdl_ext__";
  var playerCache = {};
  var TAG = "[YT-DL inject]";

  console.log(
    TAG,
    "Running in hybrid mode (direct global access + code extraction fallback)",
  );

  /**
   * Wait for _yt_player to be populated with a specific property.
   * YouTube loads player.js asynchronously; on fresh navigation the
   * globals may not exist yet when we first try to resolve them.
   * Returns true if the property appeared, false on timeout.
   */
  function waitForYTGlobal(name, timeoutMs) {
    timeoutMs = timeoutMs || 8000;
    return new Promise(function (resolve) {
      // Already available?
      if (resolveYTGlobal(name) !== undefined) {
        return resolve(true);
      }
      var elapsed = 0;
      var interval = 200;
      var timer = setInterval(function () {
        elapsed += interval;
        if (resolveYTGlobal(name) !== undefined) {
          clearInterval(timer);
          resolve(true);
          return;
        }
        if (elapsed >= timeoutMs) {
          clearInterval(timer);
          console.warn(
            TAG,
            "waitForYTGlobal timeout for:",
            name,
            "after",
            timeoutMs,
            "ms",
          );
          resolve(false);
        }
      }, interval);
    });
  }

  /**
   * Try to read player.js source from the browser's performance/resource
   * cache (PerformanceResourceTiming). The script tag for base.js is
   * loaded by YouTube itself — we can use the URL it loaded to fetch from
   * the browser's HTTP cache rather than making a new network request.
   */
  function getPlayerJsUrlFromPage() {
    try {
      // Method 1: Check <script> tags for base.js URL
      var scripts = document.querySelectorAll("script[src]");
      for (var i = 0; i < scripts.length; i++) {
        var src = scripts[i].src || "";
        if (
          src.indexOf("/s/player/") !== -1 &&
          src.indexOf("/base.js") !== -1
        ) {
          return src;
        }
        if (
          src.indexOf("/s/player/") !== -1 &&
          src.indexOf("/player_ias") !== -1
        ) {
          return src;
        }
      }
      // Method 2: Performance resource entries
      if (typeof performance !== "undefined" && performance.getEntriesByType) {
        var resources = performance.getEntriesByType("resource");
        for (var j = 0; j < resources.length; j++) {
          var rName = resources[j].name || "";
          if (
            rName.indexOf("/s/player/") !== -1 &&
            rName.indexOf("/base.js") !== -1
          ) {
            return rName;
          }
        }
      }
    } catch (e) {
      console.warn(TAG, "getPlayerJsUrlFromPage error:", e.message);
    }
    return null;
  }

  function escRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function extractBraceBlock(code, pos) {
    if (code[pos] !== "{") return null;
    var depth = 0,
      inStr = false,
      strCh = "",
      esc = false;
    for (var i = pos; i < code.length && i < pos + 500000; i++) {
      var c = code[i];
      if (esc) {
        esc = false;
        continue;
      }
      if (c === "\\") {
        esc = true;
        continue;
      }
      if (inStr) {
        if (c === strCh) inStr = false;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        inStr = true;
        strCh = c;
        continue;
      }
      if (c === "{") depth++;
      if (c === "}") {
        depth--;
        if (depth === 0) return code.substring(pos, i + 1);
      }
    }
    return null;
  }

  /** Extract bracket-delimited block (for arrays like [...]). */
  function extractBracketBlock(code, pos) {
    if (code[pos] !== "[") return null;
    var depth = 0,
      inStr = false,
      strCh = "",
      esc = false;
    for (var i = pos; i < code.length && i < pos + 500000; i++) {
      var c = code[i];
      if (esc) {
        esc = false;
        continue;
      }
      if (c === "\\") {
        esc = true;
        continue;
      }
      if (inStr) {
        if (c === strCh) inStr = false;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        inStr = true;
        strCh = c;
        continue;
      }
      if (c === "[") depth++;
      if (c === "]") {
        depth--;
        if (depth === 0) return code.substring(pos, i + 1);
      }
    }
    return null;
  }

  /**
   * Resolve a name from YouTube's global scope.
   * Checks window[name] first, then _yt_player[name].
   * YouTube 2025+ defines most player globals inside _yt_player namespace.
   */
  function resolveYTGlobal(name) {
    if (typeof name !== "string" || !name) return undefined;
    // Direct window global (legacy)
    try {
      if (typeof window[name] !== "undefined" && window[name] !== null) {
        return window[name];
      }
    } catch (e) {}
    // _yt_player namespace (2025+ architecture)
    try {
      if (
        typeof _yt_player !== "undefined" &&
        _yt_player &&
        typeof _yt_player[name] !== "undefined" &&
        _yt_player[name] !== null
      ) {
        return _yt_player[name];
      }
    } catch (e) {}
    // window._yt_player fallback
    try {
      if (
        window._yt_player &&
        typeof window._yt_player[name] !== "undefined" &&
        window._yt_player[name] !== null
      ) {
        return window._yt_player[name];
      }
    } catch (e) {}
    return undefined;
  }

  /**
   * Check whether a variable name is exported to `_yt_player` (a.k.a. `g`)
   * inside the player.js IIFE.  Variables assigned via `g.NAME = ...` become
   * properties of `_yt_player` and are accessible from the page.  Variables
   * declared with `var NAME = ...` inside the IIFE are closure-local and will
   * NEVER appear on `_yt_player` or `window`.
   *
   * Returns true if exported, false if closure-local / not found.
   */
  function isExportedToYTPlayer(js, name) {
    if (!name) return false;
    var esc = escRe(name);
    // g.NAME = ... (common in player IIFE that receives _yt_player as g)
    if (new RegExp("[;,}\\n]\\s*g\\s*\\." + esc + "\\s*=").test(js))
      return true;
    // _yt_player.NAME = ... (outside IIFE, e.g. inline <script>)
    if (new RegExp("_yt_player\\s*\\." + esc + "\\s*=").test(js)) return true;
    return false;
  }

  /**
   * Find external dependency names from player.js code.
   * YouTube 2025+ splits key functions between player.js (base.js) and inline scripts.
   * The cipher helper (e.g., eO) and N-sig wrapper (e.g., R8K) are defined as
   * properties of _yt_player (or global variables) in inline <script> tags,
   * then referenced inside the player IIFE.
   */
  function findExternalDeps(js) {
    var result = {
      cipherHelper: null,
      cipherOps: [],
      cipherDispatchValue: null,
      nSigWrapper: null,
      lookupArray: null,
      lookupName: null,
    };

    // Find the lookup array: var NAME = "...".split("DELIM") with 50+ elements
    // Support both single and double-quoted strings (YouTube 2025+ uses single quotes)
    // Use alternation since single-quoted strings may contain " and vice versa
    var lookupRe =
      /(?:var\s+|[;,]\s*)([a-zA-Z0-9$_]+)\s*=\s*(?:"([^"]{200,})"|'([^']{200,})')\s*\.\s*split\s*\(\s*(?:"([^"]+)"|'([^']+)')\s*\)/g;
    var lm;
    while ((lm = lookupRe.exec(js)) !== null) {
      var lookupStr = lm[2] || lm[3];
      var lookupDelim = lm[4] || lm[5];
      var parts = lookupStr.split(lookupDelim);
      if (parts.length > 50) {
        result.lookupName = lm[1];
        result.lookupArray = parts;
        break;
      }
    }
    if (!result.lookupArray) return result;

    // Find dispatch cipher call: funcName(N, decodeURIComponent(p.s))
    var dispatchCall = js.match(
      /=\s*([a-zA-Z0-9$_]+)\s*\(\s*(\d+)\s*,\s*decodeURIComponent\s*\(\s*\w+\.\s*s\s*\)\s*\)/,
    );
    if (dispatchCall) {
      var cipherFuncName = dispatchCall[1];
      result.cipherDispatchValue = parseInt(dispatchCall[2]);

      // Find the RIGHT definition of cipherFuncName — there may be
      // multiple functions with the same short name (e.g., "is").
      // The real cipher function has 2+ params and lookup array refs.
      var cipherFuncBody = findCipherFuncDef(
        js,
        cipherFuncName,
        result.lookupName,
      );
      if (cipherFuncBody) {
        // Find helper references: HELPER[LOOKUP[IDX]](ARRAY, NUM)
        var le = escRe(result.lookupName);
        var helperRe = new RegExp(
          "([a-zA-Z0-9$_]+)\\[" +
            le +
            "\\[(\\d+)\\]\\]\\s*\\(\\s*([a-zA-Z0-9$_]+)\\s*,\\s*(\\d+)\\s*\\)",
          "g",
        );
        var hm;
        while ((hm = helperRe.exec(cipherFuncBody)) !== null) {
          if (!result.cipherHelper) result.cipherHelper = hm[1];
          result.cipherOps.push({
            methodName: result.lookupArray[parseInt(hm[2])],
            arg: parseInt(hm[4]),
          });
        }
      }
    }

    // Find N-sig wrapper:
    // Look for WRAPPER[0](x) near a .set("n" or lookup[nIdx] context
    var nIdx = result.lookupArray.indexOf("n");
    var setIdx = result.lookupArray.indexOf("set");
    var ln = result.lookupName; // actual lookup array name (e.g. "f")
    if (nIdx !== -1 && setIdx !== -1) {
      // Search for: WRAPPER[0](VAR) near the n-sig code block
      var wrapperRe = /([a-zA-Z0-9$_]+)\[0\]\s*\(\s*(\w+)\s*\)/g;
      var wm;
      while ((wm = wrapperRe.exec(js)) !== null) {
        var ctx = js.substring(
          Math.max(0, wm.index - 200),
          Math.min(js.length, wm.index + 300),
        );
        // Check context for lookup[nIdx] OR literal "n" near .get/.set
        if (
          ctx.indexOf(ln + "[" + nIdx + "]") !== -1 ||
          ctx.indexOf('"n"') !== -1 ||
          ctx.indexOf(".get(" + ln + "[") !== -1
        ) {
          result.nSigWrapper = wm[1];
          console.log(TAG, "N-sig wrapper found:", wm[1]);
          break;
        }
      }
    }

    // Fallback: search for direct function call near .get("n")
    if (!result.nSigWrapper && nIdx !== -1) {
      // Pattern: .get("n")...FUNC(VAR) or .get(ln[nIdx])...FUNC(VAR)
      var nSigCallRe =
        /\.get\s*\(\s*(?:"n"|'n')\s*\).*?([a-zA-Z0-9$_]+)\s*\(\s*([a-zA-Z0-9$_]+)\s*\)/g;
      var ncm;
      while ((ncm = nSigCallRe.exec(js)) !== null) {
        var callCtx = js.substring(
          Math.max(0, ncm.index),
          Math.min(js.length, ncm.index + 500),
        );
        // Must also have .set("n" or [ln[setIdx]] nearby
        if (
          callCtx.indexOf('"n"') !== -1 &&
          (callCtx.indexOf(".set(") !== -1 ||
            callCtx.indexOf(ln + "[" + setIdx + "]") !== -1)
        ) {
          // Check if the candidate is an array wrapper [0] or direct func
          var candidateName = ncm[1];
          // Skip JS keywords and builtins (but NOT single-letter names —
          // YouTube minification uses them as valid wrapper names)
          if (
            /^(new|if|for|while|return|var|let|const|Math|String|Array|Object|Number|JSON|Boolean)$/.test(
              candidateName,
            )
          )
            continue;
          // Check if it's an array wrapper
          var arrCheck = js.match(
            new RegExp("[;,\\n]\\s*" + escRe(candidateName) + "\\s*=\\s*\\["),
          );
          if (arrCheck) {
            result.nSigWrapper = candidateName;
            console.log(
              TAG,
              "N-sig wrapper found (array, via .get n):",
              candidateName,
            );
          } else {
            // Could be a direct function
            result.nSigWrapper = candidateName;
            console.log(
              TAG,
              "N-sig function found (direct, via .get n):",
              candidateName,
            );
          }
          break;
        }
      }
    }

    console.log(
      TAG,
      "External deps — cipher helper:",
      result.cipherHelper || "none",
      "| ops:",
      result.cipherOps.length,
      "| N-sig wrapper:",
      result.nSigWrapper || "none",
    );

    // DIAGNOSTIC: Extended dump for debugging
    if (result.lookupArray) {
      console.log(
        TAG,
        "[DIAG] Lookup array name:",
        result.lookupName,
        "length:",
        result.lookupArray.length,
      );
      console.log(
        TAG,
        "[DIAG] Lookup first 10:",
        result.lookupArray.slice(0, 10),
      );
      console.log(
        TAG,
        "[DIAG] Lookup 'n' at:",
        result.lookupArray.indexOf("n"),
        "'set' at:",
        result.lookupArray.indexOf("set"),
        "'get' at:",
        result.lookupArray.indexOf("get"),
      );
    }
    if (result.cipherHelper) {
      var chResolved = resolveYTGlobal(result.cipherHelper);
      console.log(
        TAG,
        "[DIAG] Cipher helper:",
        result.cipherHelper,
        "| window:",
        typeof window[result.cipherHelper],
        "| _yt_player:",
        typeof (window._yt_player || {})[result.cipherHelper],
        "| resolved:",
        typeof chResolved,
      );
      if (chResolved && typeof chResolved === "object") {
        try {
          console.log(
            TAG,
            "[DIAG] Cipher helper methods:",
            Object.keys(chResolved),
          );
        } catch (e) {}
      }
    } else {
      console.log(
        TAG,
        "[DIAG] No cipher helper found. Dispatch call match exists?",
        !!result.cipherDispatchValue,
      );
    }
    if (result.nSigWrapper) {
      var nwResolved = resolveYTGlobal(result.nSigWrapper);
      console.log(
        TAG,
        "[DIAG] N-sig wrapper:",
        result.nSigWrapper,
        "| window:",
        typeof window[result.nSigWrapper],
        "| _yt_player:",
        typeof (window._yt_player || {})[result.nSigWrapper],
        "| resolved:",
        typeof nwResolved,
      );
      if (nwResolved && Array.isArray(nwResolved)) {
        console.log(
          TAG,
          "[DIAG] N-sig wrapper length:",
          nwResolved.length,
          "[0] type:",
          typeof nwResolved[0],
        );
      }
    } else {
      console.log(TAG, "[DIAG] No N-sig wrapper found via lookup pattern.");
      // DIAGNOSTIC: wider context around .get("n") to see N-sig call structure
      var getNWide = js.match(/.{0,50}\.get\s*\(\s*["']n["']\s*\).{0,300}/g);
      if (getNWide) {
        console.log(TAG, "[DIAG] .get('n') wide context (first):", getNWide[0]);
      }
      // Also search for XXX[0]( patterns near "n" to find wrapper candidates
      var arr0Near = js.match(
        /.{0,80}([a-zA-Z0-9$_]+)\[0\]\s*\(\s*\w+\s*\).{0,80}/g,
      );
      if (arr0Near) {
        var nRelated = arr0Near.filter(function (s) {
          return (
            s.indexOf('"n"') !== -1 || s.indexOf(ln + "[" + nIdx + "]") !== -1
          );
        });
        console.log(
          TAG,
          "[DIAG] XXX[0]() near 'n':",
          nRelated.length > 0 ? nRelated.slice(0, 3) : "none found",
        );
      }
    }

    return result;
  }

  /**
   * Classify a cipher helper method by testing it with known input.
   * The classic YouTube cipher uses three operations:
   *   - reverse: reverses the array
   *   - splice: removes first N elements
   *   - swap: swaps element 0 with element at position N % length
   */
  function classifyCipherMethod(method) {
    try {
      var test = ["A", "B", "C", "D", "E", "F", "G", "H"];
      var a = test.slice();
      method(a, 3);
      if (a.length < test.length) {
        // Distinguish splice (mutates in-place) from slice (returns new)
        // splice: a is now shorter; slice: a unchanged but result is shorter
        return "splice";
      }
      if (a[0] === test[3] && a[3] === test[0]) return "swap";
      if (a[0] === test[test.length - 1]) return "reverse";
      // Check for slice: method returns a new array starting at index N
      var c = test.slice();
      var sliceResult = method(c, 3);
      if (
        Array.isArray(sliceResult) &&
        sliceResult.length === test.length - 3 &&
        sliceResult[0] === test[3]
      ) {
        return "slice";
      }
      // Try with different arg to distinguish swap from reverse
      var b = test.slice();
      method(b, 1);
      if (b[0] === test[1] && b[1] === test[0]) return "swap";
      if (b[0] === test[test.length - 1]) return "reverse";
      return "unknown";
    } catch (e) {
      return "unknown";
    }
  }

  /**
   * Build cipher action list by accessing the global cipher helper object
   * and classify each method. Returns action list compatible with applyCipher().
   */
  function buildCipherActionsFromGlobal(helperName, ops) {
    try {
      var helper = resolveYTGlobal(helperName);
      if (!helper || typeof helper !== "object") {
        console.warn(
          TAG,
          "Cipher helper not found as global or _yt_player property:",
          helperName,
        );
        return null;
      }
      console.log(
        TAG,
        "Cipher helper resolved:",
        helperName,
        "(source:",
        window[helperName] ? "window" : "_yt_player",
        ")",
      );

      var actions = [];
      var methodTypes = {};
      for (var i = 0; i < ops.length; i++) {
        var op = ops[i];
        var method = helper[op.methodName];
        if (typeof method !== "function") {
          console.warn(TAG, "Cipher method not a function:", op.methodName);
          return null;
        }
        if (!methodTypes[op.methodName]) {
          methodTypes[op.methodName] = classifyCipherMethod(method);
        }
        var type = methodTypes[op.methodName];
        if (type === "unknown") {
          console.warn(TAG, "Could not classify cipher method:", op.methodName);
          return null;
        }
        actions.push([type, type === "reverse" ? null : op.arg]);
      }

      console.log(
        TAG,
        "Cipher actions from global:",
        actions
          .map(function (a) {
            return a[0] + (a[1] != null ? "(" + a[1] + ")" : "");
          })
          .join(", "),
      );
      return actions;
    } catch (e) {
      console.warn(TAG, "buildCipherActionsFromGlobal error:", e.message);
      return null;
    }
  }

  /**
   * Apply cipher action list to a signature string.
   */
  function applyCipherActions(actions, sig) {
    var a = sig.split("");
    for (var i = 0; i < actions.length; i++) {
      var op = actions[i][0];
      var n = actions[i][1];
      switch (op) {
        case "reverse":
          a.reverse();
          break;
        case "splice":
          a.splice(0, n);
          break;
        case "swap":
          var t = a[0];
          a[0] = a[n % a.length];
          a[n % a.length] = t;
          break;
        case "slice":
          a = a.slice(n);
          break;
      }
    }
    return a.join("");
  }

  /**
   * Get the N-sig transform function by accessing the global wrapper.
   * YouTube stores it in a global array like R8K = [transformFunc].
   */
  function getNSigFromGlobal(wrapperName) {
    try {
      var wrapper = resolveYTGlobal(wrapperName);
      if (
        wrapper &&
        Array.isArray(wrapper) &&
        typeof wrapper[0] === "function"
      ) {
        console.log(
          TAG,
          "N-sig function found via:",
          wrapperName,
          "(source:",
          window[wrapperName] ? "window" : "_yt_player",
          ")",
        );
        return wrapper[0];
      }
      // Also check if it's a direct function (not wrapped in array)
      if (wrapper && typeof wrapper === "function") {
        console.log(
          TAG,
          "N-sig found as direct function (not array wrapped):",
          wrapperName,
        );
        return wrapper;
      }
      console.warn(
        TAG,
        "N-sig wrapper not found or invalid:",
        wrapperName,
        "| window[",
        wrapperName,
        "]:",
        typeof window[wrapperName],
        "| _yt_player[",
        wrapperName,
        "]:",
        typeof (window._yt_player || {})[wrapperName],
      );
      return null;
    } catch (e) {
      console.warn(TAG, "getNSigFromGlobal error:", e.message);
      return null;
    }
  }

  /**
   * Extract cipher helper definition from inline <script> tags on the page.
   * Used as fallback when direct global access is available but we also
   * need to send the code to background.js for Tier 2/3 use.
   */
  function extractCipherHelperFromPage(helperName) {
    try {
      var scripts = document.querySelectorAll("script:not([src])");
      var hEsc = escRe(helperName);
      for (var i = 0; i < scripts.length; i++) {
        var text = scripts[i].textContent;
        if (!text || text.length < 10) continue;

        // Look for: var HELPER = { ... } or HELPER = { ... }
        var re = new RegExp("(?:var\\s+)?" + hEsc + "\\s*=\\s*\\{");
        var m = re.exec(text);
        if (m) {
          var braceIdx = m.index + m[0].lastIndexOf("{");
          var block = extractBraceBlock(text, braceIdx);
          if (block) {
            return "var " + helperName + "=" + block + ";";
          }
        }

        // Also look for _yt_player.HELPER = { ... } or g.HELPER = { ... }
        var nsRe = new RegExp(
          "(?:_yt_player|g)\\s*\\.\\s*" + hEsc + "\\s*=\\s*\\{",
        );
        var nsm = nsRe.exec(text);
        if (nsm) {
          var nsBraceIdx = nsm.index + nsm[0].lastIndexOf("{");
          var nsBlock = extractBraceBlock(text, nsBraceIdx);
          if (nsBlock) {
            return "var " + helperName + "=" + nsBlock + ";";
          }
        }
      }
    } catch (e) {
      console.warn(TAG, "extractCipherHelperFromPage error:", e.message);
    }
    return null;
  }

  /**
   * Extract N-sig wrapper definition from inline <script> tags.
   * Used as fallback for sending N-sig code to background.js.
   */
  function extractNSigWrapperFromPage(wrapperName) {
    try {
      var scripts = document.querySelectorAll("script:not([src])");
      var wEsc = escRe(wrapperName);
      for (var i = 0; i < scripts.length; i++) {
        var text = scripts[i].textContent;
        if (!text || text.length < 10) continue;

        var re = new RegExp("(?:var\\s+)?" + wEsc + "\\s*=\\s*\\[");
        var m = re.exec(text);
        if (m) {
          var bracketIdx = m.index + m[0].lastIndexOf("[");
          var block = extractBracketBlock(text, bracketIdx);
          if (block) {
            return "var " + wrapperName + "=" + block + ";";
          }
        }

        // Also look for _yt_player.WRAPPER = [ ... ] or g.WRAPPER = [ ... ]
        var nsRe = new RegExp(
          "(?:_yt_player|g)\\s*\\.\\s*" + wEsc + "\\s*=\\s*\\[",
        );
        var nsm = nsRe.exec(text);
        if (nsm) {
          var nsBracketIdx = nsm.index + nsm[0].lastIndexOf("[");
          var nsBlock = extractBracketBlock(text, nsBracketIdx);
          if (nsBlock) {
            return "var " + wrapperName + "=" + nsBlock + ";";
          }
        }
      }
    } catch (e) {
      console.warn(TAG, "extractNSigWrapperFromPage error:", e.message);
    }
    return null;
  }

  function extractPageData() {
    var data = {};

    try {
      if (
        typeof ytInitialPlayerResponse !== "undefined" &&
        ytInitialPlayerResponse
      ) {
        data.playerResponse = ytInitialPlayerResponse;
      }
    } catch (e) {}

    try {
      var player = document.getElementById("movie_player");
      if (player) {
        if (player.getPlayerResponse) {
          var pr = player.getPlayerResponse();
          if (pr && pr.streamingData) data.playerResponse = pr;
        }
        if (player.getVideoData) {
          var vd = player.getVideoData();
          if (vd && vd.video_id) data.videoId = vd.video_id;
        }
      }
    } catch (e) {}

    try {
      if (typeof ytcfg !== "undefined" && ytcfg.get) {
        data.playerUrl = ytcfg.get("PLAYER_JS_URL") || null;
        data.visitorData = ytcfg.get("VISITOR_DATA") || null;
        data.sts = ytcfg.get("STS") || null;
        data.apiKey = ytcfg.get("INNERTUBE_API_KEY") || null;
        data.clientVersion = ytcfg.get("INNERTUBE_CLIENT_VERSION") || null;
        var loggedInVal = ytcfg.get("LOGGED_IN");
        if (typeof loggedInVal === "boolean") {
          data.loggedIn = loggedInVal;
        }
      }
    } catch (e) {}

    try {
      if (typeof ytcfg !== "undefined" && ytcfg.data_) {
        data.playerUrl = data.playerUrl || ytcfg.data_.PLAYER_JS_URL || null;
        data.visitorData = data.visitorData || ytcfg.data_.VISITOR_DATA || null;
      }
    } catch (e) {}

    try {
      if (typeof ytcfg !== "undefined" && ytcfg.get) {
        var cfg = ytcfg.get("WEB_PLAYER_CONTEXT_CONFIGS");
        if (cfg) {
          var wc =
            cfg.WEB_PLAYER_CONTEXT_CONFIG_ID_KEVLAR_WATCH ||
            cfg.WEB_PLAYER_CONTEXT_CONFIG_ID_KEVLAR_SHORTS;
          if (wc) {
            data.playerUrl = data.playerUrl || wc.jsUrl || null;
            data.sts = data.sts || wc.signatureTimestamp || null;
          }
        }
      }
    } catch (e) {}

    try {
      if (typeof ytplayer !== "undefined" && ytplayer && ytplayer.config) {
        if (ytplayer.config.assets) {
          data.playerUrl = data.playerUrl || ytplayer.config.assets.js || null;
        }
      }
    } catch (e) {}

    try {
      if (typeof yt !== "undefined" && yt && yt.config_) {
        data.visitorData = data.visitorData || yt.config_.VISITOR_DATA || null;
      }
    } catch (e) {}

    if (data.playerUrl && data.playerUrl.indexOf("http") !== 0) {
      data.playerUrl = "https://www.youtube.com" + data.playerUrl;
    }

    return data;
  }

  function fetchPlayerJsXHR(url) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open("GET", url, true);
      xhr.timeout = 15000;
      xhr.onload = function () {
        if (
          xhr.status === 200 &&
          xhr.responseText &&
          xhr.responseText.length > 1000
        ) {
          resolve(xhr.responseText);
        } else if (xhr.status === 200) {
          reject(
            new Error(
              "Player.js XHR response empty or too small (" +
                (xhr.responseText || "").length +
                " bytes)",
            ),
          );
        } else {
          reject(new Error("Player.js HTTP " + xhr.status));
        }
      };
      xhr.onerror = function () {
        reject(new Error("Player.js XHR network error"));
      };
      xhr.ontimeout = function () {
        reject(new Error("Player.js XHR timeout"));
      };
      xhr.send();
    });
  }

  function fetchPlayerJsFetch(url) {
    return fetch(url, { credentials: "omit", cache: "force-cache" })
      .then(function (resp) {
        if (!resp.ok) throw new Error("Player.js fetch HTTP " + resp.status);
        return resp.text();
      })
      .then(function (text) {
        if (!text || text.length < 1000) {
          throw new Error(
            "Player.js fetch response empty or too small (" +
              (text || "").length +
              " bytes)",
          );
        }
        return text;
      });
  }

  /**
   * Request player.js content from background.js via content script relay.
   * This bypasses YouTube's service worker which blocks in-page XHR/fetch.
   * inject.js (MAIN) → postMessage → content.js (ISOLATED) → chrome.runtime.sendMessage → background.js
   */
  function fetchPlayerJsViaBackground(url) {
    return new Promise(function (resolve, reject) {
      var requestId = "__ytdl_fetch_" + Date.now() + "_" + Math.random();
      var timeout = setTimeout(function () {
        window.removeEventListener("message", handler);
        reject(new Error("Player.js background relay timeout (10s)"));
      }, 10000);

      function handler(e) {
        if (
          e.data &&
          e.data.type === MAGIC + "_fetch_response" &&
          e.data.requestId === requestId
        ) {
          window.removeEventListener("message", handler);
          clearTimeout(timeout);
          if (e.data.error) {
            reject(new Error("Background fetch: " + e.data.error));
          } else if (e.data.text && e.data.text.length > 1000) {
            resolve(e.data.text);
          } else {
            reject(
              new Error(
                "Background fetch response too small (" +
                  (e.data.text || "").length +
                  " bytes)",
              ),
            );
          }
        }
      }

      window.addEventListener("message", handler);
      window.postMessage(
        {
          type: MAGIC + "_fetch_request",
          requestId: requestId,
          url: url,
        },
        window.location.origin,
      );
    });
  }

  async function fetchPlayerJs(url) {
    var maxRetries = 5;
    var lastErr = null;

    for (var attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (attempt === 1) {
          // Attempt 1: fetch() with force-cache (fastest, avoids network)
          return await fetchPlayerJsFetch(url);
        } else if (attempt === 2) {
          // Attempt 2: fetch() with no-cache (bypass stale cache)
          console.log(
            TAG,
            "Trying fetch() API with no-cache for player.js (attempt " +
              attempt +
              ")",
          );
          return await fetch(url, { credentials: "omit", cache: "no-cache" })
            .then(function (resp) {
              if (!resp.ok)
                throw new Error("Player.js fetch HTTP " + resp.status);
              return resp.text();
            })
            .then(function (text) {
              if (!text || text.length < 1000) {
                throw new Error(
                  "Player.js no-cache response empty or too small (" +
                    (text || "").length +
                    " bytes)",
                );
              }
              return text;
            });
        } else if (attempt === 3) {
          // Attempt 3: XHR (may fail due to YouTube service worker)
          return await fetchPlayerJsXHR(url);
        } else if (attempt === 4) {
          // Attempt 4: fetch() with cache: "reload" (force fresh)
          console.log(
            TAG,
            "Trying fetch() with cache reload for player.js (attempt " +
              attempt +
              ")",
          );
          return await fetch(url, { credentials: "omit", cache: "reload" })
            .then(function (resp) {
              if (!resp.ok)
                throw new Error("Player.js fetch HTTP " + resp.status);
              return resp.text();
            })
            .then(function (text) {
              if (!text || text.length < 1000) {
                throw new Error(
                  "Player.js reload response empty or too small (" +
                    (text || "").length +
                    " bytes)",
                );
              }
              return text;
            });
        } else {
          // Attempt 5: Relay through background.js service worker
          // Background.js is not affected by YouTube's page service worker
          console.log(
            TAG,
            "Trying background.js relay for player.js (attempt " +
              attempt +
              ")",
          );
          return await fetchPlayerJsViaBackground(url);
        }
      } catch (e) {
        lastErr = e;
        console.warn(
          TAG,
          "Player.js fetch attempt " + attempt + "/" + maxRetries + " failed:",
          e.message,
        );
        if (attempt < maxRetries) {
          await new Promise(function (r) {
            setTimeout(r, 500 * attempt);
          });
        }
      }
    }

    throw (
      lastErr ||
      new Error("Player.js fetch failed after " + maxRetries + " attempts")
    );
  }

  /**
   * Find the CORRECT definition of a cipher function by name.
   * Short names like "is" can have multiple definitions in player.js.
   * The real cipher function:
   *   - Has 2 params (dispatchValue, signature)
   *   - Has a body > 100 chars
   *   - Contains lookup array references (e.g. f[N])
   * Returns the function body block (including braces) or null.
   */
  function findCipherFuncDef(js, funcName, lookupName) {
    var esc = escRe(funcName);
    var defRe = new RegExp(esc + "\\s*=\\s*function\\s*\\(([^)]*)\\)", "g");
    var dm;
    var candidates = [];

    while ((dm = defRe.exec(js)) !== null) {
      var params = dm[1].split(",").map(function (p) {
        return p.trim();
      });
      var braceIdx = js.indexOf("{", dm.index + dm[0].length - 1);
      if (braceIdx === -1) continue;
      var body = extractBraceBlock(js, braceIdx);
      if (!body) continue;

      candidates.push({
        params: params,
        body: body,
        bodyLen: body.length,
        hasLookup: lookupName ? body.indexOf(lookupName + "[") !== -1 : false,
        idx: dm.index,
      });
    }

    console.log(
      TAG,
      "[DIAG] Cipher '" + funcName + "' definitions found:",
      candidates.length,
      candidates.map(function (c) {
        return (
          "params=" +
          c.params.length +
          " body=" +
          c.bodyLen +
          " lookup=" +
          c.hasLookup
        );
      }),
    );

    // Priority: 2+ params with lookup array references, largest body
    var best = null;
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      if (c.params.length >= 2 && c.hasLookup) {
        if (!best || c.bodyLen > best.bodyLen) best = c;
      }
    }
    // Fallback: 2+ params, largest body
    if (!best) {
      for (var j = 0; j < candidates.length; j++) {
        var c2 = candidates[j];
        if (c2.params.length >= 2 && c2.bodyLen > 100) {
          if (!best || c2.bodyLen > best.bodyLen) best = c2;
        }
      }
    }
    // Last resort: largest body with lookup refs
    if (!best) {
      for (var k = 0; k < candidates.length; k++) {
        var c3 = candidates[k];
        if (c3.hasLookup && c3.bodyLen > 100) {
          if (!best || c3.bodyLen > best.bodyLen) best = c3;
        }
      }
    }

    if (best) {
      console.log(
        TAG,
        "Cipher func def resolved:",
        funcName,
        "params=" + best.params.length,
        "body=" + best.bodyLen + "ch",
        "lookup=" + best.hasLookup,
      );
      return best.body;
    }

    console.warn(
      TAG,
      "No suitable cipher function definition found for:",
      funcName,
    );
    return null;
  }

  function findCipherFunctionName(js) {
    var patterns = [
      /\b[cs]\s*&&\s*[adf]\.set\([^,]+\s*,\s*encodeURIComponent\(([a-zA-Z0-9$]+)\(/,
      /\b[a-zA-Z0-9]+\s*&&\s*[a-zA-Z0-9]+\.set\([^,]+\s*,\s*encodeURIComponent\(([a-zA-Z0-9$]+)\(/,
      /\bm=([a-zA-Z0-9$]{2,})\(decodeURIComponent\(h\.s\)\)/,
      /\bc\s*&&\s*d\.set\([^,]+\s*,\s*(?:encodeURIComponent\s*\()([a-zA-Z0-9$]+)\(/,
      /\bc\s*&&\s*[a-z]\.set\([^,]+\s*,\s*([a-zA-Z0-9$]+)\(/,
      /\bc\s*&&\s*[a-z]\.set\([^,]+\s*,\s*encodeURIComponent\(([a-zA-Z0-9$]+)\(/,
      /\.sig\|\|([a-zA-Z0-9$]+)\(/,
      /yt\.akamaized\.net\/\)\s*\|\|\s*.*?\s*[cs]\s*&&\s*[adf]\.set\([^,]+\s*,\s*(?:encodeURIComponent\s*\()?([a-zA-Z0-9$]+)\(/,
      /\b[a-zA-Z_0-9$]+\s*&&\s*\w+\.set\([^,]+\s*,\s*encodeURIComponent\(([a-zA-Z_0-9$]+)\(/,
      /[$_a-zA-Z0-9]+\.set\((?:[$_a-zA-Z0-9]+\.[$_a-zA-Z0-9]+\|\|)?"signature",\s*([$_a-zA-Z0-9]+)\s*\(/,
      /\.set\([^,]+,encodeURIComponent\(([a-zA-Z0-9$]+)\(/,
      /=([a-zA-Z0-9$]{2,})\(decodeURIComponent\(\w+\.s\)\)/,
      /&&\(\w+=([a-zA-Z0-9$]+)\(["'][^"']*["'],decodeURIComponent/,
      /&&\(\w+=([a-zA-Z0-9$]+)\(decodeURIComponent/,
      /\.set\("signature",\s*([a-zA-Z0-9$]+)\(/,
      /\.set\([^,]+,\s*([a-zA-Z0-9$]{2,})\(decodeURIComponent/,
      // 2025+ dispatch cipher: funcName(NUMBER, decodeURIComponent(*.s))
      /=([a-zA-Z0-9$]{2,})\(\d+\s*,\s*decodeURIComponent\(\w+\.s\)\)/,
    ];

    for (var i = 0; i < patterns.length; i++) {
      var m = js.match(patterns[i]);
      if (m && m[1]) {
        console.log(TAG, "Cipher function found with pattern", i, ":", m[1]);
        return m[1];
      }
    }

    // Fallback: find by split("") or split('') pattern
    var splitJoinPatterns = [
      /(?:^|[;,\n])\s*([a-zA-Z0-9$_]+)\s*=\s*function\s*\((\w+)\)\s*\{\s*\2\s*=\s*\2\.split\(\s*(?:""|'')\s*\)/m,
      /(?:^|[;,\n])\s*([a-zA-Z0-9$_]+)\s*=\s*\((\w+)\)\s*=>\s*\{\s*\2\s*=\s*\2\.split\(\s*(?:""|'')\s*\)/m,
      /(?:^|[;,\n])\s*([a-zA-Z0-9$_]+)\s*=\s*(\w+)\s*=>\s*\{\s*\2\s*=\s*\2\.split\(\s*(?:""|'')\s*\)/m,
    ];
    for (var j = 0; j < splitJoinPatterns.length; j++) {
      var m = js.match(splitJoinPatterns[j]);
      if (m) {
        console.log(
          TAG,
          "Cipher function found via split/join fallback:",
          m[1],
        );
        return m[1];
      }
    }

    var sigTransform = /\.s\)\)&&\([\w\.$]+\s*=\s*([a-zA-Z0-9$]+)\(/;
    m = js.match(sigTransform);
    if (m && m[1]) {
      console.log(TAG, "Cipher function found via signature transform:", m[1]);
      return m[1];
    }

    return null;
  }

  function extractDispatchCipher(js) {
    // New-style dispatch cipher (2025+): funcName(dispatchValue, decodeURIComponent(p.s))
    var callMatch = js.match(
      /=\s*([a-zA-Z0-9$_]+)\s*\(\s*(\d+)\s*,\s*decodeURIComponent\s*\(\s*\w+\.\s*s\s*\)\s*\)/,
    );
    if (!callMatch) {
      // DIAGNOSTIC: look for any decodeURIComponent(*.s) patterns to see what YT uses now
      var decodePatterns = js.match(
        /=\s*([a-zA-Z0-9$_]+)\s*\([^,]*decodeURIComponent\s*\([^)]*\.\s*s\s*\)/g,
      );
      console.log(
        TAG,
        "[DIAG] No dispatch cipher call found. decodeURIComponent(*.s) patterns:",
        decodePatterns ? decodePatterns.slice(0, 5) : "none",
      );
      // Also look for encodeURIComponent patterns near signature
      var encPatterns = js.match(
        /encodeURIComponent\s*\(\s*([a-zA-Z0-9$_]+)\s*\(/g,
      );
      console.log(
        TAG,
        "[DIAG] encodeURIComponent(func()) patterns:",
        encPatterns ? encPatterns.slice(0, 5) : "none",
      );
      return null;
    }
    var cipherFuncName = callMatch[1];
    var dispatchValue = callMatch[2];
    console.log(
      TAG,
      "[DIAG] Dispatch cipher call found:",
      cipherFuncName,
      "(",
      dispatchValue,
      ", decodeURIComponent(...))",
    );

    // Find lookup array: var NAME = "...".split("DELIM") or '...'.split(';') with 50+ elements
    // Support both single and double-quoted strings (YouTube 2025+ uses single quotes)
    // Use alternation since single-quoted strings may contain " and vice versa
    var lookupArrayRe =
      /(?:var\s+|[;,]\s*)([a-zA-Z0-9$_]+)\s*=\s*(?:"([^"]{200,})"|'([^']{200,})')\s*\.\s*split\s*\(\s*(?:"([^"]+)"|'([^']+)')\s*\)/g;
    var lookupMatch = null;
    var lookupName = null;
    var lookupRaw = null;
    var lookupDelim = null;
    var lm;
    while ((lm = lookupArrayRe.exec(js)) !== null) {
      var lookupStr = lm[2] || lm[3];
      var lookupDlm = lm[4] || lm[5];
      var parts = lookupStr.split(lookupDlm);
      if (parts.length > 50) {
        lookupMatch = lm;
        lookupName = lm[1];
        lookupRaw = lookupStr;
        lookupDelim = lookupDlm;
        break;
      }
    }
    if (!lookupName) return null;

    // Find cipher function definition — disambiguate short names
    var funcBody = findCipherFuncDef(js, cipherFuncName, lookupName);
    if (!funcBody) return null;

    // Get param list from the body
    var paramMatch = funcBody.match(/^\{/);
    // We need the param names from the definition, re-extract them
    var paramNames = [];
    var localVars = [];
    // Scan all definitions to find the one whose body === funcBody
    var defScanRe = new RegExp(
      escRe(cipherFuncName) + "\\s*=\\s*function\\s*\\(([^)]+)\\)",
      "g",
    );
    var dsm;
    while ((dsm = defScanRe.exec(js)) !== null) {
      var dbi = js.indexOf("{", dsm.index + dsm[0].length - 1);
      if (dbi !== -1) {
        var db = extractBraceBlock(js, dbi);
        if (db === funcBody) {
          paramNames = dsm[1].split(",").map(function (p) {
            return p.trim();
          });
          break;
        }
      }
    }

    // Find local variables in function body
    var localVarRe = /(?:var|let|const)\s+([a-zA-Z0-9$_]+)\s*=/g;
    var lvm;
    while ((lvm = localVarRe.exec(funcBody)) !== null) {
      localVars.push(lvm[1]);
    }

    // Names to skip when looking for cipher helper
    var skipNames = {};
    for (var i = 0; i < paramNames.length; i++) skipNames[paramNames[i]] = true;
    for (var j = 0; j < localVars.length; j++) skipNames[localVars[j]] = true;
    // Also skip built-in objects
    skipNames["String"] = true;
    skipNames["Array"] = true;
    skipNames["Math"] = true;
    skipNames["Object"] = true;
    skipNames["Number"] = true;
    skipNames["JSON"] = true;

    // DIAGNOSTIC: dump cipher function structure
    console.log(
      TAG,
      "[DIAG] Cipher func:",
      cipherFuncName,
      "params:",
      paramNames,
      "locals:",
      localVars,
    );
    console.log(TAG, "[DIAG] Cipher body (first 500):", funcBody.slice(0, 500));
    console.log(TAG, "[DIAG] Cipher body (last 300):", funcBody.slice(-300));
    console.log(
      TAG,
      "[DIAG] Lookup array name:",
      lookupName,
      "elements:",
      lookupRaw ? lookupRaw.split(lookupDelim).length : 0,
    );

    // Find helper object from function body (excluding params and locals)
    var lookupEsc = escRe(lookupName);
    // Look for HELPER[lookup[N]]( pattern - method call via lookup array
    var helperRefRe = new RegExp(
      "([a-zA-Z0-9$_]+)\\[" + lookupEsc + "\\[\\d+\\]\\]\\s*\\(",
      "g",
    );
    var helperName = null;
    var allHelperRefs = []; // DIAGNOSTIC: collect all matches
    var hrm;
    while ((hrm = helperRefRe.exec(funcBody)) !== null) {
      allHelperRefs.push({ name: hrm[1], skipped: !!skipNames[hrm[1]] });
      if (!skipNames[hrm[1]]) {
        helperName = hrm[1];
        break;
      }
    }
    if (!helperName) {
      console.warn(
        TAG,
        "Could not find cipher helper (after filtering params/locals)",
      );
      // DIAGNOSTIC: show what WAS found and what patterns exist
      console.log(
        TAG,
        "[DIAG] Helper refs found (all matched, before filter):",
        allHelperRefs,
      );
      // Try broader patterns to see what kind of calls exist in the body
      var anyCallPattern = /([a-zA-Z0-9$_]+)\s*\.\s*([a-zA-Z0-9$_]+)\s*\(/g;
      var dotCalls = [];
      var dcm;
      while (
        (dcm = anyCallPattern.exec(funcBody)) !== null &&
        dotCalls.length < 10
      ) {
        dotCalls.push(dcm[1] + "." + dcm[2] + "()");
      }
      console.log(TAG, "[DIAG] Dot-call patterns in cipher body:", dotCalls);
      // Also show any bracket-access calls
      var bracketCallPattern = /([a-zA-Z0-9$_]+)\[([^\]]+)\]\s*\(/g;
      var bracketCalls = [];
      var bcm;
      while (
        (bcm = bracketCallPattern.exec(funcBody)) !== null &&
        bracketCalls.length < 10
      ) {
        bracketCalls.push(bcm[1] + "[" + bcm[2] + "]()");
      }
      console.log(
        TAG,
        "[DIAG] Bracket-call patterns in cipher body:",
        bracketCalls,
      );
      return null;
    }

    // Find helper object definition
    var helperDefMatch = js.match(
      new RegExp("(?:var\\s+|[;,]\\s*)" + escRe(helperName) + "\\s*=\\s*\\{"),
    );
    if (!helperDefMatch) return null;
    var helperBraceIdx = js.indexOf(
      "{",
      helperDefMatch.index + helperDefMatch[0].lastIndexOf("=") + 1,
    );
    var helperBlock = extractBraceBlock(js, helperBraceIdx);
    if (!helperBlock) return null;

    // Build self-contained code
    // Choose quote char that's safe for the content (if content has " use ', and vice versa)
    var q = lookupRaw.indexOf('"') !== -1 ? "'" : '"';
    var argName = "_sig_";
    var paramStr = paramNames.length > 0 ? paramNames.join(",") : "b,N";
    var code =
      "var " +
      lookupName +
      "=" +
      q +
      lookupRaw +
      q +
      ".split(" +
      q +
      lookupDelim +
      q +
      ");\n" +
      "var " +
      helperName +
      "=" +
      helperBlock +
      ";\n" +
      "var " +
      cipherFuncName +
      "=function(" +
      paramStr +
      ")" +
      funcBody +
      ";\n" +
      "return " +
      cipherFuncName +
      "(" +
      dispatchValue +
      ", " +
      argName +
      ");";

    console.log(
      TAG,
      "Dispatch cipher extracted:",
      code.length,
      "chars, func:",
      cipherFuncName,
      "dispatch:",
      dispatchValue,
    );
    return { cipherCode: code, argName: argName };
  }

  function extractCipher(js) {
    // === Try new-style dispatch cipher first (2025+) ===
    var dispatchResult = extractDispatchCipher(js);
    if (dispatchResult) return dispatchResult;

    // === Legacy patterns (pre-2025) ===
    var fname = findCipherFunctionName(js);
    if (!fname) {
      console.warn(TAG, "Could not find cipher function name");
      return null;
    }
    console.log(TAG, "Cipher function name:", fname);

    var esc = escRe(fname);
    var fnPatterns = [
      // Traditional function expression: fname = function(a) {
      new RegExp(
        "(?:^|[;,\\n])\\s*" + esc + "\\s*=\\s*function\\s*\\((\\w+)\\)\\s*\\{",
        "m",
      ),
      // Function declaration: function fname(a) {
      new RegExp("function\\s+" + esc + "\\s*\\((\\w+)\\)\\s*\\{"),
      // var/let/const function expression
      new RegExp(
        "(?:var|let|const)\\s+" +
          esc +
          "\\s*=\\s*function\\s*\\((\\w+)\\)\\s*\\{",
      ),
      // Arrow function: fname = (a) => {
      new RegExp(
        "(?:^|[;,\\n])\\s*" + esc + "\\s*=\\s*\\((\\w+)\\)\\s*=>\\s*\\{",
        "m",
      ),
      // Arrow function single param: fname = a => {
      new RegExp(
        "(?:^|[;,\\n])\\s*" + esc + "\\s*=\\s*(\\w+)\\s*=>\\s*\\{",
        "m",
      ),
      // var/let/const arrow: var fname = (a) => {
      new RegExp(
        "(?:var|let|const)\\s+" + esc + "\\s*=\\s*\\((\\w+)\\)\\s*=>\\s*\\{",
      ),
    ];

    var defMatch = null;
    for (var i = 0; i < fnPatterns.length; i++) {
      defMatch = js.match(fnPatterns[i]);
      if (defMatch) break;
    }
    if (!defMatch) {
      console.warn(
        TAG,
        "Could not find cipher function definition for:",
        fname,
      );
      return null;
    }

    var argName = defMatch[1];

    var braceIdx = defMatch.index + defMatch[0].lastIndexOf("{");
    var bodyBlock = extractBraceBlock(js, braceIdx);
    if (!bodyBlock) {
      console.warn(TAG, "Could not extract cipher function body");
      return null;
    }
    var body = bodyBlock.slice(1, -1);

    var helperMatch = body.match(/;\s*([a-zA-Z0-9$_]+)\.\w+\s*\(/);
    if (!helperMatch) {
      helperMatch = body.match(/([a-zA-Z0-9$_]+)\.\w+\s*\(/);
    }
    if (!helperMatch) {
      console.warn(TAG, "Could not find helper object in cipher body");
      return null;
    }
    var helperName = helperMatch[1];
    if (helperName === argName) {
      var allHelpers = body.match(
        new RegExp("([a-zA-Z0-9$_]+)\\.\\w+\\s*\\(", "g"),
      );
      if (allHelpers) {
        for (var i = 0; i < allHelpers.length; i++) {
          var hm = allHelpers[i].match(/([a-zA-Z0-9$_]+)\./);
          if (hm && hm[1] !== argName) {
            helperName = hm[1];
            break;
          }
        }
      }
    }
    console.log(TAG, "Cipher helper object:", helperName);

    var helperEsc = escRe(helperName);
    var helperDefMatch = js.match(
      new RegExp("(?:var\\s+|[;,]\\s*)" + helperEsc + "\\s*=\\s*\\{"),
    );
    if (!helperDefMatch) {
      console.warn(
        TAG,
        "Could not find helper object definition for:",
        helperName,
      );
      return null;
    }
    var objBraceIdx = js.indexOf(
      "{",
      helperDefMatch.index + helperDefMatch[0].lastIndexOf("=") + 1,
    );
    var objBlock = extractBraceBlock(js, objBraceIdx);
    if (!objBlock) {
      console.warn(TAG, "Could not extract helper object body");
      return null;
    }

    var code =
      "var " +
      helperName +
      "=" +
      objBlock +
      ";\n" +
      argName +
      "=" +
      argName +
      '.split("");\n' +
      body.replace(
        new RegExp(
          "^\\s*" +
            escRe(argName) +
            "\\s*=\\s*" +
            escRe(argName) +
            "\\.split\\(\\s*(?:\"\"|''\)\\s*\\)\\s*;?",
        ),
        "",
      ) +
      "\n";

    if (code.indexOf("return") === -1) {
      code += "return " + argName + '.join("");';
    }

    console.log(TAG, "Extracted cipher code, sending to sandbox");
    return { cipherCode: code, argName: argName };
  }

  function findNSigFunctionName(js) {
    var patterns = [
      {
        re: /\.get\("n"\)\)&&\(b=([a-zA-Z0-9$]+)(?:\[(\d+)\])?\(([a-zA-Z0-9])\)/,
        nameIdx: 1,
        arrIdx: 2,
      },
      {
        re: /[=(,&|]([a-zA-Z0-9$]+)\(\w+\),\w+\.set\("n",/,
        nameIdx: 1,
        arrIdx: null,
      },
      {
        re: /[=(,&|]([a-zA-Z0-9$]+)\[(\d+)\]\(\w+\),\w+\.set\("n",/,
        nameIdx: 1,
        arrIdx: 2,
      },
      {
        re: /\.set\("n",\s*([a-zA-Z0-9$]+)\(\s*\w+\s*\)/,
        nameIdx: 1,
        arrIdx: null,
      },
      {
        // Only match decodeURIComponent patterns when near .get("n") context
        re: /\.get\("n"\).*?&&\(\w+=([a-zA-Z0-9$]+)\(decodeURIComponent/s,
        nameIdx: 1,
        arrIdx: null,
      },
      {
        re: /\w+=\w+\.get\("n"\)[^}]*\w+&&\(\w+=([a-zA-Z0-9$]+)(?:\[(\d+)\])?\(\w+\)/,
        nameIdx: 1,
        arrIdx: 2,
      },
      {
        // Newer patterns (2025+)
        re: /\.get\("n"\)\s*\)\s*[;,].*?\.set\("n"\s*,\s*([a-zA-Z0-9$]+)\s*\(/s,
        nameIdx: 1,
        arrIdx: null,
      },
      {
        re: /\.get\("n"\)\)&&.*?[=(,]([a-zA-Z0-9$]+)(?:\[(\d+)\])?\(/,
        nameIdx: 1,
        arrIdx: 2,
      },
      {
        re: /([a-zA-Z0-9$]+)\(\w+\.get\("n"\)\)[,;].*?\.set\("n"/,
        nameIdx: 1,
        arrIdx: null,
      },
      {
        // URL path /n/ replacement pattern (anchored to .set("n") context)
        re: /\.set\("n"[^)]*\).*?\/n\/[^/]+.*?([a-zA-Z0-9$]+)\s*\(\s*\w+\s*\)/s,
        nameIdx: 1,
        arrIdx: null,
      },
    ];

    for (var i = 0; i < patterns.length; i++) {
      var m = js.match(patterns[i].re);
      if (m && m[patterns[i].nameIdx]) {
        console.log(
          TAG,
          "N-sig function found with pattern",
          i,
          ":",
          m[patterns[i].nameIdx],
        );
        return {
          name: m[patterns[i].nameIdx],
          arrayIdx:
            patterns[i].arrIdx !== null && m[patterns[i].arrIdx] !== undefined
              ? parseInt(m[patterns[i].arrIdx])
              : null,
        };
      }
    }
    var arrWrapPattern =
      /;\s*([a-zA-Z0-9$]+)\s*=\s*\[([a-zA-Z0-9$]+)\]\s*[;,]/g;
    var awm;
    while ((awm = arrWrapPattern.exec(js)) !== null) {
      var candidateArr = awm[1];
      var candidateFunc = awm[2];
      if (
        js.indexOf(candidateArr + "[0]") !== -1 ||
        js.indexOf(candidateArr + "(") !== -1
      ) {
        var funcCheckRe = new RegExp(
          "(?:function\\s+" +
            escRe(candidateFunc) +
            "|" +
            escRe(candidateFunc) +
            "\\s*=\\s*function|" +
            escRe(candidateFunc) +
            "\\s*=\\s*\\(?\\w+\\)?\\s*=>)\\s*[\\({]",
        );
        var funcDefMatch = funcCheckRe.exec(js);
        if (funcDefMatch) {
          // Verify the function body is large enough and has N-sig structure
          var braceIdx = js.indexOf(
            "{",
            funcDefMatch.index + funcDefMatch[0].length - 1,
          );
          if (braceIdx !== -1) {
            var body = extractBraceBlock(js, braceIdx);
            if (
              body &&
              body.length > 500 &&
              /try\s*\{/.test(body) &&
              /catch\s*\(/.test(body)
            ) {
              return { name: candidateFunc, arrayIdx: null };
            }
          }
        }
      }
    }

    return null;
  }

  function extractNSig(js) {
    var info = findNSigFunctionName(js);
    if (!info) {
      info = findNSigByStructure(js);
    }
    if (!info) {
      console.warn(TAG, "Could not find N-sig function name");
      return null;
    }

    var fname = info.name;
    console.log(TAG, "N-sig function:", fname, "arrayIdx:", info.arrayIdx);

    if (info.arrayIdx !== null) {
      var arrEsc = escRe(fname);
      var arrMatch = js.match(
        new RegExp("[,;\\n]\\s*" + arrEsc + "\\s*=\\s*\\[([\\w$,\\s]+)\\]"),
      );
      if (arrMatch) {
        var items = arrMatch[1].split(",");
        if (items[info.arrayIdx]) {
          fname = items[info.arrayIdx].trim();
          console.log(TAG, "N-sig array resolved to:", fname);
        }
      }
    }

    var esc = escRe(fname);
    var fnPatterns = [
      // Traditional function expression: H = function(a) {
      new RegExp(
        "(?:^|[;,\\n])\\s*" + esc + "\\s*=\\s*function\\s*\\(([^)]*)\\)\\s*\\{",
        "gm",
      ),
      // Function declaration: function H(a) {
      new RegExp("function\\s+" + esc + "\\s*\\(([^)]*)\\)\\s*\\{", "g"),
      // var/let/const function expression: var H = function(a) {
      new RegExp(
        "(?:var|let|const)\\s+" +
          esc +
          "\\s*=\\s*function\\s*\\(([^)]*)\\)\\s*\\{",
        "g",
      ),
      // Arrow function with parens: H = (a) => {
      new RegExp(
        "(?:^|[;,\\n])\\s*" + esc + "\\s*=\\s*\\(([^)]*)\\)\\s*=>\\s*\\{",
        "gm",
      ),
      // Arrow function single param: H = a => {
      new RegExp(
        "(?:^|[;,\\n])\\s*" +
          esc +
          "\\s*=\\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\\s*=>\\s*\\{",
        "gm",
      ),
      // var/let/const with arrow: var H = (a) => {
      new RegExp(
        "(?:var|let|const)\\s+" + esc + "\\s*=\\s*\\(([^)]*)\\)\\s*=>\\s*\\{",
        "g",
      ),
      // var/let/const with arrow single param: var H = a => {
      new RegExp(
        "(?:var|let|const)\\s+" +
          esc +
          "\\s*=\\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\\s*=>\\s*\\{",
        "g",
      ),
    ];

    for (var i = 0; i < fnPatterns.length; i++) {
      var defMatch;
      while ((defMatch = fnPatterns[i].exec(js)) !== null) {
        var args = defMatch[1];
        var braceIdx = defMatch.index + defMatch[0].lastIndexOf("{");
        var bodyBlock = extractBraceBlock(js, braceIdx);
        if (!bodyBlock) continue;

        // N-sig functions are large and contain try/catch + array indexing
        // Skip tiny matches that happen to share the same short name
        if (bodyBlock.length < 200) continue;
        if (
          !/try\s*\{/.test(bodyBlock) &&
          !/\[\s*\d+\s*\]/.test(bodyBlock) &&
          bodyBlock.length < 2000
        )
          continue;

        var fnStr = "function(" + args + ")" + bodyBlock;

        var argFirst = args.split(",")[0].trim();
        fnStr = fnStr.replace(
          new RegExp(
            "if\\s*\\(\\s*typeof\\s+" +
              escRe(argFirst) +
              '\\s*===?\\s*."undefined."\\s*\\)\\s*return\\s+' +
              escRe(argFirst) +
              "\\s*;?",
          ),
          ";",
        );

        console.log(
          TAG,
          "Extracted N-sig code:",
          fnStr.length,
          "chars from function",
          fname,
        );
        return { nSigCode: fnStr };
      }
    }

    console.warn(
      TAG,
      "Could not find N-sig function definition (large enough) for:",
      fname,
    );
    return null;
  }

  function findNSigByStructure(js) {
    // Match both traditional functions and arrow functions
    var funcPatterns = [
      /(?:^|[;,\n])\s*([a-zA-Z0-9$_]+)\s*=\s*function\s*\((\w+)\)\s*\{/gm,
      /(?:^|[;,\n])\s*([a-zA-Z0-9$_]+)\s*=\s*\((\w+)\)\s*=>\s*\{/gm,
      /(?:^|[;,\n])\s*([a-zA-Z0-9$_]+)\s*=\s*(\w+)\s*=>\s*\{/gm,
    ];
    for (var p = 0; p < funcPatterns.length; p++) {
      var funcPattern = funcPatterns[p];
      var m;
      while ((m = funcPattern.exec(js)) !== null) {
        var name = m[1];
        var braceIdx = m.index + m[0].lastIndexOf("{");
        var body = extractBraceBlock(js, braceIdx);
        if (!body || body.length < 50 || body.length > 30000) continue;
        if (
          /try\s*\{/.test(body) &&
          /catch\s*\(/.test(body) &&
          /\[\s*\d+\s*\]/.test(body)
        ) {
          console.log(TAG, "N-sig found by structure:", name);
          return { name: name, arrayIdx: null };
        }
      }
    }
    return null;
  }

  async function parsePlayerJs(playerUrl) {
    if (playerCache[playerUrl]) {
      console.log(TAG, "Using cached player data for", playerUrl);
      return playerCache[playerUrl];
    }

    // Try to discover the real player.js URL from the page if we don't have one
    var effectiveUrl = playerUrl;
    var pageUrl = getPlayerJsUrlFromPage();
    if (pageUrl) {
      console.log(
        TAG,
        "Found player.js URL from page:",
        pageUrl.substring(0, 80),
      );
      effectiveUrl = pageUrl;
    }

    console.log(TAG, "Fetching player.js:", effectiveUrl);
    var js;
    try {
      js = await fetchPlayerJs(effectiveUrl);
    } catch (e) {
      // If the primary URL failed and we have a page-discovered URL, try that
      if (pageUrl && pageUrl !== effectiveUrl) {
        console.log(
          TAG,
          "Retrying with page-discovered URL:",
          pageUrl.substring(0, 80),
        );
        try {
          js = await fetchPlayerJs(pageUrl);
        } catch (e2) {
          console.error(TAG, "Fallback fetch also failed:", e2.message);
        }
      }
      if (!js) {
        console.error(
          TAG,
          "Failed to fetch player.js after all retries:",
          e.message,
        );
        return { cipher: null, nSig: null, sts: null, fetchFailed: true };
      }
    }
    if (!js || typeof js !== "string" || js.length < 1000) {
      console.warn(
        TAG,
        "Player.js returned empty or invalid response, length:",
        js ? js.length : 0,
      );
      return { cipher: null, nSig: null, sts: null, fetchFailed: true };
    }
    console.log(TAG, "Player.js loaded:", js.length, "bytes");

    // DIAGNOSTIC: Dump key structural signatures from player.js
    console.log(TAG, "[DIAG] ====== PLAYER.JS STRUCTURE DUMP ======");
    // Check for split("DELIM") large arrays (support both quote types)
    var bigArrays = js.match(
      /([a-zA-Z0-9$_]+)\s*=\s*(?:"[^"]{200,}"|'[^']{200,}')\s*\.\s*split\s*\(/g,
    );
    console.log(
      TAG,
      "[DIAG] Big split arrays:",
      bigArrays
        ? bigArrays.map(function (s) {
            return s.slice(0, 60) + "...";
          })
        : "none",
    );
    // Check for decodeURIComponent patterns (cipher signature)
    var decURIPatterns = js.match(
      /.{0,30}decodeURIComponent\s*\(\s*[a-zA-Z0-9$_]+\s*\.\s*s\s*\).{0,30}/g,
    );
    console.log(
      TAG,
      "[DIAG] decodeURIComponent(*.s):",
      decURIPatterns ? decURIPatterns.slice(0, 3) : "none",
    );
    // Check for .get("n") patterns (N-sig)
    var getNPatterns = js.match(/.{0,30}\.get\s*\(\s*["']n["']\s*\).{0,50}/g);
    console.log(
      TAG,
      '[DIAG] .get("n") patterns:',
      getNPatterns ? getNPatterns.slice(0, 3) : "none",
    );
    // Check for signatureTimestamp
    var stsMatch = js.match(/signatureTimestamp[=:"\s]+(\d+)/);
    console.log(TAG, "[DIAG] STS:", stsMatch ? stsMatch[1] : "not found");
    console.log(TAG, "[DIAG] ====== END STRUCTURE DUMP ======");

    // === Step 1: Find external dependency names (2025+ architecture) ===
    var externalDeps = findExternalDeps(js);

    // === Step 2: Try direct global access (fast path) ===
    //
    // Check if cipher helper and N-sig wrapper are exported to _yt_player
    // (via `g.NAME = ...` inside the IIFE).  If they are NOT exported, they
    // are closure-local variables and will NEVER appear on window/_yt_player.
    // In that case, skip the expensive polling entirely (saves ~3s).
    var cipherActions = null;
    var nSigFn = null;

    var cipherHelperExported = isExportedToYTPlayer(
      js,
      externalDeps.cipherHelper,
    );
    var nSigWrapperExported = isExportedToYTPlayer(
      js,
      externalDeps.nSigWrapper,
    );

    console.log(
      TAG,
      "IIFE export check — cipherHelper:",
      externalDeps.cipherHelper || "none",
      cipherHelperExported ? "(exported)" : "(IIFE-local)",
      "| nSigWrapper:",
      externalDeps.nSigWrapper || "none",
      nSigWrapperExported ? "(exported)" : "(IIFE-local)",
    );

    // Only attempt global access for exported names
    if (
      cipherHelperExported &&
      externalDeps.cipherHelper &&
      externalDeps.cipherOps.length > 0
    ) {
      cipherActions = buildCipherActionsFromGlobal(
        externalDeps.cipherHelper,
        externalDeps.cipherOps,
      );
    }

    if (nSigWrapperExported && externalDeps.nSigWrapper) {
      nSigFn = getNSigFromGlobal(externalDeps.nSigWrapper);
    }

    // Only poll for globals that ARE exported but not yet available
    // (timing gap on fresh page load).  IIFE-locals are skipped entirely.
    if (
      (cipherHelperExported &&
        externalDeps.cipherHelper &&
        externalDeps.cipherOps.length > 0 &&
        !cipherActions) ||
      (nSigWrapperExported && externalDeps.nSigWrapper && !nSigFn)
    ) {
      var pollPromises = [];

      if (!cipherActions && cipherHelperExported && externalDeps.cipherHelper) {
        console.log(
          TAG,
          "Cipher helper exported but not ready, polling for:",
          externalDeps.cipherHelper,
        );
        pollPromises.push(
          waitForYTGlobal(externalDeps.cipherHelper, 1500).then(
            function (ready) {
              if (ready) {
                console.log(
                  TAG,
                  "Cipher helper became available after polling:",
                  externalDeps.cipherHelper,
                );
                cipherActions = buildCipherActionsFromGlobal(
                  externalDeps.cipherHelper,
                  externalDeps.cipherOps,
                );
              }
            },
          ),
        );
      }

      if (!nSigFn && nSigWrapperExported && externalDeps.nSigWrapper) {
        console.log(
          TAG,
          "N-sig wrapper exported but not ready, polling for:",
          externalDeps.nSigWrapper,
        );
        pollPromises.push(
          waitForYTGlobal(externalDeps.nSigWrapper, 1500).then(
            function (ready) {
              if (ready) {
                console.log(
                  TAG,
                  "N-sig wrapper became available after polling:",
                  externalDeps.nSigWrapper,
                );
                nSigFn = getNSigFromGlobal(externalDeps.nSigWrapper);
              }
            },
          ),
        );
      }

      await Promise.all(pollPromises);
    } else if (
      !cipherHelperExported &&
      !nSigWrapperExported &&
      (externalDeps.cipherHelper || externalDeps.nSigWrapper)
    ) {
      console.log(
        TAG,
        "Both deps are IIFE-local — skipping global polling (saves ~3s). " +
          "Background.js will handle extraction via AST solver.",
      );
    }

    // === Step 3: Fallback to code extraction (legacy approach) ===
    var cipher = null;
    var nSig = null;
    var extractionErrors = [];

    if (!cipherActions) {
      cipher = extractCipher(js);
      if (!cipher) {
        extractionErrors.push("cipher extraction failed");
        console.warn(
          TAG,
          "⚠ Cipher extraction failed - trying inline script extraction",
        );
        // Try to extract cipher helper from page inline scripts
        if (externalDeps.cipherHelper) {
          var helperCode = extractCipherHelperFromPage(
            externalDeps.cipherHelper,
          );
          if (helperCode) {
            console.log(TAG, "Cipher helper extracted from inline script");
            // We have the helper code — classify methods from the code
            // This is still useful for sending to background.js
            cipher = {
              cipherHelperCode: helperCode,
              cipherHelperName: externalDeps.cipherHelper,
            };
          }
        }
      }
    }

    if (!nSigFn) {
      nSig = extractNSig(js);
      if (!nSig) {
        extractionErrors.push("N-sig extraction failed");
        console.warn(
          TAG,
          "⚠ N-sig extraction failed - player.js patterns may be outdated",
        );
      }
    }

    var sts = null;
    var stsPatterns = [
      /,sts:(\d+)/,
      /signatureTimestamp[=:](\d+)/,
      /"signatureTimestamp":(\d+)/,
    ];
    for (var i = 0; i < stsPatterns.length; i++) {
      var m = js.match(stsPatterns[i]);
      if (m) {
        sts = parseInt(m[1]);
        break;
      }
    }

    var result = {
      cipher: cipher,
      nSig: nSig,
      sts: sts,
      cipherActions: cipherActions, // Direct action list (from global access)
      nSigFn: nSigFn, // Direct N-sig function (from global access)
      externalDeps: externalDeps,
    };

    if (extractionErrors.length > 0) {
      result.extractionErrors = extractionErrors;
    }

    playerCache[playerUrl] = result;

    console.log(
      TAG,
      "Player parsed — cipher:",
      cipherActions
        ? "actions(direct)"
        : cipher
          ? cipher.cipherCode
            ? "code"
            : "helper-code"
          : "FAILED",
      "| nSig:",
      nSigFn
        ? "direct"
        : nSig
          ? nSig.nSigCode
            ? "code"
            : "unknown"
          : "FAILED",
      "| STS:",
      sts || "none",
    );
    return result;
  }

  function resolveFormats(playerResponse, playerData) {
    var sd = playerResponse.streamingData;
    if (!sd) return [];

    var raw = [].concat(sd.formats || [], sd.adaptiveFormats || []);
    var resolved = [];

    // === Cipher function resolution ===
    var cipherFn = null;
    // Priority 1: Direct cipher actions from global access (2025+)
    if (playerData.cipherActions) {
      cipherFn = function (sig) {
        return applyCipherActions(playerData.cipherActions, sig);
      };
      console.log(TAG, "Using direct cipher actions for format resolution");
    }
    // Priority 2: Legacy code-based cipher
    // NOTE: new Function() is blocked by YouTube's Trusted Types CSP.
    // Extracted cipher code is relayed to background.js for sandbox eval.
    if (!cipherFn && playerData.cipher) {
      if (typeof playerData.cipher === "function") {
        cipherFn = playerData.cipher;
      } else if (playerData.cipher.cipherCode) {
        console.log(
          TAG,
          "Cipher code extracted but cannot eval in MAIN world (Trusted Types). Will relay to background.",
        );
      }
    }

    // === N-sig function resolution ===
    var nSigFn = null;
    // Priority 1: Direct N-sig function from global access (2025+)
    if (playerData.nSigFn && typeof playerData.nSigFn === "function") {
      nSigFn = playerData.nSigFn;
      console.log(TAG, "Using direct N-sig function for format resolution");
    }
    // Priority 2: Legacy code-based N-sig
    // NOTE: new Function() is blocked by YouTube's Trusted Types CSP.
    // Extracted N-sig code is relayed to background.js for sandbox eval.
    if (!nSigFn && playerData.nSig) {
      if (typeof playerData.nSig === "function") {
        nSigFn = playerData.nSig;
      } else if (playerData.nSig.nSigCode) {
        console.log(
          TAG,
          "N-sig code extracted but cannot eval in MAIN world (Trusted Types). Will relay to background.",
        );
      }
    }

    for (var i = 0; i < raw.length; i++) {
      var fmt = raw[i];
      var url = fmt.url || null;

      if (!url && (fmt.cipher || fmt.signatureCipher)) {
        var scStr = fmt.cipher || fmt.signatureCipher;
        var params = new URLSearchParams(scStr);
        url = params.get("url");
        var s = params.get("s");
        var sp = params.get("sp") || "sig";

        if (url && s && cipherFn) {
          try {
            var decrypted = cipherFn(s);
            url +=
              (url.indexOf("?") !== -1 ? "&" : "?") +
              sp +
              "=" +
              encodeURIComponent(decrypted);
          } catch (e) {
            console.warn(
              TAG,
              "Cipher failed for itag",
              fmt.itag,
              ":",
              e.message,
            );
            continue;
          }
        } else if (!cipherFn) {
          continue;
        }
      }

      if (!url) continue;

      if (nSigFn) {
        var nMatch = url.match(/[?&]n=([^&]+)/);
        if (nMatch) {
          try {
            var origN = decodeURIComponent(nMatch[1]);
            var newN = nSigFn(origN);
            if (newN && typeof newN === "string" && newN !== origN) {
              url = url.replace(
                "n=" + nMatch[1],
                "n=" + encodeURIComponent(newN),
              );
            }
          } catch (e) {
            console.warn(
              TAG,
              "N-sig failed for itag",
              fmt.itag,
              ":",
              e.message,
            );
          }
        }
      }

      if (url.indexOf("ratebypass") === -1) {
        url += "&ratebypass=yes";
      }

      var mime = fmt.mimeType || "";
      var cm = mime.match(/codecs="([^"]+)"/);
      var codecs = cm ? cm[1] : "";
      var isV = mime.indexOf("video/") === 0;
      var isA = mime.indexOf("audio/") === 0;

      resolved.push({
        itag: fmt.itag,
        url: url,
        mimeType: mime,
        quality: fmt.qualityLabel || fmt.quality || "",
        qualityLabel: fmt.qualityLabel || "",
        width: fmt.width || 0,
        height: fmt.height || 0,
        fps: fmt.fps || 0,
        bitrate: fmt.bitrate || 0,
        audioBitrate: fmt.averageBitrate || fmt.bitrate || 0,
        audioQuality: fmt.audioQuality || "",
        contentLength: parseInt(fmt.contentLength) || null,
        codecs: codecs,
        isVideo: isV,
        isAudio: isA,
        isMuxed: isV && codecs.indexOf("mp4a") !== -1,
      });
    }

    return resolved;
  }

  function sendToContentScript(data) {
    var origin = window.location.origin;
    try {
      var safe = JSON.parse(JSON.stringify(data));
      window.postMessage({ type: MAGIC, payload: safe }, origin);
    } catch (e) {
      console.warn(TAG, "postMessage serialization error:", e.message);
      window.postMessage(
        {
          type: MAGIC,
          payload: {
            error: e.message,
            videoId: data.videoId || null,
            playerUrl: data.playerUrl || null,
            visitorData: data.visitorData || null,
          },
        },
        origin,
      );
    }
  }

  async function processVideo() {
    console.log(TAG, "Processing video...");

    // On fresh navigation, page globals may not exist yet.
    // Wait briefly for ytInitialPlayerResponse or the player element.
    if (
      typeof ytInitialPlayerResponse === "undefined" &&
      !document.getElementById("movie_player")
    ) {
      console.log(TAG, "Page not ready yet, waiting for player data...");
      await new Promise(function (resolve) {
        var elapsed = 0;
        var timer = setInterval(function () {
          elapsed += 300;
          try {
            if (
              typeof ytInitialPlayerResponse !== "undefined" ||
              document.getElementById("movie_player") ||
              (typeof ytcfg !== "undefined" &&
                ytcfg.get &&
                ytcfg.get("PLAYER_JS_URL"))
            ) {
              clearInterval(timer);
              resolve();
              return;
            }
          } catch (e) {}
          if (elapsed >= 5000) {
            clearInterval(timer);
            console.warn(TAG, "Timed out waiting for page data");
            resolve();
          }
        }, 300);
      });
    }

    var data = extractPageData();

    if (!data.playerResponse) {
      // Only send if we have at least a videoId or playerUrl — background.js
      // can use these to kick off its own pipeline.  Sending completely empty
      // data wastes a round-trip and may cause pendingRequests to latch onto
      // the empty payload.
      if (data.videoId || data.playerUrl) {
        console.log(
          TAG,
          "No playerResponse yet, sending metadata (videoId/playerUrl) to background",
        );
        sendToContentScript(data);
      } else {
        console.log(
          TAG,
          "No playerResponse and no metadata — skipping send (retry will fire)",
        );
      }
      return {
        hasFormats: false,
        directCipher: false,
        directNSig: false,
        fetchFailed: false,
      };
    }

    if (!data.playerUrl) {
      console.log(
        TAG,
        "No playerUrl, sending playerResponse without deciphering",
      );
      sendToContentScript(data);
      return {
        hasFormats: false,
        directCipher: false,
        directNSig: false,
        fetchFailed: false,
      };
    }

    try {
      var playerData = await parsePlayerJs(data.playerUrl);
      var formats = resolveFormats(data.playerResponse, playerData);

      data.resolvedFormats = formats;
      data.formatSource =
        formats.length > 0 ? "page_deciphered" : "page_code_only";
      data.sts = data.sts || playerData.sts;

      // Send cipher action list for background.js to use in Tier 2/3
      if (playerData.cipherActions) {
        data.cipherActions = playerData.cipherActions;
      }

      // Legacy cipher code (fallback for background.js)
      if (
        playerData.cipher &&
        typeof playerData.cipher === "object" &&
        playerData.cipher.cipherCode
      ) {
        data.cipherCode = playerData.cipher.cipherCode;
        data.cipherArgName = playerData.cipher.argName;
      }

      // Legacy N-sig code (fallback for background.js)
      if (
        playerData.nSig &&
        typeof playerData.nSig === "object" &&
        playerData.nSig.nSigCode
      ) {
        data.nSigCode = playerData.nSig.nSigCode;
      }

      // Flag whether direct functions were used (background.js may not need sandbox)
      data.directCipher = !!playerData.cipherActions;
      data.directNSig = !!playerData.nSigFn;

      // Signal to background.js that deps are IIFE-local — it should rely
      // on its own player.js fetch + AST solver rather than inject.js code.
      data.depsAreIIFELocal =
        !!(
          playerData.externalDeps &&
          (playerData.externalDeps.cipherHelper ||
            playerData.externalDeps.nSigWrapper)
        ) &&
        !data.directCipher &&
        !data.directNSig;

      if (
        playerData.extractionErrors &&
        playerData.extractionErrors.length > 0
      ) {
        data.extractionErrors = playerData.extractionErrors;
      }

      console.log(
        TAG,
        "Resolved",
        formats.length,
        "formats |",
        "cipher:",
        playerData.cipherActions
          ? "✓(direct)"
          : data.cipherCode
            ? "✓(code→bg)"
            : "✗",
        "| nSig:",
        playerData.nSigFn ? "✓(direct)" : data.nSigCode ? "✓(code→bg)" : "✗",
        data.depsAreIIFELocal
          ? "| deps=IIFE-local (background.js will use AST solver)"
          : "",
      );
    } catch (e) {
      console.warn(TAG, "Format resolution failed:", e.message);
      data.resolveError = e.message;
    }

    sendToContentScript(data);

    // Return success info for retry logic
    // codeExtracted: true when cipher/nSig code was extracted and sent to
    // background.js for sandbox eval — inject.js reports 0 local formats but
    // background.js will handle resolution via its Tier 1/2/3 pipeline.
    // Also true when deps are IIFE-local — background.js has its own
    // player.js fetch + AST solver that doesn't need inject.js code.
    var codeExtracted = !!(
      data.cipherCode ||
      data.nSigCode ||
      data.depsAreIIFELocal
    );
    return {
      hasFormats: !!(data.resolvedFormats && data.resolvedFormats.length > 0),
      directCipher: !!data.directCipher,
      directNSig: !!data.directNSig,
      codeExtracted: codeExtracted,
      fetchFailed: !!(playerData && playerData.fetchFailed),
    };
  }

  var _processTimer = null;
  var _navCounter = 0;
  var _retryCount = 0;
  var _maxAutoRetries = 2;

  function scheduleProcess(delay) {
    if (_processTimer) clearTimeout(_processTimer);
    var myNav = ++_navCounter;
    _retryCount = 0; // Reset retry count on new navigation
    _processTimer = setTimeout(function () {
      _processTimer = null;
      if (myNav !== _navCounter) return;
      processVideo()
        .then(function (result) {
          if (myNav !== _navCounter) return;
          // Auto-retry if we failed to get formats AND code extraction also
          // failed. When code was extracted (cipher/nSig as code strings),
          // the data was already sent to background.js for sandbox eval —
          // retrying inject.js processing won't help.
          if (
            result &&
            !result.hasFormats &&
            !result.codeExtracted &&
            _retryCount < _maxAutoRetries
          ) {
            _retryCount++;
            var retryDelay = 3000 * _retryCount; // 3s, 6s
            console.log(
              TAG,
              "Auto-retry " +
                _retryCount +
                "/" +
                _maxAutoRetries +
                " in " +
                retryDelay +
                "ms (formats:" +
                result.hasFormats +
                " cipher:" +
                result.directCipher +
                " nSig:" +
                result.directNSig +
                " codeExtracted:" +
                result.codeExtracted +
                " fetchFailed:" +
                result.fetchFailed +
                ")",
            );
            // Clear player cache so we re-fetch/re-resolve
            playerCache = {};
            _processTimer = setTimeout(function () {
              _processTimer = null;
              if (myNav !== _navCounter) return;
              processVideo();
            }, retryDelay);
          }
        })
        .catch(function () {});
    }, delay);
  }

  window.addEventListener("message", function (e) {
    if (e.data && e.data.type === MAGIC + "_request") {
      scheduleProcess(300);
    }
  });

  try {
    window.addEventListener("yt-navigate-finish", function () {
      try {
        if (typeof ytInitialPlayerResponse !== "undefined") {
        }
      } catch (e) {}
      scheduleProcess(1500);
    });
  } catch (e) {}

  scheduleProcess(1200);
})();
