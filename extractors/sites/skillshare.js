(function () {
    'use strict';
    console.log('[Skillshare Specialist] Loaded on:', window.location.href);
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
                    pageUrl: window.location.href,
                    platform: 'skillshare'
                }
            }
        }, '*');
        window.__SPECIALIST_DETECTED = true;
    }

    function extractVideo() {
        try {

            const video = document.querySelector('video');
            if (video?.src) {
                const title = document.querySelector('h1')?.textContent || document.title;
                notifyBackground({
                    url: video.src,
                    title: title,
                    type: video.src.includes('.m3u8') ? 'HLS' : 'MP4'
                });
                return;
            }

            const nextData = document.getElementById('__NEXT_DATA__');
            if (nextData) {
                try {
                    const data = JSON.parse(nextData.textContent);

                    const videoUrl = data?.props?.pageProps?.videoUrl ||
                        data?.props?.pageProps?.lesson?.videoUrl;
                    if (videoUrl) {
                        notifyBackground({
                            url: videoUrl,
                            title: document.title,
                            type: videoUrl.includes('.m3u8') ? 'HLS' : 'MP4'
                        });
                    }
                } catch (e) {
                    console.debug('[Skillshare] Failed to parse video data:', e);
                }
            }

        } catch (err) {
            console.error('[Skillshare] Extraction error:', err);
        }
    }

    setTimeout(extractVideo, 2500);

})();
