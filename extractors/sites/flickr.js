(function () {
    'use strict';
    console.log('[Flickr Specialist] Loaded on:', window.location.href);
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
                    platform: 'flickr'
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

                const videoMatch = content.match(/"streams":\s*\{([^}]+)\}/);
                if (videoMatch) {
                    const urlMatch = videoMatch[1].match(/"url":\s*"([^"]+)"/);
                    if (urlMatch) {
                        const title = document.querySelector('h1')?.textContent || document.title;
                        notifyBackground({
                            url: urlMatch[1],
                            title: title,
                            type: 'MP4'
                        });
                        return;
                    }
                }
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
            console.error('[Flickr] Extraction error:', err);
        }
    }

    setTimeout(extractVideo, 2000);

})();
