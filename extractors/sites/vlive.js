(function () {
    'use strict';
    console.log('[Vlive Specialist] Loaded on:', window.location.href);
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
                    platform: 'vlive'
                }
            }
        }, '*');
        window.__SPECIALIST_DETECTED = true;
    }

    function extractVideo() {
        try {

            const idMatch = window.location.pathname.match(/\/video\/(\d+)/);
            if (!idMatch) return;

            const videoId = idMatch[1];

            const scripts = document.querySelectorAll('script');
            for (const script of scripts) {
                const content = script.textContent || '';

                const urlMatch = content.match(/"source"\s*:\s*"([^"]+\.m3u8[^"]*)"/);
                if (urlMatch) {
                    const title = document.querySelector('h3')?.textContent || document.title;
                    const author = document.querySelector('.channel_name')?.textContent;

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
                url: `vlive://${videoId}`,
                title: document.title,
                type: 'VLIVE'
            });

        } catch (err) {
            console.error('[Vlive] Extraction error:', err);
        }
    }

    setTimeout(extractVideo, 2000);

})();
