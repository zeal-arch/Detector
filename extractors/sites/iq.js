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
    const PLAY_URL_PATTERN = /\/play\//;

    function extractM3u8FromConfig(dashConfig) {
        if (!dashConfig) return null;

        const programs = dashConfig.data?.program?.video;
        if (!programs || !Array.isArray(programs)) return null;

        for (const program of programs) {
            if (program.m3u8) {
                return program.m3u8;
            }
        }

        return null;
    }

    function findPlayerConfig() {

        if (window.__INITIAL_STATE__) {
            const state = window.__INITIAL_STATE__;
            if (state.player?.videoInfo) {
                return state.player.videoInfo;
            }
            if (state.__dash) {
                return { __dash: state.__dash };
            }
        }

        if (window.Q?.PageInfo?.videoInfo) {
            return window.Q.PageInfo.videoInfo;
        }

        if (window.iqPlayer?.config) {
            return window.iqPlayer.config;
        }

        const scripts = document.querySelectorAll('script');
        for (const script of scripts) {
            const text = script.textContent || '';

            if (text.includes('__INITIAL_STATE__')) {
                const match = text.match(/__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});?\s*(?:window\.|<\/script>|$)/);
                if (match) {
                    try {
                        return JSON.parse(match[1]);
                    } catch {

                    }
                }
            }

            if (text.includes('__dash') || text.includes('m3u8')) {
                const m3u8Match = text.match(/"m3u8":\s*"([^"]+)"/);
                if (m3u8Match) {
                    return { m3u8: m3u8Match[1] };
                }
            }
        }

        return null;
    }

    function processConfig(config) {
        if (!config) return false;

        let m3u8Url = null;

        if (config.m3u8) {
            m3u8Url = config.m3u8;
        }

        else if (config.__dash) {
            m3u8Url = extractM3u8FromConfig(config.__dash);
        }

        else if (config.playUrl) {
            const playUrl = config.playUrl;
            if (playUrl.includes('.m3u8') || playUrl.includes('.mpd')) {
                m3u8Url = playUrl;
            }
        }

        else if (config.url) {
            m3u8Url = config.url;
        }

        if (!m3u8Url) return false;

        const hash = hashString(m3u8Url);
        if (processedHashes.has(hash)) return true;
        processedHashes.add(hash);

        let type = 'HLS';
        if (m3u8Url.includes('.mpd')) {
            type = 'DASH';
        } else if (m3u8Url.includes('.mp4')) {
            type = 'MP4';
        }

        const options = {
            customTitle: document.title.split('_')[0].split('|')[0].trim() || 'iQ Video',
            thumbnail: document.querySelector('meta[property="og:image"]')?.content,
            stableId: `iq_${hash}`
        };

        if (!m3u8Url.startsWith('http')) {

            const dataUrl = `data:text/plain;charset=UTF-8,${encodeURIComponent(m3u8Url)}`;
            notifyBackground({
                url: dataUrl,
                type: type,
                options
            });
        } else {
            notifyBackground({
                url: m3u8Url,
                type: type,
                options
            });
        }

        console.log('[iQ Specialist] Found video:', m3u8Url.substring(0, 60) + '...');
        return true;
    }

    async function extractIQMetadata(retryCount = 0) {

        if (!PLAY_URL_PATTERN.test(window.location.href)) {
            return;
        }

        console.log('[iQ Specialist] Processing play page, attempt:', retryCount + 1);

        const config = findPlayerConfig();
        if (processConfig(config)) {
            return;
        }

        if (retryCount < 5) {
            const delay = 1000 * (retryCount + 1);
            setTimeout(() => extractIQMetadata(retryCount + 1), delay);
        }
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
                        notifyBackground({
                            url: url,
                            type: type,
                            options: {
                                customTitle: document.title.split('_')[0].trim() || 'iQ Video',
                                stableId: `iq_${hash}`
                            }
                        });
                    }
                }
            }

            return originalFetch.apply(this, args);
        };
    }

    interceptNetworkRequests();

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            setTimeout(() => extractIQMetadata(), 500);
        });
    } else {
        extractIQMetadata();
    }

    window.addEventListener('popstate', () => {
        setTimeout(() => extractIQMetadata(), 500);
    });

    let lastUrl = location.href;
    setInterval(() => {
        if (location.href !== lastUrl) {
            lastUrl = location.href;
            processedHashes.clear();
            setTimeout(() => extractIQMetadata(), 500);
        }
    }, 500);

    let debounceTimer = null;
    const observer = new MutationObserver(() => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            if (PLAY_URL_PATTERN.test(location.href)) {
                extractIQMetadata();
            }
        }, 300);
    });

    observer.observe(document.documentElement, { childList: true, subtree: true });

})();
