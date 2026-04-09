(function () {
    'use strict';
    console.log('[Spotify Specialist] Loaded on:', window.location.href);
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
                    author: videoData.author,
                    pageUrl: window.location.href,
                    platform: 'spotify',
                    isDRM: true
                }
            }
        }, '*');
        window.__SPECIALIST_DETECTED = true;
    }

    function extractVideo() {
        try {

            const title = document.querySelector('h1')?.textContent ||
                document.querySelector('[data-testid="entityTitle"]')?.textContent ||
                document.title;
            const author = document.querySelector('[data-testid="creator-link"]')?.textContent;
            const thumbnail = document.querySelector('meta[property="og:image"]')?.content;

            const idMatch = window.location.pathname.match(/\/(episode|show)\/([a-zA-Z0-9]+)/);
            if (idMatch) {
                notifyBackground({
                    url: `spotify://${idMatch[1]}/${idMatch[2]}`,
                    title: title,
                    author: author,
                    thumbnail: thumbnail,
                    type: 'SPOTIFY'
                });
            }

        } catch (err) {
            console.error('[Spotify] Extraction error:', err);
        }
    }

    setTimeout(extractVideo, 2000);

})();
