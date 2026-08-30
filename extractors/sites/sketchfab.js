// sketchfab.js
(function () {
    'use strict';

    // Listen for messages from the MAIN world hook script (sketchfab-hook.js)
    window.addEventListener('message', function(event) {
        if (event.data && event.data.type === 'SKETCHFAB_FILES_INTERCEPTED') {
            const modelId = event.data.modelId;
            const files = event.data.files;
            
            if (files.length > 0) {
                const options = {
                    customTitle: "Sketchfab Model",
                    platform: 'sketchfab',
                    videoId: modelId,
                    formats: files
                };
                
                console.log('[Sketchfab Specialist] Intercepted', files.length, 'files');
                
                if (typeof chrome !== 'undefined' && chrome.runtime) {
                    chrome.runtime.sendMessage({
                        action: "SPECIALIST_DETECTED",
                        protocol: "MAGIC_M3U8", // reuse existing protocol for UI rendering
                        payload: {
                            videoId: modelId,
                            url: files[0].url,
                            options: options
                        },
                        pageUrl: window.location.href,
                    });
                }
            }
        }
    });

})();
