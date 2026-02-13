(function () {
    const SITE_ID = 'abematv';

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

        const nextData = document.querySelector('script#__NEXT_DATA__');
        if (nextData) {
            try {
                const data = JSON.parse(nextData.textContent);
                const program = data?.props?.pageProps?.program;
                if (program) {
                    videos.push({
                        programId: program.id,
                        type: 'abema',
                        quality: 'auto',
                        title: program.title || document.title
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
            const key = v.url || v.programId;
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
    log('AbemaTV specialist initialized');
})();
