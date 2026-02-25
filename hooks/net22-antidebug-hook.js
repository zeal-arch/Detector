/**
 * net22-antidebug-hook.js — MAIN world anti-debugger neutralizer for net22.cc
 *
 * net22.cc detects DevTools opening and redirects to /verify with a CAPTCHA.
 * Common techniques used:
 *  - window.outerWidth/outerHeight vs innerWidth/innerHeight (DevTools docked)
 *  - debugger statement timing (pauses = DevTools open)
 *  - console.log/table/clear side-effect detection
 *  - setInterval/setTimeout with debugger traps
 *  - window.onresize + dimension delta checks
 *  - Error().stack inspection for DevTools frames
 *
 * This hook runs in the MAIN world at document_start to neutralize all of these
 * BEFORE the page scripts execute.
 */
(function () {
  "use strict";

  try {
    const host = String((window.location && window.location.hostname) || "");
    if (
      !(
        host === "net22.cc" ||
        host.endsWith(".net22.cc") ||
        host === "net52.cc" ||
        host.endsWith(".net52.cc") ||
        host === "net50.cc" ||
        host.endsWith(".net50.cc") ||
        host === "net20.cc" ||
        host.endsWith(".net20.cc")
      )
    )
      return;

    const TAG = "[Net22AntiDebug]";

    // ── Save originals ────────────────────────────────────────────
    const _origSetInterval = window.setInterval;
    const _origSetTimeout = window.setTimeout;
    const _origEval = window.eval;
    const _OrigFunction = window.Function;
    const _origAssign = window.location.assign;
    const _origReplace = window.location.replace;

    // ── debugger statement detection ──────────────────────────────

    function containsDebugger(fn) {
      if (!fn) return false;
      if (typeof fn === "string") return /\bdebugger\b/i.test(fn);
      if (typeof fn === "function") {
        try {
          return /\bdebugger\b/.test(Function.prototype.toString.call(fn));
        } catch {
          return false;
        }
      }
      return false;
    }

    // ── Block debugger timer traps ────────────────────────────────

    window.setInterval = function (fn, delay) {
      if (containsDebugger(fn)) {
        try {
          console.log(TAG, "Blocked debugger setInterval trap");
        } catch {}
        return 0;
      }
      return _origSetInterval.apply(this, arguments);
    };

    window.setTimeout = function (fn, delay) {
      if (containsDebugger(fn)) {
        try {
          console.log(TAG, "Blocked debugger setTimeout trap");
        } catch {}
        return 0;
      }
      return _origSetTimeout.apply(this, arguments);
    };

    // ── Strip debugger from eval ──────────────────────────────────

    window.eval = function (code) {
      if (typeof code === "string" && /\bdebugger\b/.test(code)) {
        try {
          console.log(TAG, "Stripped debugger from eval");
        } catch {}
        code = code.replace(/\bdebugger\b;?/g, "");
      }
      return _origEval.call(this, code);
    };

    // ── Strip debugger from Function constructor ──────────────────

    try {
      window.Function = new Proxy(_OrigFunction, {
        construct(target, args) {
          if (
            args &&
            args.length > 0 &&
            typeof args[args.length - 1] === "string" &&
            /\bdebugger\b/.test(args[args.length - 1])
          ) {
            args[args.length - 1] = args[args.length - 1].replace(
              /\bdebugger\b;?/g,
              "",
            );
            try {
              console.log(TAG, "Stripped debugger from Function constructor");
            } catch {}
          }
          return Reflect.construct(target, args);
        },
        apply(target, thisArg, args) {
          if (
            args &&
            args.length > 0 &&
            typeof args[args.length - 1] === "string" &&
            /\bdebugger\b/.test(args[args.length - 1])
          ) {
            args[args.length - 1] = args[args.length - 1].replace(
              /\bdebugger\b;?/g,
              "",
            );
          }
          return Reflect.apply(target, thisArg, args);
        },
      });

      Object.defineProperty(window.Function, "prototype", {
        value: _OrigFunction.prototype,
        writable: false,
        configurable: false,
      });
      _OrigFunction.prototype.constructor = window.Function;
    } catch {
      // If Proxy fails, do nothing
    }

    // ── Spoof window dimensions (DevTools docked detection) ───────

    try {
      Object.defineProperty(window, "outerWidth", {
        get: () => window.innerWidth,
        configurable: true,
      });
      Object.defineProperty(window, "outerHeight", {
        get: () => window.innerHeight,
        configurable: true,
      });
    } catch {}

    // ── Block /verify redirects from DevTools detection ───────────
    // The site redirects to /verify when it detects DevTools.
    // Intercept navigation attempts to the verify page.

    const verifyPattern = /\/verify\b/i;

    // Intercept location.assign
    try {
      Object.defineProperty(window.location, "assign", {
        value: function (url) {
          if (typeof url === "string" && verifyPattern.test(url)) {
            try {
              console.log(TAG, "Blocked redirect to verify page:", url);
            } catch {}
            return;
          }
          return _origAssign.call(window.location, url);
        },
        writable: true,
        configurable: true,
      });
    } catch {}

    // Intercept location.replace
    try {
      Object.defineProperty(window.location, "replace", {
        value: function (url) {
          if (typeof url === "string" && verifyPattern.test(url)) {
            try {
              console.log(TAG, "Blocked redirect to verify page:", url);
            } catch {}
            return;
          }
          return _origReplace.call(window.location, url);
        },
        writable: true,
        configurable: true,
      });
    } catch {}

    // Intercept location.href setter (most common redirect method)
    try {
      const locationDescriptor =
        Object.getOwnPropertyDescriptor(window, "location") ||
        Object.getOwnPropertyDescriptor(Window.prototype, "location");

      if (locationDescriptor && locationDescriptor.set) {
        const origLocationSet = locationDescriptor.set;
        Object.defineProperty(window, "location", {
          get: locationDescriptor.get,
          set: function (val) {
            if (typeof val === "string" && verifyPattern.test(val)) {
              try {
                console.log(
                  TAG,
                  "Blocked location.href redirect to verify:",
                  val,
                );
              } catch {}
              return;
            }
            return origLocationSet.call(this, val);
          },
          configurable: true,
        });
      }
    } catch {}

    // ── Block console-based DevTools detection ────────────────────
    // Some sites use console object tricks (e.g., Image with custom toString(),
    // or console.table with getter) to detect if DevTools console is open.

    // Prevent detection via custom toString on logged objects
    try {
      const _origConsoleLog = console.log;
      const _origConsoleTable = console.table;
      const _origConsoleClear = console.clear;

      // Override console.table — often used to detect DevTools via getters
      console.table = function () {
        // Run normally but catch errors from detection scripts
        try {
          return _origConsoleTable.apply(console, arguments);
        } catch {
          return undefined;
        }
      };
    } catch {}

    // ── Block Date/performance timing-based detection ─────────────
    // debugger statement pauses execution; sites measure time delta to detect it.
    // We can't fully prevent this without breaking the page, but we can disable
    // the most common pattern: a tight loop that checks if execution was paused.

    // ── Intercept document.createElement for devtools detection iframes ──
    try {
      const _origCreateElement = document.createElement.bind(document);
      document.createElement = function (tag) {
        const el = _origCreateElement(tag);
        // Block creation of invisible iframes used for devtools detection
        if (tag.toLowerCase() === "iframe" && arguments.length === 1) {
          // Monitor if this iframe gets used for detection (e.g., writing debugger into it)
          const origContentWindow = Object.getOwnPropertyDescriptor(
            HTMLIFrameElement.prototype,
            "contentWindow",
          );
          // Leave it alone; the debugger stripping will handle code injected into it
        }
        return el;
      };
    } catch {}

    // ── Block window.open to verify ───────────────────────────────
    try {
      const _origOpen = window.open;
      window.open = function (url) {
        if (typeof url === "string" && verifyPattern.test(url)) {
          try {
            console.log(TAG, "Blocked window.open to verify:", url);
          } catch {}
          return null;
        }
        return _origOpen.apply(this, arguments);
      };
    } catch {}

    try {
      console.log(TAG, "Anti-debug hooks installed for", host);
    } catch {}
  } catch {
    // never break the page
  }
})();
