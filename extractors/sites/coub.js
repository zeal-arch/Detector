(function () {
    'use strict';
    console.log('[Coub Specialist] Loaded on:', window.location.href);
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
                    platform: 'coub'
                }
            }
        }, '*');
        window.__SPECIALIST_DETECTED = true;
    }

    function extractVideo() {
        try {

            const idMatch = window.location.pathname.match(/\/view\/([a-z0-9]+)/i);
            if (!idMatch) return;

            const coubData = document.querySelector('[data-coub]');
            if (coubData) {
                try {
                    const data = JSON.parse(coubData.dataset.coub);
                    const videoUrl = data.file_versions?.html5?.video?.high?.url ||
                        data.file_versions?.html5?.video?.med?.url;

                    if (videoUrl) {
                        notifyBackground({
                            url: videoUrl,
                            title: data.title || document.title,
                            author: data.channel?.title,
                            thumbnail: data.picture,
                            type: 'MP4'
                        });
                        return;
                    }
                } catch {  }
            }

            const video = document.querySelector('video');
            if (video?.src) {
                notifyBackground({
                    url: video.src,
                    title: document.title,
                    type: 'MP4'
                });
            }

        } catch (err) {
            console.error('[Coub] Extraction error:', err);
        }
    }

    setTimeout(extractVideo, 1500);

})();
