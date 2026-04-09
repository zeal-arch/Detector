(function () {
    const SITE_ID = 'raiplay';

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

    function extractFromRaiConfig() {
        const videos = [];
        const scripts = document.querySelectorAll('script');

        for (const script of scripts) {
            const content = script.textContent || '';

            const playerMatch = content.match(/PlayerSettings\s*[=:]\s*(\{[\s\S]*?\});/);
            if (playerMatch) {
                try {
                    const config = JSON.parse(playerMatch[1]);
                    if (config.video?.url) {
                        videos.push({
                            url: config.video.url,
                            type: config.video.url.includes('.m3u8') ? 'hls' : 'mp4',
                            quality: 'auto',
                            title: config.video.title || document.title
                        });
                    }
                } catch {  }
            }

            const urlMatch = content.match(/["'](https?:\/\/[^"']*(?:creativemedia|raiplay)[^"']*\.m3u8[^"']*)["']/g);
            if (urlMatch) {
                for (const match of urlMatch) {
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

        const playerElements = document.querySelectorAll('[data-video-url], [data-video-json], .rai-player');
        for (const el of playerElements) {
            const videoUrl = el.getAttribute('data-video-url');
            if (videoUrl) {
                videos.push({
                    url: videoUrl,
                    type: videoUrl.includes('.m3u8') ? 'hls' : 'mp4',
                    quality: 'auto',
                    title: el.getAttribute('data-video-title') || document.title
                });
            }

            const jsonUrl = el.getAttribute('data-video-json');
            if (jsonUrl) {
                videos.push({
                    url: jsonUrl,
                    type: 'json',
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

    function extractFromPageJson() {
        const videos = [];

        const nextData = document.querySelector('script#__NEXT_DATA__');
        if (nextData) {
            try {
                const data = JSON.parse(nextData.textContent);
                const videoData = data?.props?.pageProps?.program ||
                    data?.props?.pageProps?.video ||
                    data?.props?.pageProps?.episode;

                if (videoData) {
                    const url = videoData.video?.url || videoData.content_url || videoData.url;
                    if (url) {
                        videos.push({
                            url,
                            type: url.includes('.m3u8') ? 'hls' : 'mp4',
                            quality: 'auto',
                            title: videoData.title || videoData.name || document.title
                        });
                    }
                }
            } catch {  }
        }

        const jsonScripts = document.querySelectorAll('script[type="application/json"]');
        for (const script of jsonScripts) {
            try {
                const data = JSON.parse(script.textContent);
                if (data.video?.url) {
                    videos.push({
                        url: data.video.url,
                        type: data.video.url.includes('.m3u8') ? 'hls' : 'mp4',
                        quality: 'auto',
                        title: data.video.title || data.title || document.title
                    });
                }
            } catch {  }
        }

        return videos;
    }

    function extractAll() {
        const allVideos = [
            ...extractFromRaiConfig(),
            ...extractFromDataAttributes(),
            ...extractFromLDJson(),
            ...extractFromPageJson()
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

    log('RaiPlay specialist initialized');
})();
