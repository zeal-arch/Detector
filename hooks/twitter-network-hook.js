(function () {
  "use strict";

  const MAGIC = "__twitter_extractor__";
  const seenVideos = new Set();
  const seenPhotos = new Set();

  function processApiResponse(data) {
    var videos = [];
    findVideoEntities(data, videos);
    if (videos.length > 0) {
      window.postMessage(
        {
          type: MAGIC,
          action: "API_VIDEOS",
          videos: videos,
          tweetUrl: window.location.href,
        },
        "*",
      );
    }

    var photos = [];
    findPhotoEntities(data, photos);
    if (photos.length > 0) {
      window.postMessage(
        {
          type: MAGIC,
          action: "API_PHOTOS",
          photos: photos,
          tweetUrl: window.location.href,
        },
        "*",
      );
    }
  }

  var origFetch = window.fetch;
  window.fetch = async function (input, init) {
    var response = await origFetch.apply(this, arguments);
    try {
      var url = typeof input === "string" ? input : input?.url || "";

      if (
        url.includes("/graphql/") &&
        /Tweet|timeline|UserMedia|HomeTimeline|TweetDetail|SearchTimeline/i.test(
          url,
        )
      ) {
        var clone = response.clone();
        clone
          .json()
          .then(processApiResponse)
          .catch(function () {});
      }
    } catch (e) {}
    return response;
  };

  var origXhrOpen = XMLHttpRequest.prototype.open;
  var origXhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this._twUrl = url;
    return origXhrOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    var xhr = this;
    var url = this._twUrl || "";
    if (
      url.includes("/graphql/") &&
      /Tweet|timeline|UserMedia|HomeTimeline|TweetDetail|SearchTimeline/i.test(
        url,
      )
    ) {
      this.addEventListener("load", function () {
        try {
          processApiResponse(JSON.parse(xhr.responseText));
        } catch (e) {}
      });
    }
    return origXhrSend.apply(this, arguments);
  };

  function findVideoEntities(obj, results, depth) {
    if (!obj || typeof obj !== "object" || (depth || 0) > 15) return;
    var d = (depth || 0) + 1;

    if (obj.video_info && obj.video_info.variants) {
      var variants = obj.video_info.variants
        .filter(function (v) {
          return v.content_type === "video/mp4";
        })
        .sort(function (a, b) {
          return (b.bitrate || 0) - (a.bitrate || 0);
        });

      if (variants.length > 0) {
        var id = obj.id_str || Math.random().toString(36).substring(2, 10);
        if (!seenVideos.has(id)) {
          seenVideos.add(id);
          results.push({
            id: id,
            variants: variants.map(function (v) {
              return {
                url: v.url,
                bitrate: v.bitrate || 0,
                contentType: v.content_type,
              };
            }),
            duration: obj.video_info.duration_millis || 0,
            aspectRatio: obj.video_info.aspect_ratio || [16, 9],
          });
        }
      }
    }

    if (Array.isArray(obj)) {
      for (var i = 0; i < obj.length; i++)
        findVideoEntities(obj[i], results, d);
    } else {
      var keys = Object.keys(obj);
      for (var k = 0; k < keys.length; k++)
        findVideoEntities(obj[keys[k]], results, d);
    }
  }

  function findPhotoEntities(obj, results, depth) {
    if (!obj || typeof obj !== "object" || (depth || 0) > 15) return;
    var d = (depth || 0) + 1;

    if (obj.type === "photo" && obj.media_url_https) {
      var id = obj.id_str || obj.media_key || obj.media_url_https;
      if (!seenPhotos.has(id)) {
        seenPhotos.add(id);
        var baseUrl = obj.media_url_https;
        var sizes = obj.sizes || {};
        var origW = (sizes.large || sizes.medium || {}).w || 0;
        var origH = (sizes.large || sizes.medium || {}).h || 0;
        results.push({
          id: id,
          url: baseUrl,

          urlOrig: baseUrl + "?format=jpg&name=orig",
          urlLarge: baseUrl + "?format=jpg&name=large",
          url4k: baseUrl + "?format=jpg&name=4096x4096",
          width: origW,
          height: origH,
          altText: obj.ext_alt_text || "",
        });
      }
    }

    if (Array.isArray(obj)) {
      for (var i = 0; i < obj.length; i++)
        findPhotoEntities(obj[i], results, d);
    } else {
      var keys = Object.keys(obj);
      for (var k = 0; k < keys.length; k++)
        findPhotoEntities(obj[keys[k]], results, d);
    }
  }
})();
