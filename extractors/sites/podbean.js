(function () {
    const SITE_ID = 'podbean';

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

            const audioMatch = content.match(/"(?:audioUrl|mediaUrl|url)"\s*:\s*"([^"]+\.mp3[^"]*)"/gi);
            if (audioMatch) {
                for (const match of audioMatch) {
                    const urlMatch = match.match(/"([^"]+\.mp3[^"]*)"/);
                    if (urlMatch) {
                        videos.push({
                            url: urlMatch[1],
                            type: 'mp3',
                            quality: 'audio',
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
                    if (item['@type'] === 'PodcastEpisode' && item.audio?.contentUrl) {
                        videos.push({
                            url: item.audio.contentUrl,
                            type: 'mp3',
                            quality: 'audio',
                            title: item.name || document.title
                        });
                    }
                }
            } catch {  }
        }

        const audioElements = document.querySelectorAll('audio');
        for (const audio of audioElements) {
            const src = audio.src || audio.currentSrc;
            if (src && !src.startsWith('blob:')) {
                videos.push({
                    url: src,
                    type: 'mp3',
                    quality: 'audio',
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
            log(`Found ${unique.length} podcasts`);
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
    log('Podbean specialist initialized');
})();
