(function () {
    'use strict';
    console.log('[Youku Specialist] Loaded on:', window.location.href);
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
                    platform: 'youku'
                }
            }
        }, '*');
        window.__SPECIALIST_DETECTED = true;
    }

    function extractVideo() {
        try {

            const idMatch = window.location.href.match(/id_([a-zA-Z0-9=]+)/);
            if (!idMatch) return;

            const videoId = idMatch[1];

            const scripts = document.querySelectorAll('script');
            for (const script of scripts) {
                const content = script.textContent || '';

                const urlMatch = content.match(/"stream_url"\s*:\s*"([^"]+)"/);
                if (urlMatch) {
                    const title = document.querySelector('h1')?.textContent || document.title;
                    notifyBackground({
                        url: urlMatch[1],
                        title: title,
                        type: 'HLS'
                    });
                    return;
                }
            }

            notifyBackground({
                url: `youku://${videoId}`,
                title: document.title,
                type: 'YOUKU'
            });

        } catch (err) {
            console.error('[Youku] Extraction error:', err);
        }
    }

    setTimeout(extractVideo, 2000);

})();
