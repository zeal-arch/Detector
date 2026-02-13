(function () {
    const SITE_ID = 'cda';

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

    function extractFromCdaPlayer() {
        const videos = [];
        const scripts = document.querySelectorAll('script');

        for (const script of scripts) {
            const content = script.textContent || '';

            const playerMatch = content.match(/player_data\s*[=:]\s*(\{[\s\S]*?\});/);
            if (playerMatch) {
                try {
                    const config = JSON.parse(playerMatch[1]);
                    if (config.video?.file) {
                        videos.push({
                            url: config.video.file,
                            type: config.video.file.includes('.m3u8') ? 'hls' : 'mp4',
                            quality: config.video.quality || 'auto',
                            title: config.video.title || document.title
                        });
                    }
                    if (config.video?.qualities) {
                        for (const [quality, url] of Object.entries(config.video.qualities)) {
                            videos.push({
                                url,
                                type: url.includes('.m3u8') ? 'hls' : 'mp4',
                                quality,
                                title: config.video.title || document.title
                            });
                        }
                    }
                } catch {  }
            }

            const urlMatch = content.match(/["'](https?:\/\/[^"']+\.cda\.pl\/[^"']+\.(?:mp4|m3u8)[^"']*)["']/g);
            if (urlMatch) {
                for (const match of urlMatch) {
                    const url = match.slice(1, -1);
                    videos.push({
                        url,
                        type: url.includes('.m3u8') ? 'hls' : 'mp4',
                        quality: 'auto',
                        title: document.title
                    });
                }
            }

            const encodedMatch = content.match(/file\s*:\s*['"]([a-zA-Z0-9+/=]+)['"]/);
            if (encodedMatch) {
                try {
                    const decoded = atob(encodedMatch[1]);
                    if (decoded.includes('http')) {
                        videos.push({
                            url: decoded,
                            type: decoded.includes('.m3u8') ? 'hls' : 'mp4',
                            quality: 'auto',
                            title: document.title
                        });
                    }
                } catch {  }
            }
        }

        return videos;
    }

    function extractFromDataAttributes() {
        const videos = [];

        const playerElements = document.querySelectorAll('[data-video], [class*="player"]');
        for (const el of playerElements) {
            const videoData = el.getAttribute('data-video');
            if (videoData) {
                try {
                    const data = JSON.parse(videoData);
                    if (data.file) {
                        videos.push({
                            url: data.file,
                            type: data.file.includes('.m3u8') ? 'hls' : 'mp4',
                            quality: data.quality || 'auto',
                            title: data.title || document.title
                        });
                    }
                } catch {  }
            }
        }

        const videoElements = document.querySelectorAll('video source, video');
        for (const el of videoElements) {
            const src = el.src || el.getAttribute('data-src');
            if (src && src.includes('cda.pl')) {
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
                    if (item['@type'] === 'VideoObject') {
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
            ...extractFromCdaPlayer(),
            ...extractFromDataAttributes(),
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

    log('CDA specialist initialized');
})();
