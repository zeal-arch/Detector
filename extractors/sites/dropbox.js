(function () {
    'use strict';
    console.log('[Dropbox Specialist] Loaded on:', window.location.href);
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
                    pageUrl: window.location.href,
                    platform: 'dropbox'
                }
            }
        }, '*');
        window.__SPECIALIST_DETECTED = true;
    }

    function extractVideo() {
        try {

            const video = document.querySelector('video');
            if (video?.src) {
                const title = document.querySelector('h1')?.textContent ||
                    document.querySelector('.filename-text')?.textContent ||
                    document.title;
                notifyBackground({
                    url: video.src,
                    title: title,
                    type: video.src.includes('.m3u8') ? 'HLS' : 'MP4'
                });
                return;
            }

            const currentUrl = window.location.href;
            if (currentUrl.includes('dl=0')) {
                const directUrl = currentUrl.replace('dl=0', 'dl=1');
                const filename = document.querySelector('.filename-text')?.textContent;
                if (filename && (filename.endsWith('.mp4') || filename.endsWith('.webm') || filename.endsWith('.mov'))) {
                    notifyBackground({
                        url: directUrl,
                        title: filename,
                        type: 'MP4'
                    });
                }
            }

        } catch (err) {
            console.error('[Dropbox] Extraction error:', err);
        }
    }

    setTimeout(extractVideo, 2000);

})();
