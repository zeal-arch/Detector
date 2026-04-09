(function () {
    const SITE_ID = 'zdf';

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

            const embedMatch = content.match(/embedCode\s*[=:]\s*['"]([^'"]+)['"]/);
            if (embedMatch) {
                try {
                    const decoded = decodeURIComponent(embedMatch[1]);
                    const urlMatch = decoded.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/);
                    if (urlMatch) {
                        videos.push({
                            url: urlMatch[0],
                            type: 'hls',
                            quality: 'auto',
                            title: document.title
                        });
                    }
                } catch {  }
            }

            const contentMatch = content.match(/"content"\s*:\s*\{[^}]*"url"\s*:\s*"([^"]+)"/);
            if (contentMatch) {
                videos.push({
                    url: contentMatch[1],
                    type: contentMatch[1].includes('.m3u8') ? 'hls' : 'mp4',
                    quality: 'auto',
                    title: document.title
                });
            }
        }

        return videos;
    }

    function extractFromZdfApi() {
        const videos = [];

        const playerElements = document.querySelectorAll('[data-zdfplayer-id], .zdf-player, [class*="video-player"]');
        for (const el of playerElements) {
            const dataId = el.getAttribute('data-zdfplayer-id') || el.getAttribute('data-video-id');
            if (dataId) {

                videos.push({
                    videoId: dataId,
                    type: 'pending',
                    title: document.title
                });
            }
        }

        const scripts = document.querySelectorAll('script[type="application/json"]');
        for (const script of scripts) {
            try {
                const data = JSON.parse(script.textContent);
                if (data.mainVideoContent?.http?.url) {
                    videos.push({
                        url: data.mainVideoContent.http.url,
                        type: data.mainVideoContent.http.url.includes('.m3u8') ? 'hls' : 'mp4',
                        quality: 'auto',
                        title: data.title || document.title
                    });
                }

                if (data.streams) {
                    for (const stream of data.streams) {
                        videos.push({
                            url: stream.url,
                            type: stream.type || 'hls',
                            quality: stream.quality || 'auto',
                            title: document.title
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
                                thumbnail: item.thumbnailUrl,
                                duration: item.duration
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
            ...extractFromPlayerConfig(),
            ...extractFromZdfApi(),
            ...extractFromLDJson(),
            ...extractFromMetaTags()
        ].filter(v => v.url);

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

    log('ZDF specialist initialized');
})();
