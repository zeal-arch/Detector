(function () {
    'use strict';
    console.log('[JW Player Specialist] Loaded on:', window.location.href);
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
                    platform: 'jwplayer'
                }
            }
        }, '*');
        window.__SPECIALIST_DETECTED = true;
    }

    function extractVideo() {
        try {

            if (typeof jwplayer !== 'undefined') {
                const players = jwplayer.getAllPlayers ? jwplayer.getAllPlayers() : [jwplayer()];

                for (const player of players) {
                    if (player && typeof player.getPlaylistItem === 'function') {
                        const item = player.getPlaylistItem();
                        if (item?.file || item?.sources) {
                            const source = item.sources?.[0] || item;
                            const url = source.file || source.src;

                            if (url) {
                                notifyBackground({
                                    url: url,
                                    title: item.title || document.title,
                                    thumbnail: item.image,
                                    type: url.includes('.m3u8') ? 'HLS' : 'MP4'
                                });
                                return;
                            }
                        }
                    }
                }
            }

            const scripts = document.querySelectorAll('script');
            for (const script of scripts) {
                const content = script.textContent || '';

                const setupMatch = content.match(/jwplayer\([^)]+\)\.setup\((\{[\s\S]*?\})\)/);
                if (setupMatch) {
                    try {

                        const fileMatch = setupMatch[1].match(/"file"\s*:\s*"([^"]+)"/);
                        if (fileMatch) {
                            notifyBackground({
                                url: fileMatch[1],
                                title: document.title,
                                type: fileMatch[1].includes('.m3u8') ? 'HLS' : 'MP4'
                            });
                            return;
                        }
                    } catch {  }
                }
            }

            const video = document.querySelector('.jw-video, video');
            if (video?.src) {
                notifyBackground({
                    url: video.src,
                    title: document.title,
                    type: video.src.includes('.m3u8') ? 'HLS' : 'MP4'
                });
            }

        } catch (err) {
            console.error('[JW Player] Extraction error:', err);
        }
    }

    setTimeout(extractVideo, 2000);

})();
