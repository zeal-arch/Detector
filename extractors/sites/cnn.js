(function () {
    'use strict';
    console.log('[CNN Specialist] Loaded on:', window.location.href);
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
                    platform: 'cnn'
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

                const hlsMatch = content.match(/"(?:hlsUrl|contentUrl)":\s*"([^"]+\.m3u8[^"]*)"/);
                if (hlsMatch) {
                    const title = document.querySelector('h1')?.textContent || document.title;
                    const thumbnail = document.querySelector('meta[property="og:image"]')?.content;
                    notifyBackground({
                        url: hlsMatch[1],
                        title: title,
                        thumbnail: thumbnail,
                        type: 'HLS'
                    });
                    return;
                }

                const mp4Match = content.match(/"(?:mp4Url|contentUrl)":\s*"([^"]+\.mp4[^"]*)"/);
                if (mp4Match) {
                    notifyBackground({
                        url: mp4Match[1],
                        title: document.title,
                        type: 'MP4'
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
            console.error('[CNN] Extraction error:', err);
        }
    }

    setTimeout(extractVideo, 2000);

})();
