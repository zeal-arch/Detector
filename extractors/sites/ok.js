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
    let lastProcessedVideoId = null;

    function extractVideoId(url) {

        let match = url.match(/ok\.ru\/(?:video|videoembed)\/(\d+)/);
        if (match) return match[1];

        match = url.match(/m\.ok\.ru\/(?:video|videoembed)\/(\d+)/);
        if (match) return match[1];

        return null;
    }

    function formatDuration(seconds) {
        if (!seconds || typeof seconds !== 'number') return null;
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${String(secs).padStart(2, '0')}`;
    }

    function findDataOptions() {

        const elements = document.querySelectorAll('[data-options]');

        for (const el of elements) {
            try {
                const options = el.getAttribute('data-options');
                if (!options) continue;

                const parsed = JSON.parse(options);

                if (parsed.flashvars || parsed.metadata) {
                    return parsed;
                }
            } catch {

            }
        }

        return null;
    }

    function findVideoFromScripts() {
        const scripts = document.querySelectorAll('script');
        const result = {};

        for (const script of scripts) {
            const text = script.textContent || '';

            const hlsMatch = text.match(/"(?:hlsManifestUrl|ondemandHls)":\s*"([^"]+)"/);
            if (hlsMatch) {
                result.hlsManifestUrl = hlsMatch[1].replace(/\\\//g, '/');
            }

            const dashMatch = text.match(/"(?:dashSepUrl|dashManifestUrl)":\s*"([^"]+)"/);
            if (dashMatch) {
                result.dashSepUrl = dashMatch[1].replace(/\\\//g, '/');
            }

            const mp4Match = text.match(/"(?:url|videoUrl)":\s*"([^"]+\.mp4[^"]*)"/);
            if (mp4Match) {
                result.mp4Url = mp4Match[1].replace(/\\\//g, '/');
            }

            const titleMatch = text.match(/"videoName":\s*"([^"]+)"/) ||
                text.match(/"title":\s*"([^"]+)"/);
            if (titleMatch) {
                result.title = titleMatch[1];
            }

            const durationMatch = text.match(/"videoDuration":\s*(\d+)/) ||
                text.match(/"duration":\s*(\d+)/);
            if (durationMatch) {
                result.duration = parseInt(durationMatch[1]);
            }
        }

        return Object.keys(result).length > 0 ? result : null;
    }

    async function fetchVideoEmbed(videoId) {
        try {
            const url = `https://ok.ru/videoembed/${videoId}?nochat=1`;
            const response = await fetch(url, {
                credentials: 'include',
                headers: {
                    'Accept': 'text/html'
                }
            });

            if (!response.ok) return null;

            const html = await response.text();
            const result = {};

            const hlsMatch = html.match(/["'](?:hlsManifestUrl|ondemandHls)["']:\s*["']([^"']+)["']/);
            if (hlsMatch) {
                result.hlsManifestUrl = hlsMatch[1].replace(/\\\//g, '/');
            }

            const dashMatch = html.match(/["'](?:dashSepUrl|dashManifestUrl)["']:\s*["']([^"']+)["']/);
            if (dashMatch) {
                result.dashSepUrl = dashMatch[1].replace(/\\\//g, '/');
            }

            return Object.keys(result).length > 0 ? result : null;
        } catch (err) {
            console.debug('[OK Specialist] Embed fetch error:', err);
            return null;
        }
    }

    function processVideoData(data, videoId) {
        if (!data) return false;

        const options = {
            customTitle: data.title || document.title.split(' — ')[0].trim() || 'OK Video',
            thumbnail: document.querySelector('meta[property="og:image"]')?.content,
            duration: data.duration ? formatDuration(data.duration) : null,
            stableId: `ok_${videoId}`
        };

        let foundAny = false;

        if (data.hlsManifestUrl) {
            const hash = hashString(data.hlsManifestUrl);
            if (!processedHashes.has(hash)) {
                processedHashes.add(hash);
                notifyBackground({
                    url: data.hlsManifestUrl,
                    type: 'HLS',
                    options
                });
                foundAny = true;
            }
        }

        if (data.dashSepUrl) {
            const hash = hashString(data.dashSepUrl);
            if (!processedHashes.has(hash)) {
                processedHashes.add(hash);
                notifyBackground({
                    url: data.dashSepUrl,
                    type: 'DASH',
                    options
                });
                foundAny = true;
            }
        }

        if (data.mp4Url && !foundAny) {
            const hash = hashString(data.mp4Url);
            if (!processedHashes.has(hash)) {
                processedHashes.add(hash);
                notifyBackground({
                    url: data.mp4Url,
                    type: 'MP4',
                    options
                });
                foundAny = true;
            }
        }

        return foundAny;
    }

    async function extractOKMetadata() {
        const url = location.href;
        const videoId = extractVideoId(url);

        if (!videoId) return;
        if (videoId === lastProcessedVideoId) return;

        console.log('[OK Specialist] Processing video:', videoId);

        const dataOptions = findDataOptions();
        if (dataOptions && dataOptions.flashvars) {
            const flashvars = dataOptions.flashvars;
            const data = {
                hlsManifestUrl: flashvars.hlsManifestUrl || flashvars.ondemandHls,
                dashSepUrl: flashvars.dashSepUrl,
                mp4Url: flashvars.url,
                title: flashvars.videoName,
                duration: flashvars.videoDuration
            };

            if (processVideoData(data, videoId)) {
                lastProcessedVideoId = videoId;
                return;
            }
        }

        const scriptData = findVideoFromScripts();
        if (processVideoData(scriptData, videoId)) {
            lastProcessedVideoId = videoId;
            return;
        }

        const embedData = await fetchVideoEmbed(videoId);
        if (processVideoData(embedData, videoId)) {
            lastProcessedVideoId = videoId;
        }
    }

    extractOKMetadata();
    setTimeout(extractOKMetadata, 500);
    setTimeout(extractOKMetadata, 1000);
    setTimeout(extractOKMetadata, 2000);

    window.addEventListener('popstate', () => {
        lastProcessedVideoId = null;
        extractOKMetadata();
        setTimeout(extractOKMetadata, 500);
    });

    let lastUrl = location.href;
    setInterval(() => {
        if (location.href !== lastUrl) {
            lastUrl = location.href;
            lastProcessedVideoId = null;
            extractOKMetadata();
        }
    }, 300);

    let debounceTimer = null;
    const observer = new MutationObserver(() => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            if (extractVideoId(location.href)) {
                extractOKMetadata();
            }
        }, 300);
    });

    observer.observe(document.documentElement, { childList: true, subtree: true });

})();
