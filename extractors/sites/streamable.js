(function () {
    'use strict';

    console.log('[Streamable Specialist] Loaded on:', window.location.href);

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
                options: {
                    customTitle: videoData.title,
                    thumbnail: videoData.thumbnail,
                    quality: videoData.quality,
                    width: videoData.width,
                    height: videoData.height,
                    pageUrl: window.location.href,
                }
            }
        }, '*');

        window.__SPECIALIST_DETECTED = true;
    }

    async function extractVideo() {
        try {
            const videoId = extractVideoId(window.location.href);
            if (!videoId) return;

            const pageData = extractFromPage();
            if (pageData) {
                notifyBackground(pageData);
                return;
            }

            const apiData = await fetchFromAPI(videoId);
            if (apiData) {
                notifyBackground(apiData);
            }

        } catch (err) {
            console.error('[Streamable] Extraction error:', err);
        }
    }

    function extractFromPage() {

        if (window.playerConfig) {
            const config = window.playerConfig;
            const files = config.video?.files || {};

            const qualities = ['mp4-high', 'mp4', 'mp4-mobile'];
            for (const quality of qualities) {
                if (files[quality]?.url) {
                    return {
                        url: files[quality].url,
                        title: config.video?.title || document.title,
                        thumbnail: config.video?.thumb_url,
                        quality: quality.replace('mp4-', ''),
                        width: files[quality].width,
                        height: files[quality].height,
                    };
                }
            }
        }

        const videoEl = document.querySelector('video[src]');
        if (videoEl && videoEl.src) {
            return {
                url: videoEl.src,
                title: document.title,
                thumbnail: videoEl.poster,
                width: videoEl.videoWidth,
                height: videoEl.videoHeight,
            };
        }

        return null;
    }

    async function fetchFromAPI(videoId) {
        try {
            const response = await fetch(`https://api.streamable.com/videos/${videoId}`);
            const data = await response.json();

            const files = data.files || {};
            const qualities = ['mp4-high', 'mp4', 'mp4-mobile'];

            for (const quality of qualities) {
                if (files[quality]?.url) {
                    return {
                        url: `https:${files[quality].url}`,
                        title: data.title || `Streamable Video ${videoId}`,
                        thumbnail: data.thumbnail_url ? `https:${data.thumbnail_url}` : null,
                        quality: quality.replace('mp4-', ''),
                        width: files[quality].width,
                        height: files[quality].height,
                    };
                }
            }

            return null;

        } catch (err) {
            console.error('[Streamable] API fetch failed:', err);
            return null;
        }
    }

    function extractVideoId(url) {

        const match = url.match(/streamable\.com\/(?:e\/)?([a-zA-Z0-9]+)/);
        return match ? match[1] : null;
    }

    window.__SPECIALIST_DETECTED = false;

    extractVideo();
    setTimeout(extractVideo, 500);
    setTimeout(extractVideo, 1000);

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

    console.log('[Streamable Specialist] Initialized');
})();
