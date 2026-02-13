(function () {
    'use strict';
    console.log('[Mixcloud Specialist] Loaded on:', window.location.href);
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
                    platform: 'mixcloud',
                    isAudio: true
                }
            }
        }, '*');
        window.__SPECIALIST_DETECTED = true;
    }

    function extractVideo() {
        try {

            const html = document.documentElement.outerHTML;

            const streamMatch = html.match(/"streamUrl":\s*"([^"]+)"/);
            if (streamMatch) {
                const title = document.querySelector('h1')?.textContent || document.title;
                const author = document.querySelector('[itemprop="author"] [itemprop="name"]')?.textContent;
                const thumbnail = document.querySelector('meta[property="og:image"]')?.content;

                notifyBackground({
                    url: streamMatch[1],
                    title: title,
                    author: author,
                    thumbnail: thumbnail,
                    type: 'HLS'
                });
                return;
            }

            const m3u8Match = html.match(/(https?:\/\/[^"'\s]*\.m3u8[^"'\s]*)/);
            if (m3u8Match) {
                notifyBackground({
                    url: m3u8Match[1],
                    title: document.title,
                    type: 'HLS'
                });
            }

        } catch (err) {
            console.error('[Mixcloud] Extraction error:', err);
        }
    }

    setTimeout(extractVideo, 2000);

})();
