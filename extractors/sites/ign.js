(function () {
    const SITE_ID = 'ign';

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

            const m3u8Match = content.match(/["']([^"']+\.m3u8[^"']*)/gi);
            if (m3u8Match) {
                for (const match of m3u8Match) {
                    const url = match.replace(/^['"]|['"]$/g, '');
                    videos.push({
                        url: url,
                        type: 'hls',
                        quality: 'auto',
                        title: document.title
                    });
                }
            }

            const mp4Match = content.match(/"url"\s*:\s*"([^"]+\.mp4[^"]*)"/gi);
            if (mp4Match) {
                for (const match of mp4Match) {
                    const urlMatch = match.match(/"url"\s*:\s*"([^"]+)"/);
                    if (urlMatch) {
                        videos.push({
                            url: urlMatch[1],
                            type: 'mp4',
                            quality: 'auto',
                            title: document.title
                        });
                    }
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
                            type: item.contentUrl.includes('.m3u8') ? 'hls' : 'mp4',
                            quality: 'auto',
                            title: item.name || document.title
                        });
                    }
                }
            } catch {  }
        }

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
    log('IGN specialist initialized');
})();
