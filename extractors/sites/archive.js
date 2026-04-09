(function () {
    'use strict';
    console.log('[Archive.org Specialist] Loaded on:', window.location.href);
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
                    platform: 'archive'
                }
            }
        }, '*');
        window.__SPECIALIST_DETECTED = true;
    }

    function extractVideo() {
        try {

            const itemMatch = window.location.href.match(/\/details\/([^/?]+)/);
            if (!itemMatch) return;

            const _itemId = itemMatch[1];

            const sources = document.querySelectorAll('source[type="video/mp4"]');
            if (sources.length > 0) {
                const title = document.querySelector('h1')?.textContent || document.title;
                const thumbnail = document.querySelector('meta[property="og:image"]')?.content;

                let bestSource = sources[0];
                for (const source of sources) {
                    if (source.src.includes('_512kb') || source.src.includes('_mpeg4')) {
                        bestSource = source;
                        break;
                    }
                }

                notifyBackground({
                    url: bestSource.src,
                    title: title,
                    thumbnail: thumbnail,
                    type: 'MP4'
                });
                return;
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
            console.error('[Archive.org] Extraction error:', err);
        }
    }

    setTimeout(extractVideo, 2000);

})();
