(function () {
    'use strict';
    console.log('[Bandcamp Specialist] Loaded on:', window.location.href);
    const processedVideos = new Set();

    function notifyBackground(videoData) {
        const hash = `${videoData.url}_${videoData.title}`.replace(/[^a-zA-Z0-9]/g, '');
        if (processedVideos.has(hash)) return;
        processedVideos.add(hash);

        window.postMessage({
            type: 'MAGIC_M3U8_DETECTION',
            source: 'SITE_SPECIALIST',
            data: {
                url: videoData.url,
                type: videoData.type || 'MP3',
                options: {
                    customTitle: videoData.title,
                    thumbnail: videoData.thumbnail,
                    author: videoData.author,
                    pageUrl: window.location.href,
                    platform: 'bandcamp',
                    isAudio: true
                }
            }
        }, '*');
        window.__SPECIALIST_DETECTED = true;
    }

    function extractVideo() {
        try {

            const tralbumData = document.querySelector('[data-tralbum]');
            if (tralbumData) {
                try {
                    const data = JSON.parse(tralbumData.dataset.tralbum);
                    if (data.trackinfo && data.trackinfo.length > 0) {
                        const track = data.trackinfo[0];
                        if (track.file && track.file['mp3-128']) {
                            const artist = data.artist || document.querySelector('[itemprop="byArtist"] a')?.textContent;
                            const thumbnail = document.querySelector('[rel="image_src"]')?.href ||
                                document.querySelector('.popupImage img')?.src;

                            notifyBackground({
                                url: track.file['mp3-128'],
                                title: track.title || data.current?.title,
                                author: artist,
                                thumbnail: thumbnail,
                                type: 'MP3'
                            });
                            return;
                        }
                    }
                } catch (e) {
                    console.debug('[Bandcamp] Failed to parse track info:', e);
                }
            }

            const html = document.documentElement.outerHTML;
            const mp3Match = html.match(/(https?:\/\/[^"'\s]*\.mp3[^"'\s]*)/);
            if (mp3Match) {
                notifyBackground({
                    url: mp3Match[1],
                    title: document.title,
                    type: 'MP3'
                });
            }

        } catch (err) {
            console.error('[Bandcamp] Extraction error:', err);
        }
    }

    setTimeout(extractVideo, 1500);

})();
