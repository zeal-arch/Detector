(function () {
    'use strict';
    console.log('[Deezer Specialist] Loaded on:', window.location.href);
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
                type: videoData.type || 'HLS',
                options: {
                    customTitle: videoData.title,
                    thumbnail: videoData.thumbnail,
                    pageUrl: window.location.href,
                    platform: 'deezer',
                    isDRM: true
                }
            }
        }, '*');
        window.__SPECIALIST_DETECTED = true;
    }

    function extractVideo() {
        try {

            const title = document.querySelector('h1')?.textContent || document.title;
            const thumbnail = document.querySelector('meta[property="og:image"]')?.content;

            const idMatch = window.location.pathname.match(/\/(track|album|show)\/(\d+)/);
            if (idMatch) {
                notifyBackground({
                    url: `deezer://${idMatch[1]}/${idMatch[2]}`,
                    title: title,
                    thumbnail: thumbnail,
                    type: 'DEEZER'
                });
            }

        } catch (err) {
            console.error('[Deezer] Extraction error:', err);
        }
    }

    setTimeout(extractVideo, 2000);

})();
