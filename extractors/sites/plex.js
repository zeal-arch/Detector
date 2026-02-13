(function () {
    const SITE_ID = 'plex';

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

            const transcodeMatch = content.match(/\/transcode\/sessions\/[^"'\s]+/gi);
            if (transcodeMatch) {
                for (const match of transcodeMatch) {
                    videos.push({
                        url: match,
                        type: 'hls',
                        quality: 'auto',
                        title: document.title
                    });
                }
            }

            const mediaMatch = content.match(/"(?:key|file)"\s*:\s*"([^"]+\.(mkv|mp4|avi|mov)[^"]*)"/gi);
            if (mediaMatch) {
                for (const match of mediaMatch) {
                    const urlMatch = match.match(/"([^"]+\.(mkv|mp4|avi|mov)[^"]*)"/);
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
    log('Plex specialist initialized');
})();
