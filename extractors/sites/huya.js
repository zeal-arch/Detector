(function () {
    const SITE_ID = 'huya';

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

    function extractFromHuyaPlayer() {
        const videos = [];
        const scripts = document.querySelectorAll('script');

        for (const script of scripts) {
            const content = script.textContent || '';

            const streamMatch = content.match(/stream\s*:\s*(\{[\s\S]*?\})\s*[,}]/);
            if (streamMatch) {
                try {
                    const stream = JSON.parse(streamMatch[1]);
                    if (stream.sFlvUrl || stream.sHlsUrl) {
                        const flvUrl = stream.sFlvUrl;
                        const hlsUrl = stream.sHlsUrl;

                        if (flvUrl) {
                            videos.push({
                                url: flvUrl,
                                type: 'flv',
                                quality: 'auto',
                                title: stream.sIntroduction || document.title,
                                isLive: true
                            });
                        }
                        if (hlsUrl) {
                            videos.push({
                                url: hlsUrl,
                                type: 'hls',
                                quality: 'auto',
                                title: stream.sIntroduction || document.title,
                                isLive: true
                            });
                        }
                    }
                } catch {  }
            }

            const gameMatch = content.match(/hyPlayerConfig\s*[=:]\s*(\{[\s\S]*?\});/);
            if (gameMatch) {
                try {
                    const config = JSON.parse(gameMatch[1]);
                    const streams = config.stream || config.data?.stream;
                    if (streams) {
                        for (const stream of (Array.isArray(streams) ? streams : [streams])) {
                            if (stream.sFlvUrl) {
                                videos.push({
                                    url: stream.sFlvUrl,
                                    type: 'flv',
                                    quality: stream.sCdnType || 'auto',
                                    title: document.title,
                                    isLive: true
                                });
                            }
                            if (stream.sHlsUrl) {
                                videos.push({
                                    url: stream.sHlsUrl,
                                    type: 'hls',
                                    quality: stream.sCdnType || 'auto',
                                    title: document.title,
                                    isLive: true
                                });
                            }
                        }
                    }
                } catch {  }
            }

            const vodMatch = content.match(/"videoPlayUrl"\s*:\s*"([^"]+)"/);
            if (vodMatch) {
                videos.push({
                    url: vodMatch[1].replace(/\\u002F/g, '/'),
                    type: vodMatch[1].includes('.m3u8') ? 'hls' : 'mp4',
                    quality: 'auto',
                    title: document.title,
                    isLive: false
                });
            }
        }

        return videos;
    }

    function extractFromRoomInfo() {
        const videos = [];

        if (window.TT_ROOM_DATA || window.hyPlayerConfig) {
            const roomData = window.TT_ROOM_DATA || window.hyPlayerConfig;

            if (roomData.stream?.sFlvUrl) {
                videos.push({
                    url: roomData.stream.sFlvUrl,
                    type: 'flv',
                    quality: 'auto',
                    title: roomData.introduction || document.title,
                    isLive: true
                });
            }

            if (roomData.stream?.sHlsUrl) {
                videos.push({
                    url: roomData.stream.sHlsUrl,
                    type: 'hls',
                    quality: 'auto',
                    title: roomData.introduction || document.title,
                    isLive: true
                });
            }
        }

        return videos;
    }

    function extractFromVideoElements() {
        const videos = [];
        const videoElements = document.querySelectorAll('video');

        for (const video of videoElements) {
            const src = video.src || video.currentSrc;
            if (src && !src.startsWith('blob:')) {
                videos.push({
                    url: src,
                    type: src.includes('.m3u8') ? 'hls' : (src.includes('.flv') ? 'flv' : 'mp4'),
                    quality: 'auto',
                    title: document.title
                });
            }
        }

        return videos;
    }

    function extractFromMetaTags() {
        const videos = [];

        const ogVideo = document.querySelector('meta[property="og:video"]');
        if (ogVideo?.content) {
            videos.push({
                url: ogVideo.content,
                type: ogVideo.content.includes('.m3u8') ? 'hls' : 'mp4',
                quality: 'auto',
                title: document.querySelector('meta[property="og:title"]')?.content || document.title
            });
        }

        return videos;
    }

    function extractAll() {
        const allVideos = [
            ...extractFromHuyaPlayer(),
            ...extractFromRoomInfo(),
            ...extractFromVideoElements(),
            ...extractFromMetaTags()
        ];

        const seen = new Set();
        const unique = allVideos.filter(v => {
            const key = v.url;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

        if (unique.length > 0) {
            log(`Found ${unique.length} videos/streams`);
            sendToBackground(unique);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', extractAll);
    } else {
        extractAll();
    }

    const observer = new MutationObserver(() => {
        setTimeout(extractAll, 1000);
    });

    observer.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true
    });

    setInterval(extractAll, 5000);

    log('Huya specialist initialized');
})();
