(function () {
    const SITE_ID = 'tumblr';

    if (window.__SITE_SPECIALIST_LOADED === SITE_ID) return;
    window.__SITE_SPECIALIST_LOADED = SITE_ID;

    function log(...args) {
        console.log(`[Specialist][${SITE_ID}]`, ...args);
    }

    function sendToBackground(videos) {
        window.postMessage({
            type: 'LALHLIMPUII_JAHAU_DETECTED',
            source: SITE_ID,
            data: { videos }
        }, '*');
    }

    function extractFromTumblrData() {
        const videos = [];
        const scripts = document.querySelectorAll('script');

        for (const script of scripts) {
            const content = script.textContent || '';

            const videoMatch = content.match(/"video_url"\s*:\s*"([^"]+)"/g);
            if (videoMatch) {
                for (const match of videoMatch) {
                    const urlMatch = match.match(/"([^"]+)"$/);
                    if (urlMatch) {
                        const url = urlMatch[1].replace(/\\u002F/g, '/');
                        videos.push({
                            url,
                            type: url.includes('.m3u8') ? 'hls' : 'mp4',
                            quality: 'auto',
                            title: document.title
                        });
                    }
                }
            }

            const hdMatch = content.match(/"hdUrl"\s*:\s*"([^"]+)"/);
            if (hdMatch) {
                const url = hdMatch[1].replace(/\\u002F/g, '/');
                videos.push({
                    url,
                    type: 'mp4',
                    quality: 'hd',
                    title: document.title
                });
            }

            const embedMatch = content.match(/"embed_code"\s*:\s*"([^"]+)"/);
            if (embedMatch) {
                try {
                    const decoded = decodeURIComponent(embedMatch[1]);
                    const srcMatch = decoded.match(/src=["']([^"']+)["']/);
                    if (srcMatch) {
                        videos.push({
                            url: srcMatch[1],
                            type: 'embed',
                            quality: 'auto',
                            title: document.title
                        });
                    }
                } catch {  }
            }
        }

        return videos;
    }

    function extractFromVideoElements() {
        const videos = [];

        const videoElements = document.querySelectorAll('video.tumblr_video_container, video[data-npf-url], video');
        for (const video of videoElements) {
            const src = video.src || video.currentSrc || video.getAttribute('data-npf-url');
            if (src && !src.startsWith('blob:')) {
                videos.push({
                    url: src,
                    type: src.includes('.m3u8') ? 'hls' : 'mp4',
                    quality: 'auto',
                    title: document.title
                });
            }

            const sources = video.querySelectorAll('source');
            for (const source of sources) {
                if (source.src) {
                    videos.push({
                        url: source.src,
                        type: source.type?.includes('mpegurl') ? 'hls' : 'mp4',
                        quality: 'auto',
                        title: document.title
                    });
                }
            }
        }

        const iframes = document.querySelectorAll('iframe[src*="tumblr.com"]');
        for (const iframe of iframes) {
            if (iframe.src) {
                videos.push({
                    url: iframe.src,
                    type: 'embed',
                    quality: 'auto',
                    title: document.title
                });
            }
        }

        return videos;
    }

    function extractFromDataAttributes() {
        const videos = [];

        const elements = document.querySelectorAll('[data-video-url], [data-tumblr-video]');
        for (const el of elements) {
            const videoUrl = el.getAttribute('data-video-url') || el.getAttribute('data-tumblr-video');
            if (videoUrl) {
                videos.push({
                    url: videoUrl,
                    type: videoUrl.includes('.m3u8') ? 'hls' : 'mp4',
                    quality: 'auto',
                    title: document.title
                });
            }
        }

        return videos;
    }

    function extractFromMetaTags() {
        const videos = [];

        const ogVideo = document.querySelector('meta[property="og:video"]');
        const ogVideoUrl = document.querySelector('meta[property="og:video:url"]');

        const videoUrl = ogVideoUrl?.content || ogVideo?.content;
        if (videoUrl) {
            videos.push({
                url: videoUrl,
                type: videoUrl.includes('.m3u8') ? 'hls' : 'mp4',
                quality: 'auto',
                title: document.querySelector('meta[property="og:title"]')?.content || document.title
            });
        }

        return videos;
    }

    function extractAll() {
        const allVideos = [
            ...extractFromTumblrData(),
            ...extractFromVideoElements(),
            ...extractFromDataAttributes(),
            ...extractFromMetaTags()
        ];

        const seen = new Set();
        const unique = allVideos.filter(v => {
            const key = v.url;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

        if (unique.length > 0) {
            log(`Found ${unique.length} videos`);
            sendToBackground(unique);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', extractAll);
    } else {
        extractAll();
    }

    const observer = new MutationObserver(() => {
        setTimeout(extractAll, 1000);
    });

    observer.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true
    });

    setInterval(extractAll, 5000);

    log('Tumblr specialist initialized');
})();
