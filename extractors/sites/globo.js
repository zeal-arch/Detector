(function () {
    const SITE_ID = 'globo';

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

    function extractFromGloboPlayer() {
        const videos = [];

        const scripts = document.querySelectorAll('script');
        for (const script of scripts) {
            const content = script.textContent || '';

            const playerMatch = content.match(/player\.load\s*\(\s*(\{[\s\S]*?\})\s*\)/);
            if (playerMatch) {
                try {
                    const data = JSON.parse(playerMatch[1]);
                    if (data.url || data.sources) {
                        const sources = data.sources || [{ url: data.url }];
                        for (const source of sources) {
                            if (source.url) {
                                videos.push({
                                    url: source.url,
                                    type: source.url.includes('.m3u8') ? 'hls' : 'mp4',
                                    quality: source.label || 'auto',
                                    title: data.title || document.title
                                });
                            }
                        }
                    }
                } catch {  }
            }

            const videoMatch = content.match(/"videos"\s*:\s*\[([^\]]+)\]/);
            if (videoMatch) {
                try {
                    const videoData = JSON.parse(`[${videoMatch[1]}]`);
                    for (const video of videoData) {
                        if (video.url) {
                            videos.push({
                                url: video.url,
                                type: video.url.includes('.m3u8') ? 'hls' : 'mp4',
                                quality: video.height ? `${video.height}p` : 'auto',
                                title: video.title || document.title
                            });
                        }
                    }
                } catch {  }
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
                                title: item.name || item.headline || document.title,
                                thumbnail: item.thumbnailUrl,
                                duration: item.duration
                            });
                        }
                        if (item.embedUrl) {
                            videos.push({
                                url: item.embedUrl,
                                type: 'embed',
                                quality: 'auto',
                                title: item.name || item.headline || document.title
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
        const ogSecureUrl = document.querySelector('meta[property="og:video:secure_url"]');

        const videoUrl = ogSecureUrl?.content || ogVideoUrl?.content || ogVideo?.content;
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

    function extractFromGloboplay() {
        const videos = [];

        const nextData = document.querySelector('script#__NEXT_DATA__');
        if (nextData) {
            try {
                const data = JSON.parse(nextData.textContent);
                const videoData = data?.props?.pageProps?.video ||
                    data?.props?.pageProps?.media ||
                    data?.props?.pageProps?.episode;

                if (videoData) {
                    if (videoData.resources) {
                        for (const resource of videoData.resources) {
                            videos.push({
                                url: resource.url || resource.src,
                                type: resource.type || 'hls',
                                quality: resource.height ? `${resource.height}p` : 'auto',
                                title: videoData.title || document.title
                            });
                        }
                    }
                    if (videoData.url) {
                        videos.push({
                            url: videoData.url,
                            type: 'hls',
                            quality: 'auto',
                            title: videoData.title || document.title
                        });
                    }
                }
            } catch {  }
        }

        return videos;
    }

    function extractAll() {
        const allVideos = [
            ...extractFromGloboPlayer(),
            ...extractFromGloboplay(),
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

    log('Globo specialist initialized');
})();
