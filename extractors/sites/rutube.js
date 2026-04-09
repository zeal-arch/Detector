(function () {
    'use strict';
    console.log('[Rutube Specialist] Loaded on:', window.location.href);
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
                    platform: 'rutube'
                }
            }
        }, '*');
        window.__SPECIALIST_DETECTED = true;
    }

    function extractVideo() {
        try {

            const idMatch = window.location.pathname.match(/\/video\/([a-f0-9]+)/);
            if (!idMatch) return;

            const videoId = idMatch[1];

            const scripts = document.querySelectorAll('script');
            for (const script of scripts) {
                const content = script.textContent || '';

                const urlMatch = content.match(/"video_balancer"\s*:\s*\{[^}]*"m3u8"\s*:\s*"([^"]+)"/);
                if (urlMatch) {
                    const title = document.querySelector('h1')?.textContent || document.title;
                    const author = document.querySelector('.video-author')?.textContent;

                    notifyBackground({
                        url: urlMatch[1],
                        title: title,
                        author: author,
                        type: 'HLS'
                    });
                    return;
                }
            }

            notifyBackground({
                url: `rutube://${videoId}`,
                title: document.title,
                type: 'RUTUBE'
            });

        } catch (err) {
            console.error('[Rutube] Extraction error:', err);
        }
    }

    setTimeout(extractVideo, 2000);

})();
