(function () {
    'use strict';
    console.log('[SVT Specialist] Loaded on:', window.location.href);
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
                    platform: 'svt'
                }
            }
        }, '*');
        window.__SPECIALIST_DETECTED = true;
    }

    function extractVideo() {
        try {

            const _idMatch = window.location.pathname.match(/\/video\/(\d+)/);

            const scripts = document.querySelectorAll('script');
            for (const script of scripts) {
                const content = script.textContent || '';

                const videoMatch = content.match(/"videoSvtId"\s*:\s*"([^"]+)"/);
                if (videoMatch) {
                    const title = document.querySelector('h1')?.textContent || document.title;
                    notifyBackground({
                        url: `svt://${videoMatch[1]}`,
                        title: title,
                        type: 'SVT'
                    });
                    return;
                }

                const hlsMatch = content.match(/"(https?:\/\/[^"]+\.m3u8[^"]*)"/);
                if (hlsMatch) {
                    notifyBackground({
                        url: hlsMatch[1],
                        title: document.title,
                        type: 'HLS'
                    });
                    return;
                }
            }

        } catch (err) {
            console.error('[SVT] Extraction error:', err);
        }
    }

    setTimeout(extractVideo, 2000);

})();
