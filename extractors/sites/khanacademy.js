(function () {
    'use strict';
    console.log('[Khan Academy Specialist] Loaded on:', window.location.href);
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
                    platform: 'khanacademy'
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

                const mp4Match = content.match(/"mp4(?:Url)?"\s*:\s*"([^"]+)"/);
                if (mp4Match) {
                    const title = document.querySelector('h1')?.textContent || document.title;
                    notifyBackground({
                        url: mp4Match[1],
                        title: title,
                        type: 'MP4'
                    });
                    return;
                }

                const moduleMatch = content.match(/"downloadUrls":\s*(\{[^}]+\})/);
                if (moduleMatch) {
                    try {
                        const urls = JSON.parse(moduleMatch[1]);
                        const url = urls.mp4 || urls['mp4-low'];
                        if (url) {
                            notifyBackground({
                                url: url,
                                title: document.title,
                                type: 'MP4'
                            });
                            return;
                        }
                    } catch {  }
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
            console.error('[Khan Academy] Extraction error:', err);
        }
    }

    setTimeout(extractVideo, 2500);

})();
