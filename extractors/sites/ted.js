(function () {
    'use strict';
    console.log('[TED Specialist] Loaded on:', window.location.href);
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
                    platform: 'ted'
                }
            }
        }, '*');
        window.__SPECIALIST_DETECTED = true;
    }

    function extractVideo() {
        try {

            const nextData = document.getElementById('__NEXT_DATA__');
            if (nextData) {
                try {
                    const data = JSON.parse(nextData.textContent);
                    const talk = data.props?.pageProps?.videoData ||
                        data.props?.pageProps?.talkData;

                    if (talk?.playerData) {
                        const player = typeof talk.playerData === 'string' ?
                            JSON.parse(talk.playerData) : talk.playerData;

                        const resources = player.resources?.h264 || [];
                        const best = resources.find(r => r.bitrate === 'high') || resources[0];

                        if (best?.file) {
                            notifyBackground({
                                url: best.file,
                                title: talk.title || player.title,
                                author: talk.presenterDisplayName,
                                thumbnail: player.thumb,
                                type: 'MP4'
                            });
                            return;
                        }
                    }
                } catch {  }
            }

            const scripts = document.querySelectorAll('script');
            for (const script of scripts) {
                const content = script.textContent || '';

                const talkMatch = content.match(/"talkPage\.init"\s*,\s*(\{[\s\S]*?\})\)/);
                if (talkMatch) {
                    try {
                        const talkData = JSON.parse(talkMatch[1]);
                        if (talkData.media?.internal) {
                            notifyBackground({
                                url: talkData.media.internal['950k']?.uri,
                                title: talkData.name,
                                author: talkData.speaker,
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
            console.error('[TED] Extraction error:', err);
        }
    }

    setTimeout(extractVideo, 2000);

})();
