(function () {
  "use strict";

  var MAGIC = "__ytdl_ext__";
  var playerCache = {};
  var TAG = "[YT-DL inject]";

  console.log(
    TAG,
    "Running in hybrid mode (direct global access + code extraction fallback)",
  );

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
   * Find external dependency names from player.js code.
   * YouTube 2025+ splits key functions between player.js (base.js) and inline scripts.
   * The cipher helper (e.g., eO) and N-sig wrapper (e.g., R8K) are defined as
   * GLOBAL variables in inline <script> tags, then referenced inside the player IIFE.
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
    var lookupRe =
      /(?:var\s+|[;,]\s*)([a-zA-Z0-9$_]+)\s*=\s*"([^"]{200,})"\s*\.\s*split\s*\(\s*"([^"]+)"\s*\)/g;
    var lm;
    while ((lm = lookupRe.exec(js)) !== null) {
      var parts = lm[2].split(lm[3]);
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

      var funcDefIdx = js.indexOf(cipherFuncName + "=function(");
      if (funcDefIdx !== -1) {
        var braceIdx = js.indexOf("{", funcDefIdx);
        var funcBody = extractBraceBlock(js, braceIdx);
        if (funcBody) {
          // Find helper references: HELPER[LOOKUP[IDX]](ARRAY, NUM)
          var le = escRe(result.lookupName);
          var helperRe = new RegExp(
            "([a-zA-Z0-9$_]+)\\[" +
              le +
              "\\[(\\d+)\\]\\]\\s*\\(\\s*([a-zA-Z0-9$_]+)\\s*,\\s*(\\d+)\\s*\\)",
            "g",
          );
          var hm;
          while ((hm = helperRe.exec(funcBody)) !== null) {
            if (!result.cipherHelper) result.cipherHelper = hm[1];
            result.cipherOps.push({
              methodName: result.lookupArray[parseInt(hm[2])],
              arg: parseInt(hm[4]),
            });
          }
        }
      }
    }

    // Find N-sig wrapper:
    // Look for WRAPPER[0](x) near a .set("n" pattern in the player code
    // The lookup array maps: l[33]="n", l[20]="set", l[42]="get"
    var nIdx = result.lookupArray.indexOf("n");
    var setIdx = result.lookupArray.indexOf("set");
    if (nIdx !== -1 && setIdx !== -1) {
      // Search for: WRAPPER[0](VAR), ... [l[setIdx]](l[nIdx], VAR)
      // or simpler: find any XXX[0](y) near l[nIdx] context
      var wrapperRe = /([a-zA-Z0-9$_]+)\[0\]\s*\(\s*(\w+)\s*\)/g;
      var wm;
      while ((wm = wrapperRe.exec(js)) !== null) {
        // Check nearby context for n-sig indicators
        var ctx = js.substring(
          Math.max(0, wm.index - 100),
          Math.min(js.length, wm.index + 200),
        );
        // Should be near: l[nIdx] (the "n" parameter) or .set("n"
        if (
          ctx.indexOf("l[" + nIdx + "]") !== -1 ||
          ctx.indexOf('"n"') !== -1
        ) {
          result.nSigWrapper = wm[1];
          console.log(TAG, "N-sig wrapper found:", wm[1]);
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
      if (a.length < test.length) return "splice";
      if (a[0] === test[3] && a[3] === test[0]) return "swap";
      if (a[0] === test[test.length - 1]) return "reverse";
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
      var helper = window[helperName];
      if (!helper || typeof helper !== "object") {
        console.warn(TAG, "Cipher helper not found as global:", helperName);
        return null;
      }

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
      var wrapper = window[wrapperName];
      if (
        wrapper &&
        Array.isArray(wrapper) &&
        typeof wrapper[0] === "function"
      ) {
        console.log(TAG, "N-sig function found via global:", wrapperName);
        return wrapper[0];
      }
      console.warn(TAG, "N-sig wrapper not found or invalid:", wrapperName);
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
      for (var i = 0; i < scripts.length; i++) {
        var text = scripts[i].textContent;
        if (!text || text.length < 10) continue;

        // Look for: var HELPER = { ... } or HELPER = { ... }
        var re = new RegExp(
          "(?:var\\s+)?" + escRe(helperName) + "\\s*=\\s*\\{",
        );
        var m = re.exec(text);
        if (m) {
          var braceIdx = m.index + m[0].lastIndexOf("{");
          var block = extractBraceBlock(text, braceIdx);
          if (block) {
            return "var " + helperName + "=" + block + ";";
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
      for (var i = 0; i < scripts.length; i++) {
        var text = scripts[i].textContent;
        if (!text || text.length < 10) continue;

        var re = new RegExp(
          "(?:var\\s+)?" + escRe(wrapperName) + "\\s*=\\s*\\[",
        );
        var m = re.exec(text);
        if (m) {
          var bracketIdx = m.index + m[0].lastIndexOf("[");
          var block = extractBracketBlock(text, bracketIdx);
          if (block) {
            return "var " + wrapperName + "=" + block + ";";
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

  async function fetchPlayerJs(url) {
    var maxRetries = 4;
    var lastErr = null;

    for (var attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (attempt <= 2) {
          return await fetchPlayerJsXHR(url);
        } else if (attempt === 3) {
          console.log(
            TAG,
            "Trying fetch() API with force-cache for player.js (attempt " +
              attempt +
              ")",
          );
          return await fetchPlayerJsFetch(url);
        } else {
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
      /&&\(\w+=([a-zA-Z0-9$]+)\("[^"]*",decodeURIComponent/,
      /&&\(\w+=([a-zA-Z0-9$]+)\(decodeURIComponent/,
      /\.set\("signature",\s*([a-zA-Z0-9$]+)\(/,
      /\.set\([^,]+,\s*([a-zA-Z0-9$]{2,})\(decodeURIComponent/,
    ];

    for (var i = 0; i < patterns.length; i++) {
      var m = js.match(patterns[i]);
      if (m && m[1]) {
        console.log(TAG, "Cipher function found with pattern", i, ":", m[1]);
        return m[1];
      }
    }

    // Fallback: find by split("") pattern
    var splitJoinPatterns = [
      /(?:^|[;,\n])\s*([a-zA-Z0-9$_]+)\s*=\s*function\s*\((\w+)\)\s*\{\s*\2\s*=\s*\2\.split\(\s*""\s*\)/m,
      /(?:^|[;,\n])\s*([a-zA-Z0-9$_]+)\s*=\s*\((\w+)\)\s*=>\s*\{\s*\2\s*=\s*\2\.split\(\s*""\s*\)/m,
      /(?:^|[;,\n])\s*([a-zA-Z0-9$_]+)\s*=\s*(\w+)\s*=>\s*\{\s*\2\s*=\s*\2\.split\(\s*""\s*\)/m,
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
    if (!callMatch) return null;
    var cipherFuncName = callMatch[1];
    var dispatchValue = callMatch[2];

    // Find lookup array: var NAME = "...".split("DELIM") with 50+ elements
    var lookupArrayRe =
      /(?:var\s+|[;,]\s*)([a-zA-Z0-9$_]+)\s*=\s*"([^"]{200,})"\s*\.\s*split\s*\(\s*"([^"]+)"\s*\)/g;
    var lookupMatch = null;
    var lookupName = null;
    var lookupRaw = null;
    var lookupDelim = null;
    var lm;
    while ((lm = lookupArrayRe.exec(js)) !== null) {
      var parts = lm[2].split(lm[3]);
      if (parts.length > 50) {
        lookupMatch = lm;
        lookupName = lm[1];
        lookupRaw = lm[2];
        lookupDelim = lm[3];
        break;
      }
    }
    if (!lookupName) return null;

    // Find cipher function definition
    var funcDefIdx = js.indexOf(cipherFuncName + "=function(");
    if (funcDefIdx === -1) return null;
    var braceIdx = js.indexOf("{", funcDefIdx);
    var funcBody = extractBraceBlock(js, braceIdx);
    if (!funcBody) return null;

    // Get param list
    var paramMatch = js.slice(funcDefIdx).match(/=function\s*\(([^)]+)\)/);
    if (!paramMatch) return null;

    // Extract parameter names
    var paramNames = paramMatch[1].split(",").map(function (p) {
      return p.trim();
    });

    // Find local variables in function body (var NAME = ...)
    var localVarRe = /var\s+([a-zA-Z0-9$_]+)\s*=/g;
    var localVars = [];
    var lvm;
    while ((lvm = localVarRe.exec(funcBody)) !== null) {
      localVars.push(lvm[1]);
    }

    // Names to skip when looking for cipher helper
    var skipNames = {};
    for (var i = 0; i < paramNames.length; i++) skipNames[paramNames[i]] = true;
    for (var i = 0; i < localVars.length; i++) skipNames[localVars[i]] = true;
    // Also skip built-in objects
    skipNames["String"] = true;
    skipNames["Array"] = true;
    skipNames["Math"] = true;
    skipNames["Object"] = true;
    skipNames["Number"] = true;
    skipNames["JSON"] = true;

    // Find helper object from function body (excluding params and locals)
    var lookupEsc = escRe(lookupName);
    // Look for HELPER[lookup[N]]( pattern - method call via lookup array
    var helperRefRe = new RegExp(
      "([a-zA-Z0-9$_]+)\\[" + lookupEsc + "\\[\\d+\\]\\]\\s*\\(",
      "g",
    );
    var helperName = null;
    var hrm;
    while ((hrm = helperRefRe.exec(funcBody)) !== null) {
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
    var argName = "_sig_";
    var code =
      "var " +
      lookupName +
      '="' +
      lookupRaw +
      '".split("' +
      lookupDelim +
      '");\n' +
      "var " +
      helperName +
      "=" +
      helperBlock +
      ";\n" +
      "var " +
      cipherFuncName +
      "=function" +
      paramMatch[0].slice(paramMatch[0].indexOf("(")) +
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
            '\\.split\\(\\s*""\\s*\\)\\s*;?',
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

    console.log(TAG, "Fetching player.js:", playerUrl);
    var js;
    try {
      js = await fetchPlayerJs(playerUrl);
    } catch (e) {
      console.error(
        TAG,
        "Failed to fetch player.js after all retries:",
        e.message,
      );
      return { cipher: null, nSig: null, sts: null, fetchFailed: true };
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

    // === Step 1: Find external dependency names (2025+ architecture) ===
    var externalDeps = findExternalDeps(js);

    // === Step 2: Try direct global access first (fast, reliable) ===
    var cipherActions = null;
    var nSigFn = null;

    if (externalDeps.cipherHelper && externalDeps.cipherOps.length > 0) {
      cipherActions = buildCipherActionsFromGlobal(
        externalDeps.cipherHelper,
        externalDeps.cipherOps,
      );
    }

    if (externalDeps.nSigWrapper) {
      nSigFn = getNSigFromGlobal(externalDeps.nSigWrapper);
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
    if (!cipherFn && playerData.cipher) {
      if (typeof playerData.cipher === "function") {
        cipherFn = playerData.cipher;
      } else if (playerData.cipher.cipherCode) {
        try {
          cipherFn = new Function(
            playerData.cipher.argName || "a",
            playerData.cipher.cipherCode,
          );
        } catch (e) {
          console.warn(TAG, "Failed to compile cipher code:", e.message);
        }
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
    if (!nSigFn && playerData.nSig) {
      if (typeof playerData.nSig === "function") {
        nSigFn = playerData.nSig;
      } else if (playerData.nSig.nSigCode) {
        try {
          nSigFn = new Function("return " + playerData.nSig.nSigCode)();
        } catch (e) {
          console.warn(TAG, "Failed to compile N-sig code:", e.message);
        }
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
    var data = extractPageData();

    if (!data.playerResponse) {
      console.log(TAG, "No playerResponse on page, sending raw data");
      sendToContentScript(data);
      return;
    }

    if (!data.playerUrl) {
      console.log(
        TAG,
        "No playerUrl, sending playerResponse without deciphering",
      );
      sendToContentScript(data);
      return;
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
            ? "✓(code)"
            : "✗",
        "| nSig:",
        playerData.nSigFn ? "✓(direct)" : data.nSigCode ? "✓(code)" : "✗",
      );
    } catch (e) {
      console.warn(TAG, "Format resolution failed:", e.message);
      data.resolveError = e.message;
    }

    sendToContentScript(data);
  }

  var _processTimer = null;
  var _navCounter = 0;

  function scheduleProcess(delay) {
    if (_processTimer) clearTimeout(_processTimer);
    var myNav = ++_navCounter;
    _processTimer = setTimeout(function () {
      _processTimer = null;
      if (myNav !== _navCounter) return;
      processVideo();
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
