(function () {
    'use strict';

    function notifyBackground(videoData) {
        window.postMessage({
            type: 'MAGIC_M3U8_DETECTION',
            source: 'SITE_SPECIALIST',
            data: videoData
        }, '*');
    }

    function hashString(str, seed = 0) {
        let h1 = 3735928559 ^ seed,
            h2 = 1103547991 ^ seed;
        for (let i = 0, ch; i < str.length; i++) {
            ch = str.charCodeAt(i);
            h1 = Math.imul(h1 ^ ch, 2654435761);
            h2 = Math.imul(h2 ^ ch, 1597334677);
        }
        h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
        h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
        h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
        h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
        return 4294967296 * (2097151 & h2) + (h1 >>> 0);
    }

    const DRM_PROVIDERS = new Set([
        'com.microsoft.playready',
        'com.apple.streamingkeydelivery',
        'com.widevine.alpha'
    ]);

    const processedHashes = new Set();
    let lastProcessedVideoId = null;

    function hasDRM(config) {
        if (!config) return false;

        if (config.request?.files?.drm) return true;

        const keys = config.request?.files?.drm_keys;
        if (keys && Object.keys(keys).some((k) => DRM_PROVIDERS.has(k))) {
            return true;
        }

        return false;
    }

    function extractVideoId(url) {

        let match = url.match(
            /vimeo\.com\/(?:channels\/[^/]+\/|groups\/[^/]+\/videos\/|album\/[^/]+\/video\/|video\/|)(\d+)/
        );
        if (match) return match[1];

        match = url.match(/player\.vimeo\.com\/video\/(\d+)/);
        if (match) return match[1];

        return null;
    }

    function formatDuration(seconds) {
        if (!seconds || typeof seconds !== 'number') return null;
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${String(secs).padStart(2, '0')}`;
    }

    function extractSubtitles(config) {
        const subtitles = [];

        const textTracks = config.request?.text_tracks;
        if (textTracks && Array.isArray(textTracks)) {
            for (const track of textTracks) {
                if (track.url) {
                    subtitles.push({
                        url: track.url,
                        lang: track.lang || 'en',
                        name: track.label || track.lang || 'Unknown',
                        kind: track.kind || 'subtitles',
                        formats: {
                            vtt: track.url
                        }
                    });
                }
            }
        }

        return subtitles;
    }

    function extractChapters(config) {
        const chapters = [];

        const chapterData =
            config.video?.chapters || config.seo?.chapters || config.chapters;

        if (chapterData && Array.isArray(chapterData)) {
            for (const chapter of chapterData) {
                chapters.push({
                    title: chapter.title || chapter.text,
                    startTime: chapter.timecode || chapter.start || 0,
                    thumbnail: chapter.thumbnail
                });
            }
        }

        return chapters;
    }

    function extractQualityVariants(files) {
        const qualities = [];

        if (files.progressive) {
            for (const p of files.progressive) {
                if (p.quality) {
                    qualities.push({
                        label: p.quality,
                        height: p.height,
                        width: p.width,
                        fps: p.fps,
                        type: 'progressive'
                    });
                }
            }
        }

        return qualities;
    }

    function processConfig(config, videoId) {
        if (!config || !config.request || !config.request.files) return;

        const files = config.request.files;
        const videoData = config.video || {};
        const owner = videoData.owner || {};

        const isDRM = hasDRM(config);
        if (isDRM) {
            console.log('[Vimeo Specialist] DRM protected content detected');
        }

        const subtitles = extractSubtitles(config);
        const chapters = extractChapters(config);
        const qualities = extractQualityVariants(files);

        const options = {

            customTitle:
                videoData.title || document.title.replace(' on Vimeo', ''),
            thumbnail:
                videoData.thumbs?.['1280'] ||
                videoData.thumbs?.['640'] ||
                videoData.thumbs?.base,
            duration: formatDuration(videoData.duration),
            durationSeconds: videoData.duration,
            stableId: `vimeo_${videoId}`,
            videoId: videoId,

            author: owner.name,
            authorId: owner.id,
            authorUrl: owner.url,
            authorAvatar: owner.img,
            isVerified: owner.verified,

            description: videoData.description || config.seo?.description,
            privacy: videoData.privacy,
            uploadDate: videoData.upload_date,
            releaseDate: videoData.release_date,

            subtitles: subtitles.length > 0 ? subtitles : null,
            chapters: chapters.length > 0 ? chapters : null,
            availableQualities: qualities,

            hasDRM: isDRM,
            width: videoData.width,
            height: videoData.height,
            fps: videoData.fps,
            platform: 'vimeo'
        };

        console.log('[Vimeo Specialist] Extracted metadata:', {
            title: options.customTitle,
            author: options.author,
            subtitles: subtitles.length,
            chapters: chapters.length,
            hasDRM: isDRM
        });

        if (files.hls && files.hls.cdns) {
            const cdnKey = files.hls.default_cdn;
            const hlsCdn =
                files.hls.cdns[cdnKey] || Object.values(files.hls.cdns)[0];

            if (hlsCdn && hlsCdn.url) {
                const hash = hashString(hlsCdn.url);
                if (!processedHashes.has(hash)) {
                    processedHashes.add(hash);
                    notifyBackground({
                        url: hlsCdn.url,
                        type: 'HLS',
                        options: { ...options, cdn: cdnKey }
                    });
                }
            }
        }

        if (files.dash && files.dash.cdns) {
            const cdnKey = files.dash.default_cdn;
            const dashCdn =
                files.dash.cdns[cdnKey] || Object.values(files.dash.cdns)[0];

            if (dashCdn && dashCdn.url) {
                const hash = hashString(dashCdn.url);
                if (!processedHashes.has(hash)) {
                    processedHashes.add(hash);
                    notifyBackground({
                        url: dashCdn.url,
                        type: 'DASH',
                        options: { ...options, cdn: cdnKey }
                    });
                }
            }
        }

        if (files.progressive && files.progressive.length > 0) {

            const sorted = [...files.progressive].sort((a, b) => (b.height || 0) - (a.height || 0));
            const best = sorted[0];

            if (best && best.url) {
                const hash = hashString(best.url);
                if (!processedHashes.has(hash)) {
                    processedHashes.add(hash);
                    notifyBackground({
                        url: best.url,
                        type: 'MP4',
                        options: {
                            ...options,
                            quality: best.quality,
                            streamType: 'progressive'
                        }
                    });
                }
            }
        }
    }

    async function fetchPlayerConfig(videoId) {
        try {
            const url = `https://player.vimeo.com/video/${videoId}/config`;
            const response = await fetch(url, {
                credentials: 'include',
                headers: {
                    'Accept': 'application/json'
                }
            });

            if (!response.ok) {
                console.debug('[Vimeo Specialist] Config fetch failed:', response.status);
                return null;
            }

            return await response.json();
        } catch (err) {
            console.debug('[Vimeo Specialist] Config fetch error:', err);
            return null;
        }
    }

    function findEmbeddedConfig() {

        if (window.vimeo && window.vimeo.config) {
            return window.vimeo.config;
        }

        const scripts = document.querySelectorAll('script');
        for (const script of scripts) {
            const text = script.textContent || '';

            if (text.includes('"request"') && text.includes('"files"')) {
                try {

                    const match = text.match(/\{[^}]*"request"[^}]*"files".*\}/);
                    if (match) {
                        return JSON.parse(match[0]);
                    }
                } catch {

                }
            }
        }

        return null;
    }

    async function extractVimeoMetadata() {
        const url = location.href;
        const videoId = extractVideoId(url);

        if (!videoId) return;
        if (videoId === lastProcessedVideoId) return;

        console.log('[Vimeo Specialist] Processing video:', videoId);

        let config = findEmbeddedConfig();

        if (config) {
            processConfig(config, videoId);
            lastProcessedVideoId = videoId;
            return;
        }

        config = await fetchPlayerConfig(videoId);
        if (config) {
            processConfig(config, videoId);
            lastProcessedVideoId = videoId;
        }
    }

    function handleEmbeds() {

        if (location.hostname === 'player.vimeo.com') {

            const config = window.vimeo?.config || window.player?.config;
            if (config) {
                const videoId = extractVideoId(location.href);
                if (videoId) {
                    processConfig(config, videoId);
                }
            }
        }
    }

    extractVimeoMetadata();
    handleEmbeds();
    setTimeout(extractVimeoMetadata, 500);
    setTimeout(extractVimeoMetadata, 1000);
    setTimeout(extractVimeoMetadata, 2000);

    window.addEventListener('popstate', () => {
        lastProcessedVideoId = null;
        extractVimeoMetadata();
        setTimeout(extractVimeoMetadata, 500);
    });

    let debounceTimer = null;
    const observer = new MutationObserver(() => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            if (extractVideoId(location.href)) {
                extractVimeoMetadata();
            }
        }, 300);
    });

    observer.observe(document.documentElement, { childList: true, subtree: true });

    let lastUrl = location.href;
    setInterval(() => {
        if (location.href !== lastUrl) {
            lastUrl = location.href;
            lastProcessedVideoId = null;
            extractVimeoMetadata();
        }
    }, 500);

})();
