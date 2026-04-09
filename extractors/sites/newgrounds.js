(function () {
    const SITE_ID = 'newgrounds';

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

    function extractFromNewgroundsPlayer() {
        const videos = [];
        const scripts = document.querySelectorAll('script');

        for (const script of scripts) {
            const content = script.textContent || '';

            const embedMatch = content.match(/embed\.setOptions\s*\(\s*(\{[\s\S]*?\})\s*\)/);
            if (embedMatch) {
                try {
                    const options = JSON.parse(embedMatch[1]);
                    if (options.sources) {
                        for (const source of options.sources) {
                            videos.push({
                                url: source.src || source,
                                type: (source.type || '').includes('mpegurl') ? 'hls' : 'mp4',
                                quality: source.quality || 'auto',
                                title: options.title || document.title
                            });
                        }
                    }
                } catch {  }
            }

            const movieMatch = content.match(/"movie"\s*:\s*\{([^}]+)\}/);
            if (movieMatch) {
                const srcMatch = movieMatch[1].match(/"src"\s*:\s*"([^"]+)"/);
                if (srcMatch) {
                    videos.push({
                        url: srcMatch[1],
                        type: srcMatch[1].includes('.m3u8') ? 'hls' : 'mp4',
                        quality: 'auto',
                        title: document.title
                    });
                }
            }

            const sourceMatch = content.match(/"sources"\s*:\s*\[([^\]]+)\]/);
            if (sourceMatch) {
                try {
                    const sources = JSON.parse(`[${sourceMatch[1]}]`);
                    for (const source of sources) {
                        const url = source.src || source;
                        if (typeof url === 'string') {
                            videos.push({
                                url,
                                type: url.includes('.m3u8') ? 'hls' : 'mp4',
                                quality: source.quality || source.label || 'auto',
                                title: document.title
                            });
                        }
                    }
                } catch {  }
            }
        }

        return videos;
    }

    function extractFromVideoElements() {
        const videos = [];
        const videoElements = document.querySelectorAll('video');

        for (const video of videoElements) {
            const src = video.src || video.currentSrc;
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

        return videos;
    }

    function extractFromDataAttributes() {
        const videos = [];

        const players = document.querySelectorAll('[data-movie-url], [data-video-src], .ng-video-player');
        for (const player of players) {
            const movieUrl = player.getAttribute('data-movie-url');
            const videoSrc = player.getAttribute('data-video-src');

            const url = movieUrl || videoSrc;
            if (url) {
                videos.push({
                    url,
                    type: url.includes('.m3u8') ? 'hls' : 'mp4',
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
            ...extractFromNewgroundsPlayer(),
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

    log('Newgrounds specialist initialized');
})();
