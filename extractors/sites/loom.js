(function () {
    'use strict';
    console.log('[Loom Specialist] Loaded on:', window.location.href);
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
                    platform: 'loom'
                }
            }
        }, '*');
        window.__SPECIALIST_DETECTED = true;
    }

    function extractVideo() {
        try {

            const idMatch = window.location.pathname.match(/\/share\/([a-f0-9]+)/);
            if (!idMatch) return;

            const videoId = idMatch[1];

            const scripts = document.querySelectorAll('script');
            for (const script of scripts) {
                const content = script.textContent || '';

                const urlMatch = content.match(/"url"\s*:\s*"(https:\/\/[^"]+\.m3u8[^"]*)"/);
                if (urlMatch) {
                    const title = document.querySelector('h1')?.textContent || document.title;
                    const author = document.querySelector('[class*="author"]')?.textContent;

                    notifyBackground({
                        url: urlMatch[1],
                        title: title,
                        author: author,
                        type: 'HLS'
                    });
                    return;
                }

                const cdnMatch = content.match(/"raw_cdn_url"\s*:\s*"([^"]+)"/);
                if (cdnMatch) {
                    notifyBackground({
                        url: cdnMatch[1],
                        title: document.title,
                        type: 'MP4'
                    });
                    return;
                }
            }

            notifyBackground({
                url: `loom://${videoId}`,
                title: document.title,
                type: 'LOOM'
            });

        } catch (err) {
            console.error('[Loom] Extraction error:', err);
        }
    }

    setTimeout(extractVideo, 2000);

})();
