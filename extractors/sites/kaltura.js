(function () {
    'use strict';
    console.log('[Kaltura Specialist] Loaded on:', window.location.href);
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
                    platform: 'kaltura'
                }
            }
        }, '*');
        window.__SPECIALIST_DETECTED = true;
    }

    function extractVideo() {
        try {

            if (window.kWidget && window.kWidget.getKalturaThumb) {
                const players = document.querySelectorAll('[id^="kaltura_player"]');
                for (const _player of players) {
                    const kdp = window.kdp || window.kWidget.getKalturaThumb;
                    if (kdp && typeof kdp.evaluate === 'function') {
                        const src = kdp.evaluate('{mediaProxy.entry.downloadUrl}');
                        if (src) {
                            notifyBackground({
                                url: src,
                                title: document.title,
                                type: 'MP4'
                            });
                            return;
                        }
                    }
                }
            }

            const iframes = document.querySelectorAll('iframe[src*="kaltura"]');
            for (const iframe of iframes) {
                const src = iframe.src;
                const partnerId = src.match(/partner_id\/(\d+)/)?.[1];
                const entryId = src.match(/entry_id\/([^/&]+)/)?.[1];

                if (partnerId && entryId) {
                    notifyBackground({
                        url: `kaltura://${partnerId}/${entryId}`,
                        title: document.title,
                        type: 'KALTURA'
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
            console.error('[Kaltura] Extraction error:', err);
        }
    }

    setTimeout(extractVideo, 2000);

})();
