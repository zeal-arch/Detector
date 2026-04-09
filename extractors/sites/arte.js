(function () {
    const SITE_ID = 'arte';

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

    function extractFromArtePlayer() {
        const videos = [];
        const scripts = document.querySelectorAll('script');

        for (const script of scripts) {
            const content = script.textContent || '';

            const playerMatch = content.match(/artePlayer\s*\(\s*["']([^"']+)["']\s*,\s*(\{[\s\S]*?\})\s*\)/);
            if (playerMatch) {
                try {
                    const config = JSON.parse(playerMatch[2]);
                    if (config.json_url) {
                        videos.push({
                            url: config.json_url,
                            type: 'json',
                            quality: 'auto',
                            title: config.title || document.title
                        });
                    }
                } catch {  }
            }

            const hlsMatch = content.match(/["'](https?:\/\/[^"']+\/hls\/[^"']+\.m3u8[^"']*)["']/g);
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

            const streamsMatch = content.match(/"streams"\s*:\s*\[([^\]]+)\]/);
            if (streamsMatch) {
                try {
                    const streams = JSON.parse(`[${streamsMatch[1]}]`);
                    for (const stream of streams) {
                        if (stream.url) {
                            videos.push({
                                url: stream.url,
                                type: stream.type || 'hls',
                                quality: stream.quality || stream.slot || 'auto',
                                title: document.title
                            });
                        }
                    }
                } catch {  }
            }
        }

        return videos;
    }

    function extractFromNextData() {
        const videos = [];
        const nextData = document.querySelector('script#__NEXT_DATA__');

        if (nextData) {
            try {
                const data = JSON.parse(nextData.textContent);
                const pageProps = data?.props?.pageProps;

                const videoData = pageProps?.initialPage?.zones?.[0]?.content?.data ||
                    pageProps?.program?.videos ||
                    pageProps?.video;

                if (Array.isArray(videoData)) {
                    for (const video of videoData) {
                        if (video.url || video.streaming_url) {
                            videos.push({
                                url: video.url || video.streaming_url,
                                type: 'hls',
                                quality: video.quality || 'auto',
                                title: video.title || document.title
                            });
                        }
                    }
                } else if (videoData?.url) {
                    videos.push({
                        url: videoData.url,
                        type: 'hls',
                        quality: 'auto',
                        title: videoData.title || document.title
                    });
                }
            } catch {  }
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
                                type: 'hls',
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

    function extractFromDataAttributes() {
        const videos = [];

        const playerElements = document.querySelectorAll('[data-arte-vp], [data-json-url], .arte-player');
        for (const el of playerElements) {
            const jsonUrl = el.getAttribute('data-json-url');
            if (jsonUrl) {
                videos.push({
                    url: jsonUrl,
                    type: 'json',
                    quality: 'auto',
                    title: document.title
                });
            }

            const vpConfig = el.getAttribute('data-arte-vp');
            if (vpConfig) {
                try {
                    const config = JSON.parse(vpConfig);
                    if (config.url) {
                        videos.push({
                            url: config.url,
                            type: 'hls',
                            quality: 'auto',
                            title: config.title || document.title
                        });
                    }
                } catch {  }
            }
        }

        return videos;
    }

    function extractAll() {
        const allVideos = [
            ...extractFromArtePlayer(),
            ...extractFromNextData(),
            ...extractFromLDJson(),
            ...extractFromDataAttributes()
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

    log('Arte specialist initialized');
})();
