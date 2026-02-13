(function () {
    'use strict';

    console.log('[Flixtor] Specialist loaded');

    window.__SPECIALIST_DETECTED = true;
    window.__FLIXTOR_SPECIALIST_ACTIVE = true;

    const processedUrls = new Set();
    let detectionTimeout = null;

    function notifyVideo(videoData) {
        const urlHash = videoData.url.substring(0, 100);
        if (processedUrls.has(urlHash)) return;
        processedUrls.add(urlHash);

        window.postMessage({
            type: 'MAGIC_M3U8_DETECTION',
            source: 'SITE_SPECIALIST',
            data: {
                url: videoData.url,
                type: videoData.type || 'HLS',
                options: {
                    customTitle: videoData.title || document.title,
                    thumbnail: videoData.thumbnail,
                    quality: videoData.quality,
                    pageUrl: window.location.href,
                    detectionSource: 'flixtor-specialist'
                }
            }
        }, '*');

        window.__SPECIALIST_DETECTED = true;
        console.log('[Flixtor] Video detected:', videoData.url);
    }

    const originalXHROpen = XMLHttpRequest.prototype.open;
    const originalXHRSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url, ...args) {
        this._requestUrl = url;
        return originalXHROpen.call(this, method, url, ...args);
    };

    XMLHttpRequest.prototype.send = function (body) {
        this.addEventListener('load', function () {
            try {
                const _url = this._requestUrl || '';
                const response = this.responseText;

                if (response && typeof response === 'string') {

                    const m3u8Match = response.match(/(https?:\/\/[^"'\s<>]+\.m3u8(?:\?[^"'\s<>]*)?)/i);
                    if (m3u8Match) {
                        notifyVideo({
                            url: m3u8Match[1],
                            type: 'HLS',
                            title: document.title.replace(/\s*-\s*Flixtor.*$/i, '').trim()
                        });
                    }

                    if (response.startsWith('{') || response.startsWith('[')) {
                        try {
                            const json = JSON.parse(response);
                            const findM3u8 = (obj, depth = 0) => {
                                if (depth > 5) return null;
                                if (typeof obj === 'string' && obj.includes('.m3u8')) return obj;
                                if (typeof obj === 'object' && obj !== null) {
                                    for (const value of Object.values(obj)) {
                                        const found = findM3u8(value, depth + 1);
                                        if (found) return found;
                                    }
                                }
                                return null;
                            };
                            const m3u8Url = findM3u8(json);
                            if (m3u8Url) {
                                notifyVideo({
                                    url: m3u8Url,
                                    type: 'HLS',
                                    title: document.title.replace(/\s*-\s*Flixtor.*$/i, '').trim()
                                });
                            }
                        } catch (e) {
                            console.debug('[Flixtor] Failed to parse XHR response:', e);
                        }
                    }
                }
            } catch (e) {
                console.warn('[Flixtor] XHR intercept error:', e);
            }
        });
        return originalXHRSend.call(this, body);
    };

    const originalFetch = window.fetch;
    window.fetch = async function (input, init) {
        const response = await originalFetch.call(this, input, init);

        try {
            const url = typeof input === 'string' ? input : input?.url;

            if (url && url.includes('.m3u8')) {
                notifyVideo({
                    url: url,
                    type: 'HLS',
                    title: document.title.replace(/\s*-\s*Flixtor.*$/i, '').trim()
                });
            }

            const cloned = response.clone();
            cloned.text().then(text => {
                if (text && text.includes('.m3u8')) {
                    const m3u8Match = text.match(/(https?:\/\/[^"'\s<>]+\.m3u8(?:\?[^"'\s<>]*)?)/i);
                    if (m3u8Match) {
                        notifyVideo({
                            url: m3u8Match[1],
                            type: 'HLS',
                            title: document.title.replace(/\s*-\s*Flixtor.*$/i, '').trim()
                        });
                    }
                }
            }).catch(() => {
                console.debug('[Flixtor] Fetch failed');
            });
        } catch (e) {
            console.debug('[Flixtor] Fetch intercept error:', e);
        }

        return response;
    };

    function scanPage() {
        const html = document.documentElement.outerHTML;

        const patterns = [
            /(https?:\/\/[^"'\s<>]+master\.m3u8(?:\?[^"'\s<>]*)?)/gi,
            /(https?:\/\/[^"'\s<>]+\/\d+p\.m3u8(?:\?[^"'\s<>]*)?)/gi,
            /(https?:\/\/[^"'\s<>]+\.m3u8(?:\?[^"'\s<>]*)?)/gi,
        ];

        for (const pattern of patterns) {
            const matches = [...html.matchAll(pattern)];
            for (const match of matches) {
                const url = match[1];

                if (url.includes('googleads') || url.includes('analytics') || url.includes('tracking')) continue;

                notifyVideo({
                    url: url,
                    type: 'HLS',
                    title: document.title.replace(/\s*-\s*Flixtor.*$/i, '').trim()
                });
                return;
            }
        }
    }

    if (document.readyState === 'complete') {
        setTimeout(scanPage, 1000);
    } else {
        window.addEventListener('load', () => setTimeout(scanPage, 1000));
    }

    const observer = new MutationObserver(() => {
        if (detectionTimeout) clearTimeout(detectionTimeout);
        detectionTimeout = setTimeout(scanPage, 2000);
    });

    observer.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true
    });
})();
