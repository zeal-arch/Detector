(function () {
    const SITE_ID = 'bloomberg';

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

    function extractFromBloombergPlayer() {
        const videos = [];
        const scripts = document.querySelectorAll('script');

        for (const script of scripts) {
            const content = script.textContent || '';

            const videoMatch = content.match(/"video"\s*:\s*(\{[\s\S]*?\})\s*[,}]/);
            if (videoMatch) {
                try {
                    const video = JSON.parse(videoMatch[1]);
                    if (video.url || video.secureUrl) {
                        videos.push({
                            url: video.secureUrl || video.url,
                            type: (video.secureUrl || video.url).includes('.m3u8') ? 'hls' : 'mp4',
                            quality: 'auto',
                            title: video.title || document.title
                        });
                    }
                } catch {  }
            }

            const hlsMatch = content.match(/["'](https?:\/\/[^"']+\.bloomberg[^"']+\.m3u8[^"']*)["']/g);
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

            const configMatch = content.match(/videoConfig\s*[=:]\s*(\{[\s\S]*?\});/);
            if (configMatch) {
                try {
                    const config = JSON.parse(configMatch[1]);
                    if (config.secureUrl || config.hlsUrl) {
                        videos.push({
                            url: config.secureUrl || config.hlsUrl,
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

    function extractFromNextData() {
        const videos = [];
        const nextData = document.querySelector('script#__NEXT_DATA__');

        if (nextData) {
            try {
                const data = JSON.parse(nextData.textContent);
                const pageProps = data?.props?.pageProps;

                const videoData = pageProps?.story?.videoAttachments ||
                    pageProps?.video ||
                    pageProps?.article?.video;

                if (Array.isArray(videoData)) {
                    for (const video of videoData) {
                        if (video.url || video.secureUrl) {
                            videos.push({
                                url: video.secureUrl || video.url,
                                type: 'hls',
                                quality: 'auto',
                                title: video.title || document.title
                            });
                        }
                    }
                } else if (videoData?.url) {
                    videos.push({
                        url: videoData.secureUrl || videoData.url,
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

    function extractAll() {
        const allVideos = [
            ...extractFromBloombergPlayer(),
            ...extractFromNextData(),
            ...extractFromLDJson(),
            ...extractFromVideoElements(),
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

    log('Bloomberg specialist initialized');
})();
