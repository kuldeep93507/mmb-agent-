var x = 
(() => {
    function pack(btn, selector) {
        btn.scrollIntoView({block:'center', inline:'center', behavior:'instant'});
        var r = btn.getBoundingClientRect();
        var ow = btn.offsetWidth, oh = btn.offsetHeight;
        var w = Math.max(ow, r.width), h = Math.max(oh, r.height);
        if (w < 2 || h < 2) return null;
        var cs = window.getComputedStyle(btn);
        if (cs.display === 'none' || cs.visibility === 'hidden') return null;
        return {
            selector: selector,
            x: Math.round(r.left + w / 2),
            y: Math.round(r.top + h / 2),
            id: btn.id || '',
            text: (btn.innerText || btn.getAttribute('aria-label') || '').substring(0, 32)
        };
    }
    var sels = ["button.ytp-ad-skip-button-modern", ".ytp-ad-skip-button-modern", "button.ytp-skip-ad-button", ".ytp-skip-ad-button", "button.ytp-ad-skip-button", ".ytp-ad-skip-button", "button[id^=\"skip-button\"]", "#skip-button", "div[id^=\"skip-ad\"] button", "div[id^=\"skip-ad\"]", "span[id^=\"skip-button\"]", ".ytp-ad-player-overlay-layout__skip-or-preview-container button", ".ytp-ad-player-overlay-layout__skip-or-preview-container", ".ytp-ad-player-overlay-layout button", ".ytp-ad-player-overlay button", ".ytp-skip-ad button", ".ytp-skip-ad", ".ytp-skip-ad-container button", ".ytp-skip-ad-container", ".ytp-ad-skip-button-slot button", ".ytp-ad-skip-button-slot", "[class*=\"skip-ad-button\"]", "[class*=\"skip-button\"]", "button[class*=\"skip-ad\"]", "button[class*=\"skip-button\"]", "div[class*=\"skip-ad\"] button", ".video-ads [class*=\"skip\"]", ".ytp-ad-module [class*=\"skip\"]", "button[aria-label^=\"Skip ad\" i]", "button[aria-label^=\"Skip Ad\" i]", "button[aria-label*=\"Skip ad\" i]", "button[aria-label*=\"Skip Ad\" i]", "button[aria-label*=\"Skip\" i]", ".ytp-skip-ad-button__text", ".ytp-ad-skip-button-modern__text", ".ytp-ad-skip-button-container button", "button.ytp-button.ytp-ad-skip-button"];
    for (var i = 0; i < sels.length; i++) {
        var nodes = document.querySelectorAll(sels[i]);
        for (var n = 0; n < nodes.length; n++) {
            var hit = pack(nodes[n], sels[i]);
            if (hit) return hit;
        }
    }
    return null;
})()
;