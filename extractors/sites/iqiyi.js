(function () {
    'use strict';
    console.log('[iQiyi Specialist] Loaded on:', window.location.href);
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
                    platform: 'iqiyi',
                    isDRM: true
                }
            }
        }, '*');
        window.__SPECIALIST_DETECTED = true;
    }

    function extractVideo() {
        try {

            const title = document.querySelector('h1')?.textContent ||
                document.querySelector('.title-txt')?.textContent ||
                document.title;
            const thumbnail = document.querySelector('meta[property="og:image"]')?.content;

            const idMatch = window.location.href.match(/\/([a-z0-9]+)\.html/);
            const videoId = idMatch ? idMatch[1] : null;

            if (videoId) {
                notifyBackground({
                    url: `iqiyi://${videoId}`,
                    title: title,
                    thumbnail: thumbnail,
                    type: 'IQIYI'
                });
            }

        } catch (err) {
            console.error('[iQiyi] Extraction error:', err);
        }
    }

    setTimeout(extractVideo, 2000);

})();
