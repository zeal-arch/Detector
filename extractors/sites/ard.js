(function () {
    const SITE_ID = 'ard';

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

    function extractFromPlayerConfig() {
        const videos = [];
        const scripts = document.querySelectorAll('script');

        for (const script of scripts) {
            const content = script.textContent || '';

            const configMatch = content.match(/playerConfig\s*[=:]\s*(\{[\s\S]*?\});/);
            if (configMatch) {
                try {
                    const config = JSON.parse(configMatch[1]);
                    if (config._mediaArray) {
                        for (const media of config._mediaArray) {
                            if (media._stream) {
                                videos.push({
                                    url: media._stream,
                                    type: media._stream.includes('.m3u8') ? 'hls' : 'mp4',
                                    quality: media._quality || 'auto',
                                    title: config._title || document.title
                                });
                            }
                        }
                    }
                } catch {  }
            }

            const mediaMatch = content.match(/"_mediaCollection"\s*:\s*(\{[\s\S]*?\})\s*[,}]/);
            if (mediaMatch) {
                try {
                    const media = JSON.parse(mediaMatch[1]);
                    if (media._streams) {
                        for (const stream of media._streams) {
                            if (stream._stream) {
                                videos.push({
                                    url: stream._stream,
                                    type: stream._stream.includes('.m3u8') ? 'hls' : 'mp4',
                                    quality: stream._quality || 'auto',
                                    title: document.title
                                });
                            }
                        }
                    }
                } catch {  }
            }
        }

        return videos;
    }

    function extractFromArdApi() {
        const videos = [];

        const dataElements = document.querySelectorAll('[data-v]');
        for (const el of dataElements) {
            try {
                const data = JSON.parse(el.getAttribute('data-v'));
                if (data.streams) {
                    for (const stream of data.streams) {
                        videos.push({
                            url: stream.url || stream.src,
                            type: stream.url?.includes('.m3u8') ? 'hls' : 'mp4',
                            quality: stream.quality || 'auto',
                            title: data.title || document.title
                        });
                    }
                }
            } catch {  }
        }

        const nextData = document.querySelector('script#__NEXT_DATA__');
        if (nextData) {
            try {
                const data = JSON.parse(nextData.textContent);
                const widgets = data?.props?.pageProps?.page?.widgets || [];

                for (const widget of widgets) {
                    if (widget.mediaCollection) {
                        const streams = widget.mediaCollection.embedded?._mediaArray || [];
                        for (const media of streams) {
                            if (media._stream) {
                                videos.push({
                                    url: media._stream,
                                    type: media._stream.includes('.m3u8') ? 'hls' : 'mp4',
                                    quality: media._quality || 'auto',
                                    title: widget.title || document.title
                                });
                            }
                        }
                    }
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
                                type: item.contentUrl.includes('.m3u8') ? 'hls' : 'mp4',
                                quality: 'auto',
                                title: item.name || document.title,
                                thumbnail: item.thumbnailUrl
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
            ...extractFromPlayerConfig(),
            ...extractFromArdApi(),
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

    log('ARD specialist initialized');
})();
