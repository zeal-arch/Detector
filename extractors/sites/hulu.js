(function () {
    'use strict';
    console.log('[Hulu Specialist] Loaded on:', window.location.href);
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
                type: 'DRM_PROTECTED',
                options: {
                    customTitle: videoData.title,
                    thumbnail: videoData.thumbnail,
                    pageUrl: window.location.href,
                    isDRM: true,
                    platform: 'hulu'
                }
            }
        }, '*');
        window.__SPECIALIST_DETECTED = true;
    }

    function extractVideo() {
        try {
            const watchMatch = window.location.href.match(/\/watch\/([a-f0-9-]+)/);
            if (!watchMatch) return;

            const videoId = watchMatch[1];
            const title = document.querySelector('[data-automationid="title"]')?.textContent ||
                document.title.replace(' - Hulu', '');

            notifyBackground({
                url: `hulu://watch/${videoId}`,
                title: title,
                type: 'DRM_PROTECTED'
            });

        } catch (err) {
            console.error('[Hulu] Extraction error:', err);
        }
    }

    setTimeout(extractVideo, 2000);

})();
