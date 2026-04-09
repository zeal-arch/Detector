(function () {
    const SITE_ID = 'douyin';

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

    function extractFromDouyinData() {
        const videos = [];
        const scripts = document.querySelectorAll('script');

        for (const script of scripts) {
            const content = script.textContent || '';

            const stateMatch = content.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});?\s*(?:<\/script>|$)/);
            if (stateMatch) {
                try {
                    const state = JSON.parse(stateMatch[1].replace(/undefined/g, 'null'));

                    const videoInfo = state?.videoInfo || state?.aweme?.detail;
                    if (videoInfo) {
                        const video = videoInfo.video || videoInfo;
                        if (video.playAddr || video.play_addr) {
                            const playUrl = video.playAddr?.url_list?.[0] ||
                                video.play_addr?.url_list?.[0] ||
                                video.playAddr || video.play_addr;
                            if (playUrl) {
                                videos.push({
                                    url: playUrl,
                                    type: 'mp4',
                                    quality: 'auto',
                                    title: videoInfo.desc || videoInfo.description || document.title
                                });
                            }
                        }

                        const hlsUrl = video.h264PlayAddr || video.h265PlayAddr;
                        if (hlsUrl) {
                            videos.push({
                                url: hlsUrl,
                                type: 'hls',
                                quality: 'auto',
                                title: videoInfo.desc || document.title
                            });
                        }
                    }

                    const items = state?.aweme?.items || state?.items || [];
                    for (const item of items) {
                        const itemVideo = item.video;
                        if (itemVideo?.playAddr || itemVideo?.play_addr) {
                            const playUrl = itemVideo.playAddr?.url_list?.[0] ||
                                itemVideo.play_addr?.url_list?.[0];
                            if (playUrl) {
                                videos.push({
                                    url: playUrl,
                                    type: 'mp4',
                                    quality: 'auto',
                                    title: item.desc || item.description || document.title
                                });
                            }
                        }
                    }
                } catch {  }
            }

            const renderMatch = content.match(/_ROUTER_DATA\s*=\s*(\{[\s\S]*?\});/);
            if (renderMatch) {
                try {
                    const data = JSON.parse(renderMatch[1].replace(/undefined/g, 'null'));
                    const loaderData = data?.loaderData || {};

                    for (const key of Object.keys(loaderData)) {
                        const pageData = loaderData[key];
                        if (pageData?.aweme_detail?.video) {
                            const video = pageData.aweme_detail.video;
                            const playUrl = video.play_addr?.url_list?.[0];
                            if (playUrl) {
                                videos.push({
                                    url: playUrl,
                                    type: 'mp4',
                                    quality: 'auto',
                                    title: pageData.aweme_detail.desc || document.title
                                });
                            }
                        }
                    }
                } catch {  }
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
                    type: src.includes('.m3u8') ? 'hls' : 'mp4',
                    quality: 'auto',
                    title: document.title
                });
            }

            const sources = video.querySelectorAll('source');
            for (const source of sources) {
                if (source.src && !source.src.startsWith('blob:')) {
                    videos.push({
                        url: source.src,
                        type: source.type?.includes('mpegurl') ? 'hls' : 'mp4',
                        quality: 'auto',
                        title: document.title
                    });
                }
            }
        }

        return videos;
    }

    function extractFromMetaTags() {
        const videos = [];

        const ogVideo = document.querySelector('meta[property="og:video"]');
        const ogVideoUrl = document.querySelector('meta[property="og:video:url"]');

        const videoUrl = ogVideoUrl?.content || ogVideo?.content;
        if (videoUrl && !videoUrl.startsWith('blob:')) {
            videos.push({
                url: videoUrl,
                type: videoUrl.includes('.m3u8') ? 'hls' : 'mp4',
                quality: 'auto',
                title: document.querySelector('meta[property="og:title"]')?.content || document.title
            });
        }

        return videos;
    }

    function extractAll() {
        const allVideos = [
            ...extractFromDouyinData(),
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
            log(`Found ${unique.length} videos`);
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

    setInterval(extractAll, 3000);

    log('Douyin specialist initialized');
})();
