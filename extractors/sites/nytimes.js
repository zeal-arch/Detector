(function () {
    'use strict';
    console.log('[NYTimes Specialist] Loaded on:', window.location.href);
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
                    platform: 'nytimes'
                }
            }
        }, '*');
        window.__SPECIALIST_DETECTED = true;
    }

    function extractVideo() {
        try {

            const scripts = document.querySelectorAll('script[type="application/ld+json"]');
            for (const script of scripts) {
                try {
                    const data = JSON.parse(script.textContent);
                    if (data['@type'] === 'VideoObject' && data.contentUrl) {
                        notifyBackground({
                            url: data.contentUrl,
                            title: data.name || document.title,
                            thumbnail: data.thumbnailUrl,
                            type: data.contentUrl.includes('.m3u8') ? 'HLS' : 'MP4'
                        });
                        return;
                    }
                } catch {  }
            }

            const allScripts = document.querySelectorAll('script');
            for (const script of allScripts) {
                const content = script.textContent || '';
                const hlsMatch = content.match(/"renditions":\s*\[[^\]]*"url":\s*"([^"]+\.m3u8[^"]*)"/);
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
            console.error('[NYTimes] Extraction error:', err);
        }
    }

    setTimeout(extractVideo, 2500);

})();
