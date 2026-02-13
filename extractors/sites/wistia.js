(function () {
    'use strict';
    console.log('[Wistia Specialist] Loaded on:', window.location.href);
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
                    platform: 'wistia'
                }
            }
        }, '*');
        window.__SPECIALIST_DETECTED = true;
    }

    function extractVideo() {
        try {

            if (window.Wistia && window.Wistia.api) {
                const allVideos = window.Wistia.api.all();

                for (const video of allVideos) {
                    if (video && typeof video.data === 'function') {
                        const data = video.data();

                        const assets = data.assets || [];
                        const mp4 = assets.find(a => a.type === 'original') ||
                            assets.find(a => a.container === 'mp4');

                        if (mp4?.url) {
                            notifyBackground({
                                url: mp4.url,
                                title: data.name || document.title,
                                thumbnail: data.still_url,
                                type: 'MP4'
                            });
                            return;
                        }

                        const hls = assets.find(a => a.type === 'm3u8');
                        if (hls?.url) {
                            notifyBackground({
                                url: hls.url,
                                title: data.name || document.title,
                                thumbnail: data.still_url,
                                type: 'HLS'
                            });
                            return;
                        }
                    }
                }
            }

            const embeds = document.querySelectorAll('[class*="wistia_embed"], [data-wistia-id]');
            for (const embed of embeds) {
                const wistiaId = embed.className.match(/wistia_async_([a-z0-9]+)/) ||
                    embed.dataset.wistiaId;

                if (wistiaId) {
                    notifyBackground({
                        url: `wistia://${wistiaId[1] || wistiaId}`,
                        title: document.title,
                        type: 'WISTIA'
                    });
                    return;
                }
            }

        } catch (err) {
            console.error('[Wistia] Extraction error:', err);
        }
    }

    setTimeout(extractVideo, 2000);

})();
