(function () {
    const SITE_ID = 'francetv';

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

    function extractFromFranceTVPlayer() {
        const videos = [];
        const scripts = document.querySelectorAll('script');

        for (const script of scripts) {
            const content = script.textContent || '';

            const playerMatch = content.match(/FranceTVEmbed\.init\s*\(\s*(\{[\s\S]*?\})\s*\)/);
            if (playerMatch) {
                try {
                    const config = JSON.parse(playerMatch[1]);
                    if (config.video_id) {
                        videos.push({
                            videoId: config.video_id,
                            type: 'francetv',
                            quality: 'auto',
                            title: config.title || document.title
                        });
                    }
                } catch {  }
            }

            const hlsMatch = content.match(/["'](https?:\/\/[^"']+\.francetv[^"']+\.m3u8[^"']*)["']/g);
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

            const videoMatch = content.match(/"video"\s*:\s*\{([^}]+)\}/);
            if (videoMatch) {
                const urlMatch = videoMatch[1].match(/"url"\s*:\s*"([^"]+)"/);
                if (urlMatch) {
                    videos.push({
                        url: urlMatch[1],
                        type: urlMatch[1].includes('.m3u8') ? 'hls' : 'mp4',
                        quality: 'auto',
                        title: document.title
                    });
                }
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

                const videoData = pageProps?.video || pageProps?.content?.video;
                if (videoData) {
                    if (videoData.url) {
                        videos.push({
                            url: videoData.url,
                            type: 'hls',
                            quality: 'auto',
                            title: videoData.title || document.title
                        });
                    }
                    if (videoData.video_id || videoData.id) {
                        videos.push({
                            videoId: videoData.video_id || videoData.id,
                            type: 'francetv',
                            quality: 'auto',
                            title: videoData.title || document.title
                        });
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
                        if (item.embedUrl) {
                            videos.push({
                                url: item.embedUrl,
                                type: 'embed',
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

    function extractFromDataAttributes() {
        const videos = [];

        const playerElements = document.querySelectorAll('[data-video], [data-video-id], .ftv-player');
        for (const el of playerElements) {
            const videoData = el.getAttribute('data-video');
            if (videoData) {
                try {
                    const data = JSON.parse(videoData);
                    if (data.url) {
                        videos.push({
                            url: data.url,
                            type: 'hls',
                            quality: 'auto',
                            title: data.title || document.title
                        });
                    }
                } catch {  }
            }

            const videoId = el.getAttribute('data-video-id');
            if (videoId) {
                videos.push({
                    videoId,
                    type: 'francetv',
                    quality: 'auto',
                    title: document.title
                });
            }
        }

        return videos;
    }

    function extractAll() {
        const allVideos = [
            ...extractFromFranceTVPlayer(),
            ...extractFromNextData(),
            ...extractFromLDJson(),
            ...extractFromDataAttributes()
        ].filter(v => v.url || v.videoId);

        const seen = new Set();
        const unique = allVideos.filter(v => {
            const key = v.url || v.videoId;
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

    log('FranceTV specialist initialized');
})();
