(function () {
    'use strict';
    console.log('[Pornhub Specialist] Loaded on:', window.location.href);
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
                    platform: 'pornhub',
                    isAdult: true
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

                const flashvarsMatch = content.match(/var\s+flashvars_\d+\s*=\s*(\{[\s\S]*?\});/);
                if (flashvarsMatch) {
                    try {
                        const flashvars = JSON.parse(flashvarsMatch[1]);

                        const qualities = ['quality_1080p', 'quality_720p', 'quality_480p', 'quality_240p'];
                        for (const quality of qualities) {
                            if (flashvars[quality]) {
                                notifyBackground({
                                    url: flashvars[quality],
                                    title: flashvars.video_title || document.title,
                                    thumbnail: flashvars.image_url,
                                    type: 'MP4'
                                });
                                return;
                            }
                        }

                        if (flashvars.mediaDefinitions) {
                            const hls = flashvars.mediaDefinitions.find(d => d.format === 'hls');
                            if (hls?.videoUrl) {
                                notifyBackground({
                                    url: hls.videoUrl,
                                    title: flashvars.video_title || document.title,
                                    type: 'HLS'
                                });
                                return;
                            }
                        }
                    } catch (e) {
                        console.debug('[Pornhub] Failed to parse player config:', e);
                    }
                }

                const qualityMatch = content.match(/"quality_(\d+)p"\s*:\s*"([^"]+)"/);
                if (qualityMatch) {
                    notifyBackground({
                        url: qualityMatch[2].replace(/\\/g, ''),
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
            console.error('[Pornhub] Extraction error:', err);
        }
    }

    setTimeout(extractVideo, 2000);

})();
