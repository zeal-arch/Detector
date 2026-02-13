(function () {
    'use strict';
    console.log('[Gfycat Specialist] Loaded on:', window.location.href);
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
                    platform: 'gfycat'
                }
            }
        }, '*');
        window.__SPECIALIST_DETECTED = true;
    }

    function extractVideo() {
        try {

            const gfyMatch = window.location.pathname.match(/\/([a-zA-Z]+)$/);
            if (!gfyMatch) return;

            const video = document.querySelector('video');
            if (video) {
                const source = video.querySelector('source[type="video/mp4"]') || video;
                const url = source.src;

                if (url) {
                    const title = document.querySelector('h1')?.textContent ||
                        document.querySelector('.title')?.textContent ||
                        gfyMatch[1];

                    notifyBackground({
                        url: url,
                        title: title,
                        type: 'MP4'
                    });
                    return;
                }
            }

            const gfyId = gfyMatch[1];
            notifyBackground({
                url: `https://giant.gfycat.com/${gfyId}.mp4`,
                title: gfyId,
                type: 'MP4'
            });

        } catch (err) {
            console.error('[Gfycat] Extraction error:', err);
        }
    }

    setTimeout(extractVideo, 1500);

})();
