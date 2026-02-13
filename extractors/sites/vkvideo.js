(function () {
    'use strict';
    console.log('[VK Video Specialist] Loaded on:', window.location.href);
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
                    platform: 'vk'
                }
            }
        }, '*');
        window.__SPECIALIST_DETECTED = true;
    }

    function extractVideo() {
        try {

            const playerParams = document.querySelector('[data-params]');
            if (playerParams) {
                try {
                    const params = JSON.parse(playerParams.dataset.params);

                    if (params.hls) {
                        notifyBackground({
                            url: params.hls,
                            title: params.md_title || document.title,
                            author: params.md_author,
                            type: 'HLS'
                        });
                        return;
                    }

                    const qualities = ['url1080', 'url720', 'url480', 'url360', 'url240'];
                    for (const quality of qualities) {
                        if (params[quality]) {
                            notifyBackground({
                                url: params[quality],
                                title: params.md_title || document.title,
                                author: params.md_author,
                                type: 'MP4'
                            });
                            return;
                        }
                    }
                } catch {  }
            }

            const scripts = document.querySelectorAll('script');
            for (const script of scripts) {
                const content = script.textContent || '';

                const hlsMatch = content.match(/"hls"\s*:\s*"([^"]+)"/);
                if (hlsMatch) {
                    notifyBackground({
                        url: hlsMatch[1].replace(/\\/g, ''),
                        title: document.title,
                        type: 'HLS'
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
            console.error('[VK] Extraction error:', err);
        }
    }

    setTimeout(extractVideo, 2000);

})();
