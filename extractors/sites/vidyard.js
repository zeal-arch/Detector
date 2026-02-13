(function () {
    'use strict';
    console.log('[Vidyard Specialist] Loaded on:', window.location.href);
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
                    platform: 'vidyard'
                }
            }
        }, '*');
        window.__SPECIALIST_DETECTED = true;
    }

    function extractVideo() {
        try {

            if (window.VidyardV4 && window.VidyardV4.api) {
                const players = window.VidyardV4.api.getPlayersByUUID();

                for (const uuid in players) {
                    const player = players[uuid];
                    if (player && player.metadata) {
                        const chapter = player.metadata.chapters_attributes?.[0];
                        if (chapter?.video_attributes?.url) {
                            notifyBackground({
                                url: chapter.video_attributes.url,
                                title: player.metadata.name || document.title,
                                thumbnail: chapter.thumbnail_urls?.small,
                                type: 'HLS'
                            });
                            return;
                        }
                    }
                }
            }

            const embeds = document.querySelectorAll('[class*="vidyard-player"], [data-uuid]');
            for (const embed of embeds) {
                const uuid = embed.dataset.uuid || embed.className.match(/vidyard-player-([a-zA-Z0-9]+)/)?.[1];
                if (uuid) {
                    notifyBackground({
                        url: `vidyard://${uuid}`,
                        title: document.title,
                        type: 'VIDYARD'
                    });
                    return;
                }
            }

        } catch (err) {
            console.error('[Vidyard] Extraction error:', err);
        }
    }

    setTimeout(extractVideo, 2000);

})();
