(function () {
    'use strict';

    console.log('[Imgur Specialist] Loaded on:', window.location.href);

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
                type: 'MP4',
                options: videoData
            }
        }, '*');

        window.__SPECIALIST_DETECTED = true;
    }

    async function extractVideo() {
        try {
            const itemId = extractItemId(window.location.href);
            if (!itemId) return;

            const pageData = extractFromPage();
            if (pageData) {
                notifyBackground(pageData);
                return;
            }

            const apiData = await fetchFromAPI(itemId);
            if (apiData) {
                notifyBackground(apiData);
            }

        } catch (err) {
            console.error('[Imgur] Extraction error:', err);
        }
    }

    function extractFromPage() {

        if (window.postDataJSON) {
            const media = window.postDataJSON.media?.[0];
            if (media && (media.type === 'video' || media.type === 'gifv')) {
                return {
                    url: media.url.replace('.gifv', '.mp4'),
                    customTitle: window.postDataJSON.title || document.title,
                    author: window.postDataJSON.account_username,
                    thumbnail: media.thumbnail_url,
                    viewCount: window.postDataJSON.view_count,
                    width: media.width,
                    height: media.height,
                    pageUrl: window.location.href,
                };
            }
        }

        const videoEl = document.querySelector('video.post-image, video[src]');
        if (videoEl && videoEl.src) {
            return {
                url: videoEl.src,
                customTitle: document.title,
                thumbnail: videoEl.poster,
                width: videoEl.videoWidth,
                height: videoEl.videoHeight,
                pageUrl: window.location.href,
            };
        }

        return null;
    }

    async function fetchFromAPI(itemId) {
        try {
            const CLIENT_ID = '546c25a59c58ad7';
            const response = await fetch(
                `https://api.imgur.com/post/v1/posts/${itemId}?client_id=${CLIENT_ID}&include=media,account`
            );
            const data = await response.json();

            const media = data.media?.[0];
            if (!media || (media.type !== 'video' && media.type !== 'gifv')) return null;

            return {
                url: media.url.replace('.gifv', '.mp4'),
                customTitle: data.title || `Imgur ${itemId}`,
                author: data.account?.username,
                authorUrl: data.account?.username ? `https://imgur.com/user/${data.account.username}` : null,
                thumbnail: media.thumbnail_url,
                viewCount: data.view_count,
                width: media.width,
                height: media.height,
                uploadDate: data.created_at,
                pageUrl: window.location.href,
            };

        } catch (err) {
            console.error('[Imgur] API fetch failed:', err);
            return null;
        }
    }

    function extractItemId(url) {

        let match = url.match(/imgur\.com\/(?:gallery\/)?([a-zA-Z0-9]+)/);
        if (match) return match[1];

        match = url.match(/i\.imgur\.com\/([a-zA-Z0-9]+)/);
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

    console.log('[Imgur Specialist] Initialized');
})();
