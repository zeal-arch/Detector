(function () {
    'use strict';

    console.log('[Rumble Specialist] Loaded on:', window.location.href);

    const processedVideos = new Set();

    function notifyBackground(videoData) {
        const hash = `${videoData.url}_${videoData.title}`.replace(/[^a-zA-Z0-9]/g, '');
        if (processedVideos.has(hash)) return;
        processedVideos.add(hash);

        window.postMessage({
            type: 'MAGIC_M3U8_DETECTION',
            source: 'SITE_SPECIALIST',
            data: {
                url: videoData.url,
                type: 'MP4',
                options: videoData
            }
        }, '*');

        window.__SPECIALIST_DETECTED = true;
    }

    async function extractVideo() {
        try {

            const config = window.RumblePlayer?.config || window.rumblePlayerConfig;
            if (config) {
                const videoData = extractFromConfig(config);
                if (videoData) {
                    notifyBackground(videoData);
                    return;
                }
            }

            const pageData = extractFromPage();
            if (pageData) {
                notifyBackground(pageData);
            }

        } catch (err) {
            console.error('[Rumble] Extraction error:', err);
        }
    }

    function extractFromConfig(config) {
        if (!config.media || !config.media.mp4) return null;

        const mp4 = config.media.mp4;

        let bestUrl = null;
        let bestQuality = 0;

        for (const [quality, url] of Object.entries(mp4)) {
            const qualityNum = parseInt(quality) || 0;
            if (qualityNum > bestQuality && url) {
                bestQuality = qualityNum;
                bestUrl = url;
            }
        }

        if (!bestUrl) return null;

        return {
            url: bestUrl,
            customTitle: config.title || document.title,
            author: config.author?.name,
            authorUrl: config.author?.url,
            thumbnail: config.image,
            viewCount: config.views,
            duration: config.duration,
            quality: bestQuality ? `${bestQuality}p` : undefined,
            uploadDate: config.pubDate,
            pageUrl: window.location.href,
        };
    }

    function extractFromPage() {

        const scripts = document.querySelectorAll('script');
        for (const script of scripts) {
            const text = script.textContent;

            const mp4Match = text.match(/"([^"]+\.mp4[^"]*)"/);
            if (mp4Match) {
                return {
                    url: mp4Match[1],
                    customTitle: document.title,
                    thumbnail: document.querySelector('meta[property="og:image"]')?.content,
                    pageUrl: window.location.href,
                };
            }
        }

        const videoEl = document.querySelector('video[src]');
        if (videoEl && videoEl.src) {
            return {
                url: videoEl.src,
                customTitle: document.title,
                thumbnail: videoEl.poster,
                width: videoEl.videoWidth,
                height: videoEl.videoHeight,
                pageUrl: window.location.href,
            };
        }

        return null;
    }

    window.__SPECIALIST_DETECTED = false;
    extractVideo();
    setTimeout(extractVideo, 500);
    setTimeout(extractVideo, 1000);
    setTimeout(extractVideo, 2000);

    let lastUrl = window.location.href;
    new MutationObserver(() => {
        if (window.location.href !== lastUrl) {
            lastUrl = window.location.href;
            processedVideos.clear();
            setTimeout(extractVideo, 300);
        }
    }).observe(document.documentElement, {
        childList: true,
        subtree: true
    });

    console.log('[Rumble Specialist] Initialized');
})();
