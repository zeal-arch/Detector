(function () {
    const SITE_ID = 'twitcasting';

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

    function extractFromTwitCastingData() {
        const videos = [];
        const scripts = document.querySelectorAll('script');

        for (const script of scripts) {
            const content = script.textContent || '';

            const movieMatch = content.match(/TwitCasting\.Movie\s*=\s*(\{[\s\S]*?\});/);
            if (movieMatch) {
                try {
                    const movie = JSON.parse(movieMatch[1]);
                    if (movie.liveUrl || movie.hlsUrl) {
                        videos.push({
                            url: movie.liveUrl || movie.hlsUrl,
                            type: 'hls',
                            quality: 'auto',
                            title: movie.title || document.title,
                            isLive: !!movie.isLive
                        });
                    }
                    if (movie.mp4Url) {
                        videos.push({
                            url: movie.mp4Url,
                            type: 'mp4',
                            quality: 'auto',
                            title: movie.title || document.title
                        });
                    }
                } catch {  }
            }

            const settingsMatch = content.match(/playerSettings\s*[=:]\s*(\{[\s\S]*?\})\s*[,;]/);
            if (settingsMatch) {
                try {
                    const settings = JSON.parse(settingsMatch[1]);
                    if (settings.movie?.hls) {
                        videos.push({
                            url: settings.movie.hls,
                            type: 'hls',
                            quality: 'auto',
                            title: settings.movie.title || document.title
                        });
                    }
                } catch {  }
            }

            const hlsMatch = content.match(/["'](https?:\/\/[^"']+\.twitcasting\.tv[^"']+\.m3u8[^"']*)["']/g);
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

        const playerElements = document.querySelectorAll('[data-movie-url], [data-hls-url], #player');
        for (const el of playerElements) {
            const movieUrl = el.getAttribute('data-movie-url');
            const hlsUrl = el.getAttribute('data-hls-url');

            if (movieUrl) {
                videos.push({
                    url: movieUrl,
                    type: movieUrl.includes('.m3u8') ? 'hls' : 'mp4',
                    quality: 'auto',
                    title: document.title
                });
            }
            if (hlsUrl) {
                videos.push({
                    url: hlsUrl,
                    type: 'hls',
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

    function extractFromLDJson() {
        const videos = [];
        const ldJsonScripts = document.querySelectorAll('script[type="application/ld+json"]');

        for (const script of ldJsonScripts) {
            try {
                const data = JSON.parse(script.textContent);
                const items = Array.isArray(data) ? data : [data];

                for (const item of items) {
                    if (item['@type'] === 'VideoObject' || item['@type'] === 'BroadcastEvent') {
                        if (item.contentUrl) {
                            videos.push({
                                url: item.contentUrl,
                                type: item.contentUrl.includes('.m3u8') ? 'hls' : 'mp4',
                                quality: 'auto',
                                title: item.name || document.title
                            });
                        }
                    }
                }
            } catch {  }
        }

        return videos;
    }

    function extractAll() {
        const allVideos = [
            ...extractFromTwitCastingData(),
            ...extractFromDataAttributes(),
            ...extractFromVideoElements(),
            ...extractFromMetaTags(),
            ...extractFromLDJson()
        ];

        const seen = new Set();
        const unique = allVideos.filter(v => {
            const key = v.url;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

        if (unique.length > 0) {
            log(`Found ${unique.length} videos/streams`);
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

    log('TwitCasting specialist initialized');
})();
