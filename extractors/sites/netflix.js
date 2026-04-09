(function () {
    'use strict';
    console.log('[Netflix Specialist] Loaded on:', window.location.href);
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
                type: videoData.type || 'DRM_PROTECTED',
                options: {
                    customTitle: videoData.title,
                    thumbnail: videoData.thumbnail,
                    quality: videoData.quality,
                    pageUrl: window.location.href,
                    isDRM: true,
                    platform: 'netflix'
                }
            }
        }, '*');
        window.__SPECIALIST_DETECTED = true;
    }

    function extractVideo() {
        try {

            const watchMatch = window.location.href.match(/\/watch\/(\d+)/);
            if (!watchMatch) return;

            const videoId = watchMatch[1];

            const reactRoot = document.querySelector('[data-uia="video-title"]');
            const title = reactRoot?.textContent || document.title.replace(' | Netflix', '');

            const poster = document.querySelector('video')?.poster ||
                document.querySelector('[data-uia="billboard-pane"] img')?.src;

            notifyBackground({
                url: `netflix://watch/${videoId}`,
                title: title,
                thumbnail: poster,
                type: 'DRM_PROTECTED'
            });

        } catch (err) {
            console.error('[Netflix] Extraction error:', err);
        }
    }

    setTimeout(extractVideo, 2000);

    let lastUrl = location.href;
    new MutationObserver(() => {
        if (location.href !== lastUrl) {
            lastUrl = location.href;
            setTimeout(extractVideo, 1000);
        }
    }).observe(document.body, { subtree: true, childList: true });

})();
