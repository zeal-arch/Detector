(function () {
    const SITE_ID = 'tubi';

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

    function extractFromTubiData() {
        const videos = [];
        const scripts = document.querySelectorAll('script');

        for (const script of scripts) {
            const content = script.textContent || '';

            const videoMatch = content.match(/"video_resources"\s*:\s*\[([^\]]+)\]/);
            if (videoMatch) {
                try {
                    const resources = JSON.parse(`[${videoMatch[1]}]`);
                    for (const resource of resources) {
                        if (resource.manifest?.url) {
                            videos.push({
                                url: resource.manifest.url,
                                type: 'hls',
                                quality: resource.quality || 'auto',
                                title: document.title
                            });
                        }
                    }
                } catch {  }
            }

            const hlsMatch = content.match(/["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/g);
            if (hlsMatch) {
                for (const match of hlsMatch) {
                    const url = match.slice(1, -1);
                    if (url.includes('tubi') || url.includes('video')) {
                        videos.push({
                            url,
                            type: 'hls',
                            quality: 'auto',
                            title: document.title
                        });
                    }
                }
            }
        }

        return videos;
    }

    function extractAll() {
        const allVideos = [...extractFromTubiData()];

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
    log('Tubi specialist initialized');
})();
