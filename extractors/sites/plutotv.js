(function () {
    const SITE_ID = 'plutotv';

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

    function extractFromPlutoData() {
        const videos = [];
        const scripts = document.querySelectorAll('script');

        for (const script of scripts) {
            const content = script.textContent || '';

            const stitchedMatch = content.match(/"stitched"\s*:\s*\{[^}]*"path"\s*:\s*"([^"]+)"/);
            if (stitchedMatch) {
                videos.push({
                    url: stitchedMatch[1],
                    type: 'hls',
                    quality: 'auto',
                    title: document.title
                });
            }

            const mediaMatch = content.match(/"mediaUrl"\s*:\s*"([^"]+)"/g);
            if (mediaMatch) {
                for (const match of mediaMatch) {
                    const urlMatch = match.match(/"([^"]+)"$/);
                    if (urlMatch) {
                        videos.push({
                            url: urlMatch[1],
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
        const allVideos = [...extractFromPlutoData()];

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
    log('PlutoTV specialist initialized');
})();
