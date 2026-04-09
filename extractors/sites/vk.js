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

        let match = url.match(/video(-?\d+_\d+)/);
        if (match) return match[1];

        match = url.match(/playlist\/[^/]+\/video(-?\d+_\d+)/);
        if (match) return match[1];

        match = url.match(/vkvideo\.ru\/video\/(-?\d+_\d+)/);
        if (match) return match[1];

        const urlObj = new URL(url);
        const zParam = urlObj.searchParams.get('z');
        if (zParam) {
            match = zParam.match(/video(-?\d+_\d+)/);
            if (match) return match[1];
        }

        return null;
    }

    function decodeUnicode(str) {
        if (!str) return str;
        return str.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
            String.fromCharCode(parseInt(hex, 16))
        );
    }

    function parseVKResponse(text) {
        const result = {
            hls: null,
            dash: null,
            title: null,
            thumbnail: null,
            duration: null
        };

        const hlsMatch = text.match(/"hls":"([^"]+)"/);
        if (hlsMatch) {
            result.hls = hlsMatch[1].replace(/\\/g, '');
        }

        const dashMatch = text.match(/"dash_sep":"([^"]+)"/) ||
            text.match(/"dash_webm":"([^"]+)"/);
        if (dashMatch) {
            result.dash = dashMatch[1].replace(/\\/g, '');
        }

        const titleMatch = text.match(/"title":"((?:[^"\\]|\\.)*)"/);
        if (titleMatch) {
            result.title = decodeUnicode(titleMatch[1]);
        }

        const thumbMatch = text.match(/"thumb":"([^"]+)"/);
        if (thumbMatch) {
            result.thumbnail = thumbMatch[1].replace(/\\/g, '');
        }

        const durationMatch = text.match(/"duration":(\d+)/);
        if (durationMatch) {
            const seconds = parseInt(durationMatch[1]);
            const mins = Math.floor(seconds / 60);
            const secs = seconds % 60;
            result.duration = `${mins}:${String(secs).padStart(2, '0')}`;
        }

        return result;
    }

    async function fetchVKVideoData(videoId) {
        try {
            const response = await fetch('/al_video.php?act=show', {
                method: 'POST',
                headers: {
                    'X-Requested-With': 'XMLHttpRequest',
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: new URLSearchParams({
                    al: '1',
                    video: videoId
                }),
                credentials: 'include'
            });

            if (!response.ok) {
                console.debug('[VK Specialist] API request failed:', response.status);
                return null;
            }

            return await response.text();
        } catch (err) {
            console.debug('[VK Specialist] API request error:', err);
            return null;
        }
    }

    function findEmbeddedVideoData() {

        if (window.videoPlayer && window.videoPlayer.vars) {
            return window.videoPlayer.vars;
        }

        if (window.vkVideoPlayer) {
            return window.vkVideoPlayer;
        }

        const scripts = document.querySelectorAll('script');
        for (const script of scripts) {
            const text = script.textContent || '';
            if (text.includes('"hls":') || text.includes('"playerParams"')) {
                return parseVKResponse(text);
            }
        }

        return null;
    }

    async function extractVKMetadata() {
        const url = location.href;
        const videoId = extractVideoId(url);

        if (!videoId) return;
        if (videoId === lastProcessedVideoId) return;

        console.log('[VK Specialist] Processing video:', videoId);

        let videoData = findEmbeddedVideoData();

        if (!videoData || (!videoData.hls && !videoData.dash)) {
            const apiResponse = await fetchVKVideoData(videoId);
            if (apiResponse) {
                videoData = parseVKResponse(apiResponse);
            }
        }

        if (!videoData) {
            console.debug('[VK Specialist] No video data found');
            return;
        }

        const options = {
            customTitle: videoData.title || document.title.split(' | ')[0].trim(),
            thumbnail: videoData.thumbnail,
            duration: videoData.duration,
            stableId: `vk_${videoId}`
        };

        if (videoData.hls) {
            const hash = hashString(videoData.hls);
            if (!processedHashes.has(hash)) {
                processedHashes.add(hash);
                notifyBackground({
                    url: videoData.hls,
                    type: 'HLS',
                    options
                });
            }
        }

        if (videoData.dash) {
            const hash = hashString(videoData.dash);
            if (!processedHashes.has(hash)) {
                processedHashes.add(hash);
                notifyBackground({
                    url: videoData.dash,
                    type: 'DASH',
                    options
                });
            }
        }

        lastProcessedVideoId = videoId;
    }

    extractVKMetadata();
    setTimeout(extractVKMetadata, 500);
    setTimeout(extractVKMetadata, 1000);
    setTimeout(extractVKMetadata, 2000);

    window.addEventListener('popstate', () => {
        lastProcessedVideoId = null;
        extractVKMetadata();
        setTimeout(extractVKMetadata, 500);
    });

    let lastUrl = location.href;
    setInterval(() => {
        if (location.href !== lastUrl) {
            lastUrl = location.href;
            lastProcessedVideoId = null;
            extractVKMetadata();
        }
    }, 300);

    let debounceTimer = null;
    const observer = new MutationObserver(() => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            if (extractVideoId(location.href)) {
                extractVKMetadata();
            }
        }, 300);
    });

    observer.observe(document.documentElement, { childList: true, subtree: true });

})();
