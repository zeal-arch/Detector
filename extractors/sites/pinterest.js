(function () {
    'use strict';
    console.log('[Pinterest Specialist] Loaded on:', window.location.href);
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
                    platform: 'pinterest'
                }
            }
        }, '*');
        window.__SPECIALIST_DETECTED = true;
    }

    function extractVideo() {
        try {

            const scripts = document.querySelectorAll('script[data-relay-response], script[type="application/json"]');

            for (const script of scripts) {
                try {
                    const data = JSON.parse(script.textContent);

                    const findVideo = (obj) => {
                        if (!obj || typeof obj !== 'object') return null;
                        if (obj.videos && obj.videos.video_list) {
                            const v = obj.videos.video_list;
                            return v.V_720P || v.V_480P || v.V_HLSV4 || Object.values(v)[0];
                        }
                        for (const key of Object.keys(obj)) {
                            const result = findVideo(obj[key]);
                            if (result) return result;
                        }
                        return null;
                    };

                    const video = findVideo(data);
                    if (video?.url) {
                        const title = document.querySelector('h1')?.textContent || document.title;
                        notifyBackground({
                            url: video.url,
                            title: title,
                            type: video.url.includes('.m3u8') ? 'HLS' : 'MP4'
                        });
                        return;
                    }
                } catch {  }
            }

            const video = document.querySelector('video');
            if (video?.src) {
                notifyBackground({
                    url: video.src,
                    title: document.title,
                    type: 'MP4'
                });
            }

        } catch (err) {
            console.error('[Pinterest] Extraction error:', err);
        }
    }

    setTimeout(extractVideo, 2000);

})();
