(function () {
    const SITE_ID = 'cctv';

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

            const videoMatch = content.match(/"(?:hls_url|video_path|src)"\s*:\s*"([^"]+)"/gi);
            if (videoMatch) {
                for (const match of videoMatch) {
                    const urlMatch = match.match(/"([^"]+)"/g);
                    if (urlMatch && urlMatch[1]) {
                        const url = urlMatch[1].replace(/"/g, '');
                        if (url.includes('.m3u8') || url.includes('.mp4')) {
                            videos.push({
                                url: url,
                                type: url.includes('.m3u8') ? 'hls' : 'mp4',
                                quality: 'auto',
                                title: document.title
                            });
                        }
                    }
                }
            }

            const hlsMatch = content.match(/["']([^"']+\.m3u8[^"']*)/gi);
            if (hlsMatch) {
                for (const match of hlsMatch) {
                    const url = match.replace(/^['"]|['"]$/g, '');
                    videos.push({
                        url: url,
                        type: 'hls',
                        quality: 'auto',
                        title: document.title
                    });
                }
            }
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
    log('CCTV specialist initialized');
})();
