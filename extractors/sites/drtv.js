(function () {
    'use strict';
    console.log('[DRTV Specialist] Loaded on:', window.location.href);
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
                    platform: 'drtv'
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

                const dataMatch = content.match(/"primaryAsset"\s*:\s*\{([^}]+)\}/);
                if (dataMatch) {
                    const urlMatch = dataMatch[1].match(/"uri"\s*:\s*"([^"]+)"/);
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
            console.error('[DRTV] Extraction error:', err);
        }
    }

    setTimeout(extractVideo, 2000);

})();
