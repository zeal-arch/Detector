(function () {
    'use strict';
    console.log('[Vimeo OTT Specialist] Loaded on:', window.location.href);
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
                    platform: 'vimeo-ott'
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

                const configMatch = content.match(/OTTPlayer\.init\((\{[\s\S]*?\})\)/);
                if (configMatch) {
                    try {
                        const config = JSON.parse(configMatch[1]);
                        if (config.source?.url) {
                            notifyBackground({
                                url: config.source.url,
                                title: config.title || document.title,
                                thumbnail: config.poster,
                                type: 'HLS'
                            });
                            return;
                        }
                    } catch {  }
                }

                const hlsMatch = content.match(/"hls"\s*:\s*"([^"]+\.m3u8[^"]*)"/);
                if (hlsMatch) {
                    notifyBackground({
                        url: hlsMatch[1],
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
            console.error('[Vimeo OTT] Extraction error:', err);
        }
    }

    setTimeout(extractVideo, 2000);

})();
