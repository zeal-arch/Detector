(function () {
    'use strict';
    console.log('[Max Specialist] Loaded on:', window.location.href);
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
                    platform: 'max'
                }
            }
        }, '*');
        window.__SPECIALIST_DETECTED = true;
    }

    function extractVideo() {
        try {
            const videoMatch = window.location.href.match(/\/(?:video|movie|series)\/([a-f0-9-]+)/);
            if (!videoMatch) return;

            const videoId = videoMatch[1];
            const title = document.querySelector('[data-testid="title-name"]')?.textContent ||
                document.title.replace(' | Max', '');

            notifyBackground({
                url: `max://video/${videoId}`,
                title: title,
                type: 'DRM_PROTECTED'
            });

        } catch (err) {
            console.error('[Max] Extraction error:', err);
        }
    }

    setTimeout(extractVideo, 2000);

})();
