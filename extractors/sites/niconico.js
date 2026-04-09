(function () {
    'use strict';
    console.log('[Niconico Specialist] Loaded on:', window.location.href);
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
                    platform: 'niconico'
                }
            }
        }, '*');
        window.__SPECIALIST_DETECTED = true;
    }

    function extractVideo() {
        try {

            const videoMatch = window.location.href.match(/watch\/([a-z]{2}\d+)/);
            if (!videoMatch) return;

            const videoId = videoMatch[1];

            const apiData = document.getElementById('js-initial-watch-data');
            if (apiData) {
                try {
                    const data = JSON.parse(apiData.dataset.apiData);
                    const video = data.video;

                    notifyBackground({
                        url: `niconico://${videoId}`,
                        title: video?.title || document.title,
                        author: video?.owner?.nickname,
                        thumbnail: video?.thumbnail?.url,
                        type: 'NICONICO'
                    });
                    return;
                } catch (e) {
                    console.debug('[Niconico] Failed to parse video data:', e);
                }
            }

            notifyBackground({
                url: `niconico://${videoId}`,
                title: document.title,
                type: 'NICONICO'
            });

        } catch (err) {
            console.error('[Niconico] Extraction error:', err);
        }
    }

    setTimeout(extractVideo, 2000);

})();
