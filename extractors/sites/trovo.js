(function () {
    const SITE_ID = 'trovo';

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

    function extractFromTrovoData() {
        const videos = [];
        const scripts = document.querySelectorAll('script');

        for (const script of scripts) {
            const content = script.textContent || '';

            const streamMatch = content.match(/streamInfo\s*[=:]\s*(\{[\s\S]*?\})\s*[,;]/);
            if (streamMatch) {
                try {
                    const stream = JSON.parse(streamMatch[1]);
                    if (stream.playUrl) {
                        videos.push({
                            url: stream.playUrl,
                            type: stream.playUrl.includes('.m3u8') ? 'hls' : 'flv',
                            quality: stream.quality || 'auto',
                            title: stream.title || document.title,
                            isLive: true
                        });
                    }
                } catch {  }
            }

            const vodMatch = content.match(/vodInfo\s*[=:]\s*(\{[\s\S]*?\})\s*[,;]/);
            if (vodMatch) {
                try {
                    const vod = JSON.parse(vodMatch[1]);
                    if (vod.playbackUrl || vod.url) {
                        videos.push({
                            url: vod.playbackUrl || vod.url,
                            type: 'hls',
                            quality: 'auto',
                            title: vod.title || document.title,
                            isLive: false
                        });
                    }
                } catch {  }
            }

            const playerMatch = content.match(/"playUrl"\s*:\s*"([^"]+)"/);
            if (playerMatch) {
                const url = playerMatch[1].replace(/\\u002F/g, '/');
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

    function extractFromNextData() {
        const videos = [];
        const nextData = document.querySelector('script#__NEXT_DATA__');

        if (nextData) {
            try {
                const data = JSON.parse(nextData.textContent);
                const pageProps = data?.props?.pageProps;

                if (pageProps?.liveInfo?.playUrl) {
                    videos.push({
                        url: pageProps.liveInfo.playUrl,
                        type: 'hls',
                        quality: 'auto',
                        title: pageProps.liveInfo.title || document.title,
                        isLive: true
                    });
                }

                if (pageProps?.vodInfo?.url) {
                    videos.push({
                        url: pageProps.vodInfo.url,
                        type: 'hls',
                        quality: 'auto',
                        title: pageProps.vodInfo.title || document.title,
                        isLive: false
                    });
                }

                if (pageProps?.clipInfo?.playbackUrl) {
                    videos.push({
                        url: pageProps.clipInfo.playbackUrl,
                        type: 'mp4',
                        quality: 'auto',
                        title: pageProps.clipInfo.title || document.title
                    });
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
            ...extractFromTrovoData(),
            ...extractFromNextData(),
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

    log('Trovo specialist initialized');
})();
