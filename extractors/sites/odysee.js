(function () {
    'use strict';
    console.log('[Odysee Specialist] Loaded on:', window.location.href);
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
                    platform: 'odysee'
                }
            }
        }, '*');
        window.__SPECIALIST_DETECTED = true;
    }

    function extractVideo() {
        try {

            const html = document.documentElement.outerHTML;

            const streamMatch = html.match(/"streaming_url":\s*"([^"]+)"/);
            if (streamMatch) {
                const title = document.querySelector('h1')?.textContent || document.title;
                const author = document.querySelector('[data-testid="channel-name"]')?.textContent;
                const thumbnail = document.querySelector('meta[property="og:image"]')?.content;

                notifyBackground({
                    url: streamMatch[1],
                    title: title,
                    author: author,
                    thumbnail: thumbnail,
                    type: streamMatch[1].includes('.m3u8') ? 'HLS' : 'MP4'
                });
                return;
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
            console.error('[Odysee] Extraction error:', err);
        }
    }

    setTimeout(extractVideo, 2000);

})();
