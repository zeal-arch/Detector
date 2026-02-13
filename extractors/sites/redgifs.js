(function () {
    'use strict';
    console.log('[RedGifs Specialist] Loaded on:', window.location.href);
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
                    pageUrl: window.location.href,
                    platform: 'redgifs'
                }
            }
        }, '*');
        window.__SPECIALIST_DETECTED = true;
    }

    function extractVideo() {
        try {

            const idMatch = window.location.pathname.match(/\/watch\/([a-zA-Z]+)/);
            if (!idMatch) return;

            const gifId = idMatch[1];

            const video = document.querySelector('video');
            if (video) {
                const source = video.querySelector('source[type="video/mp4"]') || video;
                const src = source.src;

                if (src && !src.includes('blob:')) {
                    notifyBackground({
                        url: src,
                        title: gifId,
                        type: 'MP4'
                    });
                    return;
                }
            }

            const scripts = document.querySelectorAll('script');
            for (const script of scripts) {
                const content = script.textContent || '';
                const urlMatch = content.match(/"urls":\s*\{[^}]*"hd":\s*"([^"]+)"/);
                if (urlMatch) {
                    notifyBackground({
                        url: urlMatch[1],
                        title: gifId,
                        type: 'MP4'
                    });
                    return;
                }
            }

        } catch (err) {
            console.error('[RedGifs] Extraction error:', err);
        }
    }

    setTimeout(extractVideo, 2000);

})();
