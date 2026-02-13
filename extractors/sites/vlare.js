(function () {
    'use strict';
    console.log('[Vlare Specialist] Loaded on:', window.location.href);
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
                    platform: 'vlare'
                }
            }
        }, '*');
        window.__SPECIALIST_DETECTED = true;
    }

    function extractVideo() {
        try {

            const video = document.querySelector('video');
            if (video) {
                const source = video.querySelector('source') || video;
                const src = source.src;

                if (src) {
                    const title = document.querySelector('h1')?.textContent || document.title;
                    const author = document.querySelector('.channel-name')?.textContent;

                    notifyBackground({
                        url: src,
                        title: title,
                        author: author,
                        type: src.includes('.m3u8') ? 'HLS' : 'MP4'
                    });
                    return;
                }
            }

            const scripts = document.querySelectorAll('script');
            for (const script of scripts) {
                const content = script.textContent || '';

                const urlMatch = content.match(/"videoUrl"\s*:\s*"([^"]+)"/);
                if (urlMatch) {
                    notifyBackground({
                        url: urlMatch[1],
                        title: document.title,
                        type: 'MP4'
                    });
                    return;
                }
            }

        } catch (err) {
            console.error('[Vlare] Extraction error:', err);
        }
    }

    setTimeout(extractVideo, 2000);

})();
