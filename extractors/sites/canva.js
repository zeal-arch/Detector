(function () {
    'use strict';

    function notifyBackground(videoData) {
        window.postMessage({
            type: 'MAGIC_M3U8_DETECTION',
            source: 'SITE_SPECIALIST',
            data: videoData
        }, '*');
    }

    function hashString(str, seed = 0) {
        let h1 = 3735928559 ^ seed, h2 = 1103547991 ^ seed;
        for (let i = 0, ch; i < str.length; i++) {
            ch = str.charCodeAt(i);
            h1 = Math.imul(h1 ^ ch, 2654435761);
            h2 = Math.imul(h2 ^ ch, 1597334677);
        }
        h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
        h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
        h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
        h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
        return 4294967296 * (2097151 & h2) + (h1 >>> 0);
    }

    const processedHashes = new Set();
    const WATCH_URL_PATTERN = /canva\.com\/.*\/watch/;
    const HLS_MANIFEST_PATTERN = /['"]hlsManifestUrl['"]\s*:\s*['"]([^'"]+)['"]/;

    function findConfigScripts() {
        const scripts = document.querySelectorAll('script[nonce]');
        const result = [];

        for (const script of scripts) {

            const attrs = script.attributes;
            if (attrs.length === 1 && attrs[0]?.name === 'nonce') {
                result.push(script);
            }
        }

        return result;
    }

    function extractHlsUrl(scriptContent) {
        const match = scriptContent.match(HLS_MANIFEST_PATTERN);
        if (match && match[1]) {

            return match[1].replace(/\\u002F/g, '/').replace(/\\\//g, '/');
        }
        return null;
    }

    async function processHlsManifest(hlsUrl) {
        try {
            const response = await fetch(hlsUrl, {
                signal: AbortSignal.timeout(10000)
            });

            if (!response.ok) {
                console.debug('[Canva Specialist] HLS fetch failed:', response.status);
                return;
            }

            const hash = hashString(hlsUrl);
            if (processedHashes.has(hash)) return;
            processedHashes.add(hash);

            const options = {
                customTitle: document.title.split(' - ')[0].trim() || 'Canva Video',
                stableId: `canva_${hash}`,
                thumbnail: document.querySelector('meta[property="og:image"]')?.content
            };

            notifyBackground({
                url: hlsUrl,
                type: 'HLS',
                options
            });

            console.log('[Canva Specialist] Found HLS manifest:', hlsUrl.substring(0, 60) + '...');

        } catch (err) {
            console.debug('[Canva Specialist] Error processing manifest:', err);
        }
    }

    async function extractCanvaWatchVideo() {

        if (!WATCH_URL_PATTERN.test(window.location.href)) {
            return;
        }

        console.log('[Canva Specialist] Processing watch page');

        const scripts = findConfigScripts();

        for (const script of scripts) {
            const content = script.innerHTML || script.textContent || '';
            const hlsUrl = extractHlsUrl(content);

            if (hlsUrl) {
                try {
                    const url = new URL(hlsUrl);
                    await processHlsManifest(url.href);
                    return;
                } catch (err) {
                    console.debug('[Canva Specialist] Invalid HLS URL:', err);
                }
            }
        }

        console.debug('[Canva Specialist] No HLS URL found in scripts');
    }

    function interceptNetworkRequests() {

        const originalFetch = window.fetch;
        window.fetch = function (...args) {
            const url = args[0];

            if (typeof url === 'string') {

                if (url.includes('.m3u8') || url.includes('.mpd')) {
                    const hash = hashString(url);
                    if (!processedHashes.has(hash)) {
                        processedHashes.add(hash);

                        const type = url.includes('.mpd') ? 'DASH' : 'HLS';
                        const options = {
                            customTitle: document.title.split(' - ')[0].trim() || 'Canva Video',
                            stableId: `canva_${hash}`
                        };

                        notifyBackground({
                            url: url,
                            type: type,
                            options
                        });
                    }
                }
            }

            return originalFetch.apply(this, args);
        };

        const originalXhrOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function (method, url, ...rest) {
            if (typeof url === 'string') {
                if (url.includes('.m3u8') || url.includes('.mpd')) {
                    const hash = hashString(url);
                    if (!processedHashes.has(hash)) {
                        processedHashes.add(hash);

                        const type = url.includes('.mpd') ? 'DASH' : 'HLS';
                        const options = {
                            customTitle: document.title.split(' - ')[0].trim() || 'Canva Video',
                            stableId: `canva_${hash}`
                        };

                        notifyBackground({
                            url: url,
                            type: type,
                            options
                        });
                    }
                }
            }

            return originalXhrOpen.call(this, method, url, ...rest);
        };
    }

    function watchForVideoElements() {
        const observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType !== 1) continue;

                    const videos = node.tagName === 'VIDEO'
                        ? [node]
                        : node.querySelectorAll?.('video') || [];

                    for (const video of videos) {
                        const src = video.src || video.querySelector('source')?.src;
                        if (src && (src.includes('.m3u8') || src.includes('.mpd'))) {
                            const hash = hashString(src);
                            if (!processedHashes.has(hash)) {
                                processedHashes.add(hash);

                                const type = src.includes('.mpd') ? 'DASH' : 'HLS';
                                notifyBackground({
                                    url: src,
                                    type: type,
                                    options: {
                                        customTitle: document.title.split(' - ')[0].trim() || 'Canva Video',
                                        stableId: `canva_${hash}`
                                    }
                                });
                            }
                        }
                    }
                }
            }
        });

        observer.observe(document.body || document.documentElement, {
            childList: true,
            subtree: true
        });
    }

    interceptNetworkRequests();

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            extractCanvaWatchVideo();
            watchForVideoElements();
        });
    } else {
        extractCanvaWatchVideo();
        watchForVideoElements();
    }

    setTimeout(extractCanvaWatchVideo, 500);
    setTimeout(extractCanvaWatchVideo, 1000);
    setTimeout(extractCanvaWatchVideo, 2000);

    let lastUrl = location.href;
    setInterval(() => {
        if (location.href !== lastUrl) {
            lastUrl = location.href;
            setTimeout(extractCanvaWatchVideo, 500);
        }
    }, 500);

})();
