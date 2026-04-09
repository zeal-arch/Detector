(function () {
    'use strict';
    console.log('[LinkedIn Specialist] Loaded on:', window.location.href);
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
                    platform: 'linkedin'
                }
            }
        }, '*');
        window.__SPECIALIST_DETECTED = true;
    }

    function extractVideo() {
        try {

            const videos = document.querySelectorAll('video');

            for (const video of videos) {
                const src = video.src || video.querySelector('source')?.src;
                if (src && !src.includes('blob:')) {
                    const post = video.closest('.feed-shared-update-v2, .video-embed');
                    const author = post?.querySelector('.update-components-actor__name')?.textContent ||
                        post?.querySelector('.feed-shared-actor__name')?.textContent;
                    const title = post?.querySelector('.update-components-text')?.textContent?.slice(0, 100) ||
                        document.title;

                    notifyBackground({
                        url: src,
                        title: title,
                        author: author,
                        type: src.includes('.m3u8') ? 'HLS' : 'MP4'
                    });
                    return;
                }
            }

            const videoContainers = document.querySelectorAll('[data-video-url]');
            for (const container of videoContainers) {
                const url = container.dataset.videoUrl;
                if (url) {
                    notifyBackground({
                        url: url,
                        title: document.title,
                        type: 'MP4'
                    });
                    return;
                }
            }

        } catch (err) {
            console.error('[LinkedIn] Extraction error:', err);
        }
    }

    setTimeout(extractVideo, 2000);

})();
