(function () {
    const SITE_ID = 'telegram';

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

        const videoPlayers = document.querySelectorAll('.tgme_widget_message_video_player');
        for (const player of videoPlayers) {
            const video = player.querySelector('video');
            if (video) {
                const src = video.src || video.currentSrc;
                if (src && !src.startsWith('blob:')) {
                    videos.push({
                        url: src,
                        type: 'mp4',
                        quality: 'auto',
                        title: document.title
                    });
                }
            }
        }

        const dataVideos = document.querySelectorAll('[data-video]');
        for (const el of dataVideos) {
            const videoUrl = el.getAttribute('data-video');
            if (videoUrl) {
                videos.push({
                    url: videoUrl,
                    type: 'mp4',
                    quality: 'auto',
                    title: document.title
                });
            }
        }

        const scripts = document.querySelectorAll('script');
        for (const script of scripts) {
            const content = script.textContent || '';

            const videoMatch = content.match(/"(?:video|src|url)"\s*:\s*"([^"]+\.(mp4|webm)[^"]*)"/gi);
            if (videoMatch) {
                for (const match of videoMatch) {
                    const urlMatch = match.match(/"([^"]+\.(mp4|webm)[^"]*)"/);
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
                    type: 'mp4',
                    quality: 'auto',
                    title: document.title
                });
            }

            const sources = video.querySelectorAll('source');
            for (const source of sources) {
                if (source.src && !source.src.startsWith('blob:')) {
                    videos.push({
                        url: source.src,
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
    log('Telegram specialist initialized');
})();
