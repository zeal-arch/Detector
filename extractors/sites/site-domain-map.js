const SITE_DOMAIN_MAP = {
  "youtube/youtube.js": {
    domains: ["*.youtube.com", "*.youtu.be", "music.youtube.com"],
    protocol: "BASE_CLASS",
    pattern: "BaseExtractor",
    className: "YouTubeExtractor",
    verified: true,
    notes: "Injected via dedicated content.js + inject.js MAIN world bridge",
  },

  "twitter.js": {
    domains: ["*.twitter.com", "*.x.com"],
    protocol: "BASE_CLASS",
    pattern: "BaseExtractor",
    className: "TwitterExtractor",
    verified: true,
    notes:
      "Handles twitter.com and x.com; extracts mp4 variants from GraphQL API",
  },

  "instagram.js": {
    domains: ["*.instagram.com"],
    protocol: "BASE_CLASS",
    pattern: "BaseExtractor",
    className: "InstagramExtractor",
    verified: true,
    notes:
      "Multi-tier extraction: GraphQL API, v1 REST API, page parsing, XHR hooks, DOM scanning",
  },

  "facebook.js": {
    domains: ["*.facebook.com", "*.fb.watch", "*.fb.com"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: true,
    notes:
      "DASH/HLS manifest, direct MP4, live video. Handles Watch, Reels, Posts",
  },

  "tiktok.js": {
    domains: ["*.tiktok.com", "vm.tiktok.com"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: true,
    notes: "Extracts from __UNIVERSAL_DATA_FOR_REHYDRATION__",
  },

  "reddit.js": {
    domains: ["*.reddit.com", "old.reddit.com"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: true,
    notes: "Uses Reddit JSON API (.json appended to URL)",
  },

  "vimeo.js": {
    domains: ["*.vimeo.com", "player.vimeo.com"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: true,
    notes:
      "HLS/DASH/Progressive, subtitles, chapters, DRM detection, embed support",
  },

  "twitch.js": {
    domains: ["*.twitch.tv", "clips.twitch.tv"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: true,
    notes: "VODs, Clips, Live streams",
  },

  "dailymotion.js": {
    domains: ["*.dailymotion.com"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: true,
    notes: "Multiple quality formats, subtitle support",
  },

  "bilibili.js": {
    domains: ["*.bilibili.com"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: true,
    notes:
      "China's largest video platform. Extracts from __playinfo__ and __INITIAL_STATE__",
  },

  "rumble.js": {
    domains: ["*.rumble.com"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: true,
    notes: "Direct MP4 extraction, multiple quality formats",
  },

  "kick.js": {
    domains: ["*.kick.com"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: true,
    notes: "Live streaming, HLS patterns",
  },

  "netflix.js": {
    domains: ["*.netflix.com"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: true,
    notes: "DRM protected — metadata capture only",
  },

  "spotify.js": {
    domains: ["*.spotify.com", "open.spotify.com"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: true,
    notes: "DRM protected — video podcast/show metadata only",
  },

  "soundcloud.js": {
    domains: ["*.soundcloud.com"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: true,
    notes: "Audio extraction from __sc_hydration",
  },

  "linkedin.js": {
    domains: ["*.linkedin.com"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: true,
    notes: "MP4 video extraction from video elements",
  },

  "pinterest.js": {
    domains: ["*.pinterest.com", "*.pinterest.co.uk"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: true,
    notes: "Extracts from data-relay-response scripts",
  },

  "hbomax.js": {
    domains: ["*.max.com", "*.hbomax.com"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: true,
    notes: "DRM protected — metadata only. Now rebranded as Max",
  },

  "disneyplus.js": {
    domains: ["*.disneyplus.com"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: true,
    notes: "DRM protected — metadata only",
  },

  "primevideo.js": {
    domains: ["*.primevideo.com", "*.amazon.com/gp/video"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: true,
    notes: "DRM protected — metadata only. Extracts ASIN from URL",
  },

  "ok.js": {
    domains: ["*.ok.ru"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: true,
    notes:
      "Odnoklassniki (Russian social network). HLS/DASH, videoembed endpoint, mobile site",
  },

  "iq.js": {
    domains: ["*.iq.com"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: true,
    notes: "iQIYI International. M3U8 from dash config",
  },

  "vk.js": {
    domains: ["*.vk.com", "*.vk.ru", "*.vkvideo.ru"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: true,
    notes: "VK/VKVideo. HLS from VK API, supports vk.com, vk.ru, vkvideo.ru",
  },

  "nrk.js": {
    domains: ["*.nrk.no", "tv.nrk.no"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: true,
    notes: "Norwegian Broadcasting Corporation",
  },

  "svt.js": {
    domains: ["*.svtplay.se", "*.svt.se"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: true,
    notes: "Swedish Television (SVT Play)",
  },

  "abcnews.js": {
    domains: ["*.abcnews.go.com", "abcnews.go.com"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: false,
    notes: "ABC News",
  },

  "afreeca.js": {
    domains: ["*.afreecatv.com"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: false,
    notes: "AfreecaTV — Korean streaming platform",
  },

  "archive.js": {
    domains: ["*.archive.org"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: true,
    notes: "Internet Archive",
  },

  "bandcamp.js": {
    domains: ["*.bandcamp.com"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: false,
    notes: "Music/audio platform",
  },

  "bbc.js": {
    domains: ["*.bbc.co.uk", "*.bbc.com", "www.bbc.co.uk/iplayer"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: false,
    notes: "BBC iPlayer and BBC News",
  },

  "bitchute.js": {
    domains: ["*.bitchute.com"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: false,
    notes: "Alternative video platform",
  },

  "brightcove.js": {
    domains: ["*.brightcove.com", "players.brightcove.net"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: true,
    notes: "Brightcove embedded player — used across many sites",
  },

  "canva.js": {
    domains: ["*.canva.com"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: true,
    notes: "Canva watch pages, video exports, embedded players. HLS extraction",
  },

  "cbsnews.js": {
    domains: ["*.cbsnews.com"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: false,
    notes: "CBS News video content",
  },

  "cnn.js": {
    domains: ["*.cnn.com", "edition.cnn.com"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: false,
    notes: "CNN video content",
  },

  "coub.js": {
    domains: ["*.coub.com"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: true,
    notes: "Looping video platform",
  },

  "coursera.js": {
    domains: ["*.coursera.org"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: false,
    notes: "Online education platform",
  },

  "crunchyroll.js": {
    domains: ["*.crunchyroll.com"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: false,
    notes: "Anime streaming — likely DRM protected",
  },

  "deezer.js": {
    domains: ["*.deezer.com"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: false,
    notes: "Music streaming platform",
  },

  "dropbox.js": {
    domains: ["*.dropbox.com"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: false,
    notes: "Shared video files on Dropbox",
  },

  "drtv.js": {
    domains: ["*.dr.dk"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: true,
    notes: "DR TV — Danish Broadcasting Corporation",
  },

  "dtube.js": {
    domains: ["*.d.tube"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: true,
    notes: "DTube — decentralized video platform",
  },

  "espn.js": {
    domains: ["*.espn.com", "www.espn.com"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: false,
    notes: "ESPN sports videos",
  },

  "flickr.js": {
    domains: ["*.flickr.com"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: false,
    notes: "Flickr video content",
  },

  "flixtor.js": {
    domains: ["*.flixtor.li", "*.flixtor.to"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: true,
    notes: "Streaming site — API interception for m3u8 URLs",
  },

  "foxnews.js": {
    domains: ["*.foxnews.com", "video.foxnews.com"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: false,
    notes: "Fox News video content",
  },

  "gfycat.js": {
    domains: ["*.gfycat.com"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: true,
    notes: "GIF/video platform (service largely shut down)",
  },

  "hulu.js": {
    domains: ["*.hulu.com"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: false,
    notes: "DRM protected streaming service",
  },

  "imgur.js": {
    domains: ["*.imgur.com", "i.imgur.com"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: false,
    notes: "Image/video hosting",
  },

  "iqiyi.js": {
    domains: ["*.iqiyi.com"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: true,
    notes: "iQiyi — Chinese streaming platform (domestic version)",
  },

  "jwplayer.js": {
    domains: ["*.jwplayer.com", "cdn.jwplayer.com"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: true,
    notes: "JW Player embedded video — used across ~30% of video sites",
  },

  "kaltura.js": {
    domains: ["*.kaltura.com", "cdnapisec.kaltura.com"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: true,
    notes: "Kaltura embedded video player",
  },

  "khanacademy.js": {
    domains: ["*.khanacademy.org"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: false,
    notes: "Khan Academy educational videos",
  },

  "loom.js": {
    domains: ["*.loom.com"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: true,
    notes: "Loom video recording platform",
  },

  "metacafe.js": {
    domains: ["*.metacafe.com"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: true,
    notes: "Metacafe video platform",
  },

  "mixcloud.js": {
    domains: ["*.mixcloud.com"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: false,
    notes: "DJ mix/audio platform",
  },

  "mlb.js": {
    domains: ["*.mlb.com"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: false,
    notes: "Major League Baseball videos",
  },

  "nba.js": {
    domains: ["*.nba.com"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: true,
    notes: "NBA video content",
  },

  "nbcnews.js": {
    domains: ["*.nbcnews.com"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: false,
    notes: "NBC News video content",
  },

  "nfl.js": {
    domains: ["*.nfl.com"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: false,
    notes: "NFL video content",
  },

  "niconico.js": {
    domains: ["*.nicovideo.jp", "*.niconico.com"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: true,
    notes: "Niconico — Japan's largest video platform",
  },

  "ninegag.js": {
    domains: ["*.9gag.com"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: true,
    notes: "9GAG — GraphQL API extraction",
  },

  "nytimes.js": {
    domains: ["*.nytimes.com"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: false,
    notes: "New York Times video content",
  },

  "odysee.js": {
    domains: ["*.odysee.com"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: true,
    notes: "Odysee/LBRY — decentralized video platform",
  },

  "paramountplus.js": {
    domains: ["*.paramountplus.com"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: true,
    notes: "DRM protected — metadata only",
  },

  "peacock.js": {
    domains: ["*.peacocktv.com"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: true,
    notes: "DRM protected — metadata only",
  },

  "peertube.js": {
    domains: ["*"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: true,
    notes: "PeerTube — federated/self-hosted instances on any domain",
  },

  "pornhub.js": {
    domains: ["*.pornhub.com"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: false,
    notes: "Adult video platform",
  },

  "redgifs.js": {
    domains: ["*.redgifs.com"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: true,
    notes: "RedGifs GIF/video platform",
  },

  "rutube.js": {
    domains: ["*.rutube.ru"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: false,
    notes: "Russian video platform",
  },

  "skillshare.js": {
    domains: ["*.skillshare.com"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: false,
    notes: "Online learning platform",
  },

  "streamable.js": {
    domains: ["*.streamable.com"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: false,
    notes: "Short video hosting",
  },

  "ted.js": {
    domains: ["*.ted.com"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: false,
    notes: "TED Talks",
  },

  "udemy.js": {
    domains: ["*.udemy.com"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: false,
    notes: "Online courses platform",
  },

  "vevo.js": {
    domains: ["*.vevo.com"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: false,
    notes: "Music video platform",
  },

  "vidyard.js": {
    domains: ["*.vidyard.com", "play.vidyard.com"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: true,
    notes: "Vidyard embedded video player",
  },

  "vimeo-ott.js": {
    domains: ["*.vhx.tv", "*.vimeo.com/ott"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: true,
    notes: "Vimeo OTT platforms (VHX-powered)",
  },

  "vkvideo.js": {
    domains: ["*.vkvideo.ru"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: true,
    notes: "VK Video standalone platform",
  },

  "vlare.js": {
    domains: ["*.vlare.tv"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: true,
    notes: "Vlare — YouTube alternative",
  },

  "vlive.js": {
    domains: ["*.vlive.tv"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: true,
    notes: "V LIVE — K-pop/Korean streaming (now merged into Weverse)",
  },

  "washingtonpost.js": {
    domains: ["*.washingtonpost.com"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: false,
    notes: "Washington Post video content",
  },

  "weibo.js": {
    domains: ["*.weibo.com", "*.weibo.cn"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: true,
    notes: "Weibo — Chinese social media",
  },

  "wistia.js": {
    domains: ["*.wistia.com", "fast.wistia.com", "*.wistia.net"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: true,
    notes: "Wistia embedded video player",
  },

  "xhamster.js": {
    domains: ["*.xhamster.com"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: false,
    notes: "Adult video platform",
  },

  "xvideos.js": {
    domains: ["*.xvideos.com"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: false,
    notes: "Adult video platform",
  },

  "youku.js": {
    domains: ["*.youku.com"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: true,
    notes: "Youku — Chinese video platform",
  },

  "9now.js": {
    domains: ["*.9now.com.au"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: true,
    notes: "Australian streaming service",
  },

  "abematv.js": {
    domains: ["*.abema.tv"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: true,
    notes: "AbemaTV — Japanese streaming service",
  },

  "acfun.js": {
    domains: ["*.acfun.cn"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: true,
    notes: "AcFun — Chinese video platform",
  },

  "aljazeera.js": {
    domains: ["*.aljazeera.com", "*.aljazeera.net"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: false,
    notes: "Al Jazeera news video",
  },

  "amcplus.js": {
    domains: ["*.amcplus.com"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: false,
    notes: "AMC+ streaming service",
  },

  "anchor.js": {
    domains: ["*.anchor.fm"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: true,
    notes: "Anchor/Spotify Podcasts — audio extraction",
  },

  "ard.js": {
    domains: ["*.ardmediathek.de", "*.ard.de"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: false,
    notes: "ARD Mediathek — German public broadcaster",
  },

  "arte.js": {
    domains: ["*.arte.tv"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: false,
    notes: "ARTE — European culture TV channel",
  },

  "audiomack.js": {
    domains: ["*.audiomack.com"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: false,
    notes: "Music streaming platform",
  },

  "bloomberg.js": {
    domains: ["*.bloomberg.com"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: false,
    notes: "Bloomberg video content",
  },

  "bluesky.js": {
    domains: ["*.bsky.app", "bsky.app"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: false,
    notes: "Bluesky Social video content",
  },

  "britbox.js": {
    domains: ["*.britbox.com", "*.britbox.co.uk"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: false,
    notes: "BritBox — British streaming service",
  },

  "caffeine.js": {
    domains: ["*.caffeine.tv"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: false,
    notes: "Caffeine — live streaming platform",
  },

  "cctv.js": {
    domains: ["*.cctv.com", "*.cntv.cn"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: false,
    notes: "CCTV — China Central Television",
  },

  "cda.js": {
    domains: ["*.cda.pl"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: true,
    notes: "CDA.pl — Poland's most popular video platform",
  },

  "channel4.js": {
    domains: ["*.channel4.com", "*.all4.com"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: false,
    notes: "Channel 4 / All 4 — UK broadcaster",
  },

  "crackle.js": {
    domains: ["*.crackle.com"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: false,
    notes: "Crackle — free streaming service",
  },

  "cspan.js": {
    domains: ["*.c-span.org"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: false,
    notes: "C-SPAN — US government video",
  },

  "curiositystream.js": {
    domains: ["*.curiositystream.com"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: false,
    notes: "CuriosityStream — documentary streaming",
  },

  "daum.js": {
    domains: ["*.daum.net", "tvpot.daum.net"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: false,
    notes: "Daum/Kakao TV — Korean portal",
  },

  "discoveryplus.js": {
    domains: ["*.discoveryplus.com", "*.discovery.com"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: false,
    notes: "Discovery+ streaming service",
  },

  "dlive.js": {
    domains: ["*.dlive.tv"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: false,
    notes: "DLive — blockchain-based streaming",
  },

  "douyin.js": {
    domains: ["*.douyin.com"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: true,
    notes: "Douyin — Chinese TikTok",
  },

  "dropout.js": {
    domains: ["*.dropout.tv"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: false,
    notes: "Dropout — comedy streaming service",
  },

  "dw.js": {
    domains: ["*.dw.com"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: true,
    notes: "Deutsche Welle — German international broadcaster",
  },

  "egghead.js": {
    domains: ["*.egghead.io"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: false,
    notes: "Egghead — developer education",
  },

  "ertflix.js": {
    domains: ["*.ertflix.gr", "*.ert.gr"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: false,
    notes: "ERTflix — Greek public broadcaster",
  },

  "floatplane.js": {
    domains: ["*.floatplane.com"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: false,
    notes: "Floatplane — creator subscription platform",
  },

  "france24.js": {
    domains: ["*.france24.com"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: false,
    notes: "France 24 — French international news",
  },

  "francetv.js": {
    domains: ["*.france.tv", "*.francetv.fr"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: false,
    notes: "France TV — French public broadcaster",
  },

  "gamespot.js": {
    domains: ["*.gamespot.com"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: false,
    notes: "GameSpot — gaming video content",
  },

  "globo.js": {
    domains: [
      "*.globo.com",
      "g1.globo.com",
      "gshow.globo.com",
      "*.globoplay.globo.com",
    ],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: true,
    notes: "Globo — Brazil's largest media company. Multiple subdomains",
  },

  "hotstar.js": {
    domains: ["*.hotstar.com"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: true,
    notes: "Disney+ Hotstar — Indian streaming platform",
  },

  "huya.js": {
    domains: ["*.huya.com"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: false,
    notes: "Huya — Chinese live streaming",
  },

  "ign.js": {
    domains: ["*.ign.com"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: false,
    notes: "IGN — gaming video content",
  },

  "iheart.js": {
    domains: ["*.iheart.com"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: false,
    notes: "iHeartRadio — audio/podcast platform",
  },

  "itv.js": {
    domains: ["*.itv.com", "*.itvx.com"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: false,
    notes: "ITV / ITVX — UK broadcaster",
  },

  "lastfm.js": {
    domains: ["*.last.fm"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: false,
    notes: "Last.fm — music discovery/scrobbling",
  },

  "likee.js": {
    domains: ["*.likee.video", "*.likee.com"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: false,
    notes: "Likee — short video platform",
  },

  "mangotv.js": {
    domains: ["*.mgtv.com"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: true,
    notes: "MangoTV — Chinese streaming (mgtv.com)",
  },

  "masterclass.js": {
    domains: ["*.masterclass.com"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: false,
    notes: "MasterClass — online education",
  },

  "medal.js": {
    domains: ["*.medal.tv"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: false,
    notes: "Medal.tv — gaming clip platform",
  },

  "naver.js": {
    domains: ["*.naver.com", "tv.naver.com"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: false,
    notes: "Naver TV — Korean portal",
  },

  "nebula.js": {
    domains: ["*.nebula.tv", "*.nebula.app"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: false,
    notes: "Nebula — creator-owned streaming service",
  },

  "newgrounds.js": {
    domains: ["*.newgrounds.com"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: false,
    notes: "Newgrounds — animation/games portal",
  },

  "nhk.js": {
    domains: ["*.nhk.or.jp", "www3.nhk.or.jp"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: false,
    notes: "NHK — Japan's public broadcaster",
  },

  "patreon.js": {
    domains: ["*.patreon.com"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: false,
    notes: "Patreon — creator subscription platform",
  },

  "plex.js": {
    domains: ["*.plex.tv", "app.plex.tv"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: false,
    notes: "Plex — media server/streaming",
  },

  "pluralsight.js": {
    domains: ["*.pluralsight.com", "app.pluralsight.com"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: false,
    notes: "Pluralsight — tech education platform",
  },

  "plutotv.js": {
    domains: ["*.pluto.tv"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: false,
    notes: "Pluto TV — free ad-supported streaming",
  },

  "podbean.js": {
    domains: ["*.podbean.com"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: false,
    notes: "Podbean — podcast hosting platform",
  },

  "popcornflix.js": {
    domains: ["*.popcornflix.com"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: false,
    notes: "Popcornflix — free movie streaming",
  },

  "popcornmovies.js": {
    domains: ["*.popcornmovies.org", "popcornmovies.org"],
    protocol: "MAGIC_M3U8",
    pattern: "IIFE",
    verified: false,
    notes:
      "PopcornMovies — free movie/TV streaming. XHR/fetch interception + DOM scanning for HLS/MP4",
  },

  "raiplay.js": {
    domains: ["*.raiplay.it", "*.rai.it"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: false,
    notes: "RAI Play — Italian public broadcaster",
  },

  "reuters.js": {
    domains: ["*.reuters.com"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: false,
    notes: "Reuters — news video content",
  },

  "roku.js": {
    domains: ["*.roku.com", "therokuchannel.roku.com"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: false,
    notes: "The Roku Channel — free streaming",
  },

  "sbs.js": {
    domains: ["*.sbs.com.au"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: false,
    notes: "SBS On Demand — Australian broadcaster",
  },

  "shahid.js": {
    domains: ["*.shahid.mbc.net", "shahid.mbc.net"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: true,
    notes: "Shahid — Middle East streaming (MBC Group)",
  },

  "showtime.js": {
    domains: ["*.showtime.com", "*.sho.com"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: false,
    notes: "Showtime — premium streaming (now part of Paramount+)",
  },

  "skynews.js": {
    domains: ["*.skynews.com.au", "*.news.sky.com"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: false,
    notes: "Sky News video content",
  },

  "snapchat.js": {
    domains: ["*.snapchat.com", "story.snapchat.com"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: true,
    notes: "Snapchat Spotlight — short video content",
  },

  "sonyliv.js": {
    domains: ["*.sonyliv.com"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: false,
    notes: "SonyLIV — Indian streaming service",
  },

  "spreaker.js": {
    domains: ["*.spreaker.com"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: false,
    notes: "Spreaker — podcast platform",
  },

  "starz.js": {
    domains: ["*.starz.com"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: false,
    notes: "Starz — premium streaming service",
  },

  "steam.js": {
    domains: ["*.store.steampowered.com", "*.steampowered.com"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: false,
    notes: "Steam — game trailers/videos",
  },

  "telegram.js": {
    domains: ["*.t.me", "*.telegram.org", "t.me"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: true,
    notes: "Telegram — video in messages/channels",
  },

  "triller.js": {
    domains: ["*.triller.co"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: false,
    notes: "Triller — short video platform",
  },

  "trovo.js": {
    domains: ["*.trovo.live"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: false,
    notes: "Trovo — live streaming platform",
  },

  "tubi.js": {
    domains: ["*.tubitv.com", "*.tubi.tv"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: true,
    notes: "Tubi TV — free ad-supported streaming",
  },

  "tumblr.js": {
    domains: ["*.tumblr.com"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: false,
    notes: "Tumblr — blog/video content",
  },

  "tunein.js": {
    domains: ["*.tunein.com"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: false,
    notes: "TuneIn — radio/podcast streaming",
  },

  "tver.js": {
    domains: ["*.tver.jp"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: false,
    notes: "TVer — Japanese catch-up TV",
  },

  "twitcasting.js": {
    domains: ["*.twitcasting.tv"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: false,
    notes: "TwitCasting — Japanese live streaming",
  },

  "viu.js": {
    domains: ["*.viu.com"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: false,
    notes: "Viu — Asian streaming service",
  },

  "vudu.js": {
    domains: ["*.vudu.com"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: false,
    notes: "Vudu/Fandango at Home — movie rental/purchase",
  },

  "zdf.js": {
    domains: ["*.zdf.de"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: false,
    notes: "ZDF Mediathek — German public broadcaster",
  },

  "zee5.js": {
    domains: ["*.zee5.com"],
    protocol: "LALHLIMPUII_JAHAU",
    pattern: "IIFE",
    verified: false,
    notes: "ZEE5 — Indian streaming service",
  },
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = SITE_DOMAIN_MAP;
}
