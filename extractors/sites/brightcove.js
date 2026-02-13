(function () {
    'use strict';
    console.log('[Brightcove Specialist] Loaded on:', window.location.href);
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
                    platform: 'brightcove'
                }
            }
        }, '*');
        window.__SPECIALIST_DETECTED = true;
    }

    function extractVideo() {
        try {

            const players = document.querySelectorAll('[data-video-id], [data-account]');

            for (const player of players) {
                const videoId = player.dataset.videoId;
                const accountId = player.dataset.account;

                if (videoId && accountId) {

                    if (window.bc && window.bc.videojs) {
                        const videojs = window.bc.videojs.getPlayers();
                        for (const playerId in videojs) {
                            const vjsPlayer = videojs[playerId];
                            if (vjsPlayer && vjsPlayer.currentSrc) {
                                notifyBackground({
                                    url: vjsPlayer.currentSrc(),
                                    title: vjsPlayer.mediainfo?.name || document.title,
                                    thumbnail: vjsPlayer.poster(),
                                    type: vjsPlayer.currentSrc().includes('.m3u8') ? 'HLS' : 'MP4'
                                });
                                return;
                            }
                        }
                    }

                    notifyBackground({
                        url: `brightcove://${accountId}/${videoId}`,
                        title: document.title,
                        type: 'BRIGHTCOVE'
                    });
                    return;
                }
            }

            const video = document.querySelector('video.video-js, video[data-video-id]');
            if (video?.src) {
                notifyBackground({
                    url: video.src,
                    title: document.title,
                    type: video.src.includes('.m3u8') ? 'HLS' : 'MP4'
                });
            }

        } catch (err) {
            console.error('[Brightcove] Extraction error:', err);
        }
    }

    setTimeout(extractVideo, 2000);

})();
