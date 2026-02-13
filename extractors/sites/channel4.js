(function () {
    const SITE_ID = 'channel4';

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

    function extractFromPage() {
        const videos = [];

        const scripts = document.querySelectorAll('script');
        for (const script of scripts) {
            const content = script.textContent || '';

            const streamMatch = content.match(/"streamUrl"\s*:\s*"([^"]+)"/);
            if (streamMatch) {
                videos.push({
                    url: streamMatch[1],
                    type: 'hls',
                    quality: 'auto',
                    title: document.title
                });
            }

            const hlsMatch = content.match(/["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/g);
            if (hlsMatch) {
                for (const match of hlsMatch) {
                    videos.push({
                        url: match.slice(1, -1),
                        type: 'hls',
                        quality: 'auto',
                        title: document.title
                    });
                }
            }
        }

        const ldJson = document.querySelectorAll('script[type="application/ld+json"]');
        for (const script of ldJson) {
            try {
                const data = JSON.parse(script.textContent);
                const items = Array.isArray(data) ? data : [data];
                for (const item of items) {
                    if (item['@type'] === 'VideoObject' && item.contentUrl) {
                        videos.push({
                            url: item.contentUrl,
                            type: 'hls',
                            quality: 'auto',
                            title: item.name || document.title
                        });
                    }
                }
            } catch {  }
        }

        return videos;
    }

    function extractAll() {
        const allVideos = [...extractFromPage()];

        const seen = new Set();
        const unique = allVideos.filter(v => {
            if (seen.has(v.url)) return false;
            seen.add(v.url);
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

    const observer = new MutationObserver(() => setTimeout(extractAll, 1000));
    observer.observe(document.body || document.documentElement, { childList: true, subtree: true });

    setInterval(extractAll, 5000);
    log('Channel 4 specialist initialized');
})();
