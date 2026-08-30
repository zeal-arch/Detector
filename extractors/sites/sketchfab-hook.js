(function() {
    'use strict';
    
    if (window._sketchfabHooked) return;
    window._sketchfabHooked = true;

    const originalFetch = window.fetch;
    const originalXhrOpen = XMLHttpRequest.prototype.open;
    
    const modelFiles = new Map();
    let modelId = null;
    
    const match = location.href.match(/sketchfab\.com\/(?:3d-models\/.*?-|models\/)([a-f0-9]{32})/);
    if (match) modelId = match[1];

    function checkUrl(url) {
        if (typeof url !== 'string' || !modelId) return;
        
        // Match ANY file associated with this model!
        if (url.includes(modelId) && url.startsWith('http')) {
            // Ignore API endpoints unless they are actual static assets
            if (url.includes('/likes?') || url.includes('/related') || url.includes('api.sketchfab.com')) {
                return;
            }
            
            // It's likely a static asset!
            let type = 'Asset';
            let ext = url.split('?')[0].split('.').pop() || 'bin';
            if (ext.length > 5) ext = 'bin'; // fallback if no valid extension
            
            let filename = url.split('/').pop().split('?')[0];
            if (!filename) filename = 'asset_' + Date.now() + '.' + ext;

            if (url.includes('/textures/')) {
                type = 'Texture';
                filename = 'textures/' + filename;
            } else if (url.includes('/animations/')) {
                type = 'Animation';
                filename = 'animations/' + filename;
            } else if (url.includes('.binz') || url.includes('.bin') || url.includes('.osgjs')) {
                type = 'Geometry';
                // keep the original filename!
            } else {
                type = 'Asset';
                filename = 'other/' + filename;
            }
            
            if (!modelFiles.has(url)) {
                modelFiles.set(url, {
                    url: url,
                    quality: type,
                    ext: ext,
                    isVideo: false,
                    isMuxed: false,
                    isModel: true,
                    filename: filename
                });
                
                sendToExtension();
            }
        }
    }
    
    let sendTimeout = null;
    function sendToExtension() {
        clearTimeout(sendTimeout);
        sendTimeout = setTimeout(() => {
            window.postMessage({
                type: 'SKETCHFAB_FILES_INTERCEPTED',
                modelId: modelId,
                files: Array.from(modelFiles.values())
            }, '*');
        }, 500);
    }

    window.fetch = function() {
        checkUrl(arguments[0]);
        return originalFetch.apply(this, arguments);
    };
    
    XMLHttpRequest.prototype.open = function() {
        checkUrl(arguments[1]);
        return originalXhrOpen.apply(this, arguments);
    };
})();
