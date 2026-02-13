(function () {
    'use strict';
    console.log('[Crunchyroll Specialist] Loaded on:', window.location.href);
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
                    platform: 'crunchyroll',
                    isDRM: videoData.isDRM
                }
            }
        }, '*');
        window.__SPECIALIST_DETECTED = true;
    }

    function extractVideo() {
        try {

            const watchMatch = window.location.href.match(/\/watch\/([A-Z0-9]+)/);
            if (!watchMatch) return;

            const videoId = watchMatch[1];

            const title = document.querySelector('[data-t="episode-title"]')?.textContent ||
                document.querySelector('h1')?.textContent ||
                document.title;

            const thumbnail = document.querySelector('meta[property="og:image"]')?.content;

            notifyBackground({
                url: `crunchyroll://watch/${videoId}`,
                title: title.trim(),
                thumbnail: thumbnail,
                type: 'DRM_PROTECTED',
                isDRM: true
            });

        } catch (err) {
            console.error('[Crunchyroll] Extraction error:', err);
        }
    }

    setTimeout(extractVideo, 2000);

})();
