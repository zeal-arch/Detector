(function () {
    'use strict';
    console.log('[Weibo Specialist] Loaded on:', window.location.href);
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
                type: videoData.type || 'MP4',
                options: {
                    customTitle: videoData.title,
                    thumbnail: videoData.thumbnail,
                    author: videoData.author,
                    pageUrl: window.location.href,
                    platform: 'weibo'
                }
            }
        }, '*');
        window.__SPECIALIST_DETECTED = true;
    }

    function extractVideo() {
        try {

            const scripts = document.querySelectorAll('script');
            for (const script of scripts) {
                const content = script.textContent || '';

                const urlMatch = content.match(/"stream_url"\s*:\s*"([^"]+)"/);
                if (urlMatch) {
                    notifyBackground({
                        url: decodeURIComponent(urlMatch[1]),
                        title: document.title,
                        type: 'MP4'
                    });
                    return;
                }

                const hdMatch = content.match(/"stream_url_hd"\s*:\s*"([^"]+)"/);
                if (hdMatch) {
                    notifyBackground({
                        url: decodeURIComponent(hdMatch[1]),
                        title: document.title,
                        type: 'MP4'
                    });
                    return;
                }
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
            console.error('[Weibo] Extraction error:', err);
        }
    }

    setTimeout(extractVideo, 2000);

})();
