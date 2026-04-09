(function () {
    const SITE_ID = 'hotstar';

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

            const playbackMatch = content.match(/"playbackUrl"\s*:\s*"([^"]+)"/);
            if (playbackMatch) {
                videos.push({
                    url: playbackMatch[1],
                    type: 'hls',
                    quality: 'auto',
                    title: document.title,
                    drm: true
                });
            }

            const contentMatch = content.match(/"contentId"\s*:\s*"([^"]+)"/);
            if (contentMatch) {
                videos.push({
                    contentId: contentMatch[1],
                    type: 'drm',
                    platform: 'hotstar',
                    title: document.title
                });
            }
        }

        const nextData = document.querySelector('script#__NEXT_DATA__');
        if (nextData) {
            try {
                const data = JSON.parse(nextData.textContent);
                const content = data?.props?.pageProps?.content;
                if (content?.playbackUrl) {
                    videos.push({
                        url: content.playbackUrl,
                        type: 'hls',
                        quality: 'auto',
                        title: content.title || document.title,
                        drm: true
                    });
                }
            } catch {  }
        }

        return videos;
    }

    function extractAll() {
        const allVideos = [...extractFromPage()];

        const seen = new Set();
        const unique = allVideos.filter(v => {
            const key = v.url || v.contentId;
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

    const observer = new MutationObserver(() => setTimeout(extractAll, 1000));
    observer.observe(document.body || document.documentElement, { childList: true, subtree: true });

    setInterval(extractAll, 5000);
    log('Hotstar specialist initialized');
})();
