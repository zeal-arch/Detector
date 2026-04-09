(function () {
    const SITE_ID = 'steam';

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

        const movieElements = document.querySelectorAll('[data-webm-source], [data-mp4-source]');
        for (const el of movieElements) {
            const webm = el.getAttribute('data-webm-source');
            const mp4 = el.getAttribute('data-mp4-source');

            if (mp4) {
                videos.push({
                    url: mp4,
                    type: 'mp4',
                    quality: 'auto',
                    title: document.title
                });
            }
            if (webm) {
                videos.push({
                    url: webm,
                    type: 'webm',
                    quality: 'auto',
                    title: document.title
                });
            }
        }

        const videoElements = document.querySelectorAll('video source, video');
        for (const el of videoElements) {
            const src = el.src || el.getAttribute('data-src');
            if (src && !src.startsWith('blob:')) {
                videos.push({
                    url: src,
                    type: src.includes('.webm') ? 'webm' : 'mp4',
                    quality: 'auto',
                    title: document.title
                });
            }
        }

        const scripts = document.querySelectorAll('script');
        for (const script of scripts) {
            const content = script.textContent || '';

            const mp4Match = content.match(/["'](https?:\/\/[^"']+steamstatic[^"']+\.mp4[^"']*)["']/g);
            if (mp4Match) {
                for (const match of mp4Match) {
                    videos.push({
                        url: match.slice(1, -1),
                        type: 'mp4',
                        quality: 'auto',
                        title: document.title
                    });
                }
            }
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
    log('Steam specialist initialized');
})();
