(function () {
    'use strict';
    console.log('[Peertube Specialist] Loaded on:', window.location.href);
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
                    platform: 'peertube'
                }
            }
        }, '*');
        window.__SPECIALIST_DETECTED = true;
    }

    function extractVideo() {
        try {

            const player = document.querySelector('.video-js');
            if (player) {
                const video = player.querySelector('video');
                if (video?.src) {
                    const title = document.querySelector('.video-info-name')?.textContent || document.title;
                    const author = document.querySelector('.video-info-channel')?.textContent;

                    notifyBackground({
                        url: video.src,
                        title: title,
                        author: author,
                        type: video.src.includes('.m3u8') ? 'HLS' : 'MP4'
                    });
                    return;
                }
            }

            const scripts = document.querySelectorAll('script');
            for (const script of scripts) {
                const content = script.textContent || '';

                const playlistMatch = content.match(/"streamingPlaylists"\s*:\s*\[([^\]]+)\]/);
                if (playlistMatch) {
                    const urlMatch = playlistMatch[1].match(/"playlistUrl"\s*:\s*"([^"]+)"/);
                    if (urlMatch) {
                        notifyBackground({
                            url: urlMatch[1],
                            title: document.title,
                            type: 'HLS'
                        });
                        return;
                    }
                }
            }

        } catch (err) {
            console.error('[Peertube] Extraction error:', err);
        }
    }

    setTimeout(extractVideo, 2000);

})();
