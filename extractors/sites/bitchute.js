(function () {
    'use strict';

    console.log('[Bitchute Specialist] Loaded on:', window.location.href);

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

            const pageData = extractFromPage();
            if (pageData) {
                notifyBackground(pageData);
            }

        } catch (err) {
            console.error('[Bitchute] Extraction error:', err);
        }
    }

    function extractFromPage() {

        const videoEl = document.querySelector('video[src], video source[src]');
        if (videoEl) {
            const src = videoEl.tagName === 'SOURCE' ? videoEl.src : videoEl.src;
            if (src) {
                return {
                    url: src,
                    customTitle: document.querySelector('.video-title')?.textContent?.trim() || document.title,
                    author: document.querySelector('.channel-name')?.textContent?.trim(),
                    authorUrl: document.querySelector('.channel-name a')?.href,
                    thumbnail: videoEl.poster || document.querySelector('meta[property="og:image"]')?.content,
                    viewCount: extractViewCount(),
                    width: videoEl.videoWidth,
                    height: videoEl.videoHeight,
                    pageUrl: window.location.href,
                };
            }
        }

        const scripts = document.querySelectorAll('script');
        for (const script of scripts) {
            const text = script.textContent;

            const urlMatch = text.match(/["']https:\/\/seed\d+\.bitchute\.com\/[^"']+\.mp4["']/);
            if (urlMatch) {
                const url = urlMatch[0].replace(/['"]/g, '');
                return {
                    url: url,
                    customTitle: document.querySelector('.video-title')?.textContent?.trim() || document.title,
                    author: document.querySelector('.channel-name')?.textContent?.trim(),
                    thumbnail: document.querySelector('meta[property="og:image"]')?.content,
                    viewCount: extractViewCount(),
                    pageUrl: window.location.href,
                };
            }
        }

        return null;
    }

    function extractViewCount() {

        const viewText = document.querySelector('.video-views')?.textContent;
        if (viewText) {
            const match = viewText.match(/([\d,]+)/);
            if (match) {
                return parseInt(match[1].replace(/,/g, ''));
            }
        }
        return null;
    }

    window.__SPECIALIST_DETECTED = false;
    extractVideo();
    setTimeout(extractVideo, 500);
    setTimeout(extractVideo, 1000);
    setTimeout(extractVideo, 2000);

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

    console.log('[Bitchute Specialist] Initialized');
})();
