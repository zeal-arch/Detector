(function () {
    'use strict';
    console.log('[Udemy Specialist] Loaded on:', window.location.href);
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
                    platform: 'udemy',
                    isDRM: videoData.isDRM
                }
            }
        }, '*');
        window.__SPECIALIST_DETECTED = true;
    }

    function extractVideo() {
        try {

            const lectureMatch = window.location.href.match(/\/lecture\/(\d+)/);
            if (!lectureMatch) return;

            const lectureId = lectureMatch[1];

            const title = document.querySelector('[data-purpose="lecture-title"]')?.textContent ||
                document.querySelector('h1')?.textContent ||
                document.title;

            const video = document.querySelector('video');
            if (video?.src) {
                notifyBackground({
                    url: video.src,
                    title: title.trim(),
                    type: video.src.includes('.m3u8') ? 'HLS' : 'MP4'
                });
                return;
            }

            notifyBackground({
                url: `udemy://lecture/${lectureId}`,
                title: title.trim(),
                type: 'DRM_PROTECTED',
                isDRM: true
            });

        } catch (err) {
            console.error('[Udemy] Extraction error:', err);
        }
    }

    setTimeout(extractVideo, 2000);

})();
