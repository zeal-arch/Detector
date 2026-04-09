(function () {
  if (window.__ig_ext_hooked__) return;
  window.__ig_ext_hooked__ = true;

  var M = "__instagram_extractor__";
  var S = new Set();

  var oF = window.fetch;
  window.fetch = function (i, p) {
    var r = oF.apply(this, arguments);
    try {
      var u = typeof i === "string" ? i : (i && i.url) || "";
      if (
        u.indexOf("/graphql/query") > -1 ||
        u.indexOf("/api/graphql") > -1 ||
        u.indexOf("/api/v1/media/") > -1
      ) {
        r.then(function (res) {
          return res.clone().json();
        })
          .then(function (d) {
            var v = [];
            fV(d, v, 0);
            if (v.length)
              window.postMessage(
                { type: M, action: "API_VIDEOS", videos: v },
                "*",
              );
          })
          .catch(function () {});
      }
    } catch (e) {}
    return r;
  };

  var oO = XMLHttpRequest.prototype.open;
  var oS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) {
    this._u = u;
    return oO.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    var x = this;
    var u = this._u || "";
    if (u.indexOf("/graphql/query") > -1 || u.indexOf("/api/v1/media/") > -1) {
      x.addEventListener("load", function () {
        try {
          var d = JSON.parse(x.responseText);
          var v = [];
          fV(d, v, 0);
          if (v.length)
            window.postMessage(
              { type: M, action: "API_VIDEOS", videos: v },
              "*",
            );
        } catch (e) {}
      });
    }
    return oS.apply(this, arguments);
  };

  function fV(o, r, d) {
    if (!o || typeof o !== "object" || d > 20) return;
    if (o.video_url && typeof o.video_url === "string") {
      var id = String(o.id || o.pk || o.shortcode || "");
      if (id && !S.has(id)) {
        S.add(id);
        r.push({
          id: id,
          shortcode: o.shortcode || o.code || null,
          videoUrl: o.video_url,
          width: o.original_width || o.width || 0,
          height: o.original_height || o.height || 0,
          duration: o.video_duration || 0,
        });
      }
    }
    if (
      o.video_versions &&
      Array.isArray(o.video_versions) &&
      o.video_versions.length
    ) {
      var b = o.video_versions.slice().sort(function (a, b) {
        return (
          (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0)
        );
      })[0];
      if (b && b.url) {
        var id2 = String(o.id || o.pk || o.code || "");
        if (id2 && !S.has(id2)) {
          S.add(id2);
          r.push({
            id: id2,
            shortcode: o.code || null,
            videoUrl: b.url,
            width: b.width || 0,
            height: b.height || 0,
            duration: o.video_duration || 0,
            allVersions: o.video_versions.map(function (v) {
              return { url: v.url, width: v.width || 0, height: v.height || 0 };
            }),
          });
        }
      }
    }
    if (Array.isArray(o)) {
      for (var i = 0; i < o.length; i++) fV(o[i], r, d + 1);
    } else {
      for (var k in o) if (o.hasOwnProperty(k)) fV(o[k], r, d + 1);
    }
  }
})();
