(function () {
    'use strict';

    console.log('[9GAG Specialist] Loaded on:', window.location.href);

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
                options: videoData
            }
        }, '*');

        window.__SPECIALIST_DETECTED = true;
    }

    async function extractVideo() {
        try {
            const postId = extractPostId(window.location.href);
            if (!postId) return;

            const apiData = await fetchFromAPI(postId);
            if (apiData) {
                notifyBackground(apiData);
            }

        } catch (err) {
            console.error('[9GAG] Extraction error:', err);
        }
    }

    async function fetchFromAPI(postId) {
        try {
            const response = await fetch(`https://9gag.com/v1/post?id=${postId}`);
            const data = await response.json();
            const post = data.data?.post;

            if (!post || post.type !== 'Animated') return null;

            const images = post.images || {};
            let bestVideo = null;
            let bestQuality = 0;

            for (const [key, image] of Object.entries(images)) {
                if (image.url && (key.includes('video') || key.includes('webm') || key.includes('mp4'))) {
                    const quality = image.width * image.height;
                    if (quality > bestQuality) {
                        bestQuality = quality;
                        bestVideo = image;
                    }
                }
            }

            if (!bestVideo) return null;

            return {
                url: bestVideo.url,
                type: bestVideo.url.endsWith('.webm') ? 'WEBM' : 'MP4',
                customTitle: post.title,
                author: post.creator?.username,
                authorUrl: post.creator?.profileUrl,
                thumbnail: post.images?.image700?.url || post.images?.image460?.url,
                viewCount: post.views,
                likes: post.upVoteCount,
                width: bestVideo.width,
                height: bestVideo.height,
                uploadDate: new Date(post.creationTs * 1000).toISOString(),
                tags: post.tags?.map(t => t.key),
                pageUrl: window.location.href,
            };

        } catch (err) {
            console.error('[9GAG] API fetch failed:', err);
            return null;
        }
    }

    function extractPostId(url) {

        const match = url.match(/\/gag\/([a-zA-Z0-9]+)/);
        return match ? match[1] : null;
    }

    window.__SPECIALIST_DETECTED = false;
    extractVideo();
    setTimeout(extractVideo, 500);
    setTimeout(extractVideo, 1000);

    let lastUrl = window.location.href;
    new MutationObserver(() => {
        if (window.location.href !== lastUrl) {
            lastUrl = window.location.href;
            processedVideos.clear();
            setTimeout(extractVideo, 300);
        }
    }).observe(document.documentElement, {
        childList: true,
        subtree: true
    });

    console.log('[9GAG Specialist] Initialized');
})();
