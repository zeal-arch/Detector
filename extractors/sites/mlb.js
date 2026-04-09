(function () {
    'use strict';
    console.log('[MLB Specialist] Loaded on:', window.location.href);
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
                    pageUrl: window.location.href,
                    platform: 'mlb'
                }
            }
        }, '*');
        window.__SPECIALIST_DETECTED = true;
    }

    function extractVideo() {
        try {
            const html = document.documentElement.outerHTML;

            const m3u8Match = html.match(/(https?:\/\/[^"'\s]*mlb[^"'\s]*\.m3u8[^"'\s]*)/i);
            if (m3u8Match) {
                notifyBackground({
                    url: m3u8Match[1],
                    title: document.title,
                    type: 'HLS'
                });
                return;
            }

            const video = document.querySelector('video');
            if (video?.src) {
                notifyBackground({
                    url: video.src,
                    title: document.title,
                    type: video.src.includes('.m3u8') ? 'HLS' : 'MP4'
                });
            }

        } catch (err) {
            console.error('[MLB] Extraction error:', err);
        }
    }

    setTimeout(extractVideo, 2000);

})();
