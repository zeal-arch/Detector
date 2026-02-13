(function () {
    'use strict';
    console.log('[Prime Video Specialist] Loaded on:', window.location.href);
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
                    pageUrl: window.location.href,
                    isDRM: true,
                    platform: 'primevideo'
                }
            }
        }, '*');
        window.__SPECIALIST_DETECTED = true;
    }

    function extractVideo() {
        try {

            const asinMatch = window.location.href.match(/\/(?:detail|gp\/video\/detail|dp)\/([A-Z0-9]{10})/i);
            if (!asinMatch) return;

            const asin = asinMatch[1];

            const title = document.querySelector('[data-automation-id="title"]')?.textContent ||
                document.querySelector('h1')?.textContent ||
                document.title.replace(' - Prime Video', '');

            const thumbnail = document.querySelector('[data-testid="packshot-image"]')?.src ||
                document.querySelector('.dv-dp-node-hero img')?.src;

            notifyBackground({
                url: `primevideo://detail/${asin}`,
                title: title,
                thumbnail: thumbnail,
                type: 'DRM_PROTECTED'
            });

        } catch (err) {
            console.error('[Prime Video] Extraction error:', err);
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
