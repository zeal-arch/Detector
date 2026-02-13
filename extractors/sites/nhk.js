(function () {
    const SITE_ID = 'nhk';

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

    function extractFromNHKPlayer() {
        const videos = [];
        const scripts = document.querySelectorAll('script');

        for (const script of scripts) {
            const content = script.textContent || '';

            const playerMatch = content.match(/NHKPlayerConfig\s*[=:]\s*(\{[\s\S]*?\});/);
            if (playerMatch) {
                try {
                    const config = JSON.parse(playerMatch[1]);
                    if (config.movie?.url) {
                        videos.push({
                            url: config.movie.url,
                            type: 'hls',
                            quality: 'auto',
                            title: config.movie.title || document.title
                        });
                    }
                } catch {  }
            }

            const videoMatch = content.match(/"videoUrl"\s*:\s*"([^"]+)"/);
            if (videoMatch) {
                videos.push({
                    url: videoMatch[1],
                    type: videoMatch[1].includes('.m3u8') ? 'hls' : 'mp4',
                    quality: 'auto',
                    title: document.title
                });
            }

            const hlsMatch = content.match(/["'](https?:\/\/[^"']+nhk[^"']+\.m3u8[^"']*)["']/g);
            if (hlsMatch) {
                for (const match of hlsMatch) {
                    const url = match.slice(1, -1);
                    videos.push({
                        url,
                        type: 'hls',
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

        const playerElements = document.querySelectorAll('[data-movie-url], [data-video-id], .nhk-player');
        for (const el of playerElements) {
            const movieUrl = el.getAttribute('data-movie-url');
            if (movieUrl) {
                videos.push({
                    url: movieUrl,
                    type: movieUrl.includes('.m3u8') ? 'hls' : 'mp4',
                    quality: 'auto',
                    title: document.title
                });
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
        }

        return videos;
    }

    function extractFromLDJson() {
        const videos = [];
        const ldJsonScripts = document.querySelectorAll('script[type="application/ld+json"]');

        for (const script of ldJsonScripts) {
            try {
                const data = JSON.parse(script.textContent);
                const items = Array.isArray(data) ? data : [data];

                for (const item of items) {
                    if (item['@type'] === 'VideoObject') {
                        if (item.contentUrl) {
                            videos.push({
                                url: item.contentUrl,
                                type: item.contentUrl.includes('.m3u8') ? 'hls' : 'mp4',
                                quality: 'auto',
                                title: item.name || document.title,
                                thumbnail: item.thumbnailUrl,
                                duration: item.duration
                            });
                        }
                    }
                }
            } catch {  }
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
            ...extractFromNHKPlayer(),
            ...extractFromDataAttributes(),
            ...extractFromVideoElements(),
            ...extractFromLDJson(),
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

    log('NHK specialist initialized');
})();
