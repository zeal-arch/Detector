/**
 * tmovie-antidebug-hook.js — MAIN world anti-debugger neutralizer
 *
 * Content scripts run in an isolated world; they cannot reliably override
 * page-world Function/eval/timers that are commonly used for DevTools traps.
 *
 * This hook runs in the MAIN world at document_start on tmovie.tv to:
 * - drop timer/eval/function-constructor payloads containing `debugger`
 * - reduce DevTools detection via window dimension heuristics
 */
(function () {
  "use strict";

  try {
    const host = String((window.location && window.location.hostname) || "");
    if (!(host === "tmovie.tv" || host.endsWith(".tmovie.tv"))) return;

    const TAG = "[TmovieAntiDebug]";

    const _origSetInterval = window.setInterval;
    const _origSetTimeout = window.setTimeout;
    const _origEval = window.eval;
    const _OrigFunction = window.Function;

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

    // Strip debugger from eval strings
    window.eval = function (code) {
      if (typeof code === "string" && /\bdebugger\b/.test(code)) {
        try {
          console.log(TAG, "Stripped debugger from eval");
        } catch {}
        code = code.replace(/\bdebugger\b;?/g, "");
      }
      return _origEval.call(this, code);
    };

    // Strip debugger from Function constructor strings
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

      // Keep prototype chain stable for common checks
      Object.defineProperty(window.Function, "prototype", {
        value: _OrigFunction.prototype,
        writable: false,
        configurable: false,
      });
      _OrigFunction.prototype.constructor = window.Function;
    } catch {
      // If Proxy fails, do nothing (best effort)
    }

    // Reduce window-size based DevTools heuristics
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
  } catch {
    // never break the page
  }
})();
