(function () {
    'use strict';
    console.log('[Peacock Specialist] Loaded on:', window.location.href);
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
                    pageUrl: window.location.href,
                    isDRM: true,
                    platform: 'peacock'
                }
            }
        }, '*');
        window.__SPECIALIST_DETECTED = true;
    }

    function extractVideo() {
        try {
            const videoMatch = window.location.href.match(/\/watch\/([^/?]+)/);
            if (!videoMatch) return;

            const videoId = videoMatch[1];
            const title = document.querySelector('[data-testid="video-title"]')?.textContent ||
                document.title.replace(' | Peacock', '');

            notifyBackground({
                url: `peacock://watch/${videoId}`,
                title: title,
                type: 'DRM_PROTECTED'
            });

        } catch (err) {
            console.error('[Peacock] Extraction error:', err);
        }
    }

    setTimeout(extractVideo, 2000);

})();
