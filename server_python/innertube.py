"""
innertube.py — Permanent YouTube Innertube API Client
Works via browser cookies (SAPISID) — no external auth needed.
YouTube can change UI 100 times, these API endpoints stay same.

Key fix: async JS (fetch, crypto.subtle) uses await_promise=True via CDP Runtime.evaluate
"""
import json, time, asyncio
from nodriver import cdp


class InnertubeClient:

    BASE = "https://www.youtube.com/youtubei/v1"

    def __init__(self, tab):
        self.tab = tab

    # ─── JS runners ──────────────────────────────────────────────────

    async def _js(self, code):
        """Sync JS — for non-Promise code."""
        try:
            r = await self.tab.evaluate(
                f"(() => {{ {code} }})()",
                return_by_value=True
            )
            return r.value if hasattr(r, "value") else r
        except Exception as e:
            return f"JS_ERROR:{e}"

    async def _js_async(self, code):
        """Async JS — for fetch/crypto.subtle/Promise code. Uses await_promise=True."""
        try:
            result = await self.tab.send(
                cdp.runtime.evaluate(
                    expression=f"(async () => {{ {code} }})()",
                    return_by_value=True,
                    await_promise=True,
                )
            )
            if hasattr(result, "result"):
                val = result.result
                return val.value if hasattr(val, "value") else val
            return result
        except Exception as e:
            return f"ASYNC_JS_ERROR:{e}"

    async def _js_json(self, code):
        raw = await self._js(code)
        try:
            return json.loads(str(raw)) if raw is not None else None
        except Exception:
            return raw

    # ─── auth helpers ─────────────────────────────────────────────────

    async def _get_api_key(self):
        key = await self._js(
            'return window.ytcfg?.get?.("INNERTUBE_API_KEY") || null;'
        )
        return key or "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8"

    async def _get_client_version(self):
        ver = await self._js(
            'return window.ytcfg?.get?.("INNERTUBE_CLIENT_VERSION") || null;'
        )
        return ver or "2.20250312.01.00"

    async def _get_sapisid(self):
        return await self._js("""
            var cookies = document.cookie.split('; ');
            for (var i = 0; i < cookies.length; i++) {
                var parts = cookies[i].split('=');
                if (parts[0] === 'SAPISID' || parts[0] === '__Secure-3PAPISID') {
                    return parts.slice(1).join('=');
                }
            }
            return null;
        """)

    async def _generate_sapisidhash(self):
        """Generate SAPISIDHASH — uses Python hashlib (no Promise issue)."""
        import hashlib
        sapisid = await self._get_sapisid()
        if not sapisid:
            return None
        ts = int(time.time())
        raw = f"{ts} {sapisid} https://www.youtube.com"
        h = hashlib.sha1(raw.encode()).hexdigest()
        return f"{ts}_{h}"

    async def _build_context(self):
        ver = await self._get_client_version()
        return {
            "client": {
                "clientName": "WEB",
                "clientVersion": ver,
                "platform": "DESKTOP",
                "hl": "en",
                "gl": "US"
            }
        }

    # ─── core API caller ──────────────────────────────────────────────

    async def _call_api_parsed(self, endpoint, extra_payload):
        api_key = await self._get_api_key()
        context = await self._build_context()
        sapisidhash = await self._generate_sapisidhash()

        payload = {"context": context}
        payload.update(extra_payload)

        headers = {
            "Content-Type": "application/json",
            "X-Goog-AuthUser": "0",
            "X-Origin": "https://www.youtube.com",
            "X-Youtube-Client-Name": "1",
        }
        if sapisidhash:
            headers["Authorization"] = f"SAPISIDHASH {sapisidhash}"

        url = f"{self.BASE}/{endpoint}?key={api_key}"

        # Use _js_async so fetch Promise resolves properly
        result = await self._js_async(f"""
            const resp = await fetch({json.dumps(url)}, {{
                method: "POST",
                headers: {json.dumps(headers)},
                credentials: "include",
                body: {json.dumps(json.dumps(payload))}
            }});
            const text = await resp.text();
            try {{
                return JSON.stringify({{status: resp.status, data: JSON.parse(text)}});
            }} catch(e) {{
                return JSON.stringify({{status: resp.status, data: text.substring(0,200)}});
            }}
        """)

        try:
            parsed = json.loads(str(result)) if result else {}
            return parsed
        except Exception:
            return {"raw": str(result)}

    # ─── check login ──────────────────────────────────────────────────

    async def check_login(self):
        logged = await self._js("""
            var avatar = document.querySelector(
                '#avatar-btn, button#avatar-btn, img.yt-spec-avatar-shape__avatar');
            var signIn = document.querySelector(
                'a[href*="accounts.google.com/ServiceLogin"], ' +
                'tp-yt-paper-button[aria-label="Sign in"]');
            if (avatar) return 'LOGGED_IN';
            if (signIn) return 'NOT_LOGGED_IN';
            return 'UNKNOWN';
        """)
        return logged

    # ─── get video / channel info ─────────────────────────────────────

    async def get_video_info(self, video_id):
        info = await self._js_json("""
            var channelId = null, name = null;
            // Method 1: ytInitialPlayerResponse
            try {
                channelId = ytInitialPlayerResponse?.videoDetails?.channelId || null;
                name = ytInitialPlayerResponse?.videoDetails?.author || null;
            } catch(e) {}
            // Method 2: DOM
            if (!channelId) {
                var ch = document.querySelector(
                    'ytd-video-owner-renderer a[href*="/channel/"],' +
                    '#owner a[href*="/channel/"]');
                if (ch) {
                    var m = ch.getAttribute('href').match(/\\/channel\\/([^/?]+)/);
                    if (m) channelId = m[1];
                    name = name || ch.textContent.trim();
                }
            }
            // Method 3: meta tag
            if (!channelId) {
                var meta = document.querySelector('meta[itemprop="channelId"]');
                if (meta) channelId = meta.getAttribute('content');
            }
            return JSON.stringify({channelId: channelId, name: name || 'unknown'});
        """)
        return info if isinstance(info, dict) else {"channelId": "", "name": ""}

    # ─── LIKE ─────────────────────────────────────────────────────────

    async def like(self, video_id):
        res = await self._call_api_parsed("like/like", {
            "target": {"videoId": video_id}
        })
        status = res.get("status", 0)
        if status == 200:
            return "LIKED_VIA_API"
        # DOM fallback
        r = await self._js("""
            var selectors = [
                'like-button-view-model button',
                'button[aria-label*="like" i]:not([aria-label*="dislike" i])',
                '#segmented-like-button button'
            ];
            for (var i = 0; i < selectors.length; i++) {
                var els = document.querySelectorAll(selectors[i]);
                for (var j = 0; j < els.length; j++) {
                    var lbl = (els[j].getAttribute('aria-label')||'').toLowerCase();
                    if (lbl.includes('like') && !lbl.includes('dislike')) {
                        els[j].scrollIntoView({block:'center'});
                        els[j].click();
                        return 'LIKED_VIA_DOM';
                    }
                }
            }
            return 'LIKE_NOT_FOUND';
        """)
        return r or f"LIKE_FAILED:{status}"

    # ─── DISLIKE ──────────────────────────────────────────────────────

    async def dislike(self, video_id):
        res = await self._call_api_parsed("like/dislike", {
            "target": {"videoId": video_id}
        })
        if res.get("status") == 200:
            return "DISLIKED_VIA_API"
        r = await self._js("""
            var selectors = [
                'dislike-button-view-model button',
                'button[aria-label*="dislike" i]',
                '#segmented-dislike-button button'
            ];
            for (var i = 0; i < selectors.length; i++) {
                var btn = document.querySelector(selectors[i]);
                if (btn) { btn.click(); return 'DISLIKED_VIA_DOM'; }
            }
            return 'DISLIKE_NOT_FOUND';
        """)
        return r or f"DISLIKE_FAILED:{res.get('status')}"

    async def remove_like(self, video_id):
        res = await self._call_api_parsed("like/removelike", {
            "target": {"videoId": video_id}
        })
        return "REMOVED_VIA_API" if res.get("status") == 200 else "REMOVE_FAILED"

    # ─── SUBSCRIBE ────────────────────────────────────────────────────

    async def subscribe(self, channel_id):
        res = await self._call_api_parsed("subscription/subscribe", {
            "channelIds": [channel_id],
            "params": "EgIIAhgA"
        })
        if res.get("status") == 200:
            return "SUBSCRIBED_VIA_API"
        r = await self._js("""
            var btns = document.querySelectorAll(
                '#subscribe-button-shape button, ytd-subscribe-button-renderer button, yt-button-shape button');
            for (var i = 0; i < btns.length; i++) {
                var lbl = (btns[i].getAttribute('aria-label') || btns[i].textContent || '').toLowerCase();
                if (lbl.includes('subscribe') && !lbl.includes('unsubscribe')) {
                    btns[i].scrollIntoView({block:'center'});
                    btns[i].click();
                    return 'SUBSCRIBED_VIA_DOM';
                }
            }
            var unsub = document.querySelector('button[aria-label*="Unsubscribe" i]');
            if (unsub) return 'ALREADY_SUBSCRIBED';
            return 'SUBSCRIBE_NOT_FOUND';
        """)
        return r or f"SUBSCRIBE_FAILED:{res.get('status')}"

    async def unsubscribe(self, channel_id):
        res = await self._call_api_parsed("subscription/unsubscribe", {
            "channelIds": [channel_id],
            "params": "CgIIAhgA"
        })
        return "UNSUBSCRIBED_VIA_API" if res.get("status") == 200 else "UNSUBSCRIBE_FAILED"

    # ─── BELL (notification preference) ───────────────────────────────

    async def set_notification(self, channel_id, pref="ALL"):
        pref_map = {"ALL": 3, "PERSONALIZED": 2, "NONE": 1}
        pref_value = pref_map.get(pref.upper(), 3)
        res = await self._call_api_parsed("notification/modify_channel_preference", {
            "channelId": channel_id,
            "pref": pref_value
        })
        if res.get("status") == 200:
            return f"BELL_SET_{pref}_VIA_API"
        # DOM fallback
        await self._js("""
            var bell = document.querySelector(
                '#notification-preference-button button, ytd-subscription-notification-toggle-button-renderer button');
            if (bell) bell.click();
        """)
        await asyncio.sleep(1.5)
        r = await self._js("""
            var items = document.querySelectorAll('ytd-menu-service-item-renderer, tp-yt-paper-item');
            for (var i = 0; i < items.length; i++) {
                if ((items[i].textContent||'').toLowerCase().includes('all')) {
                    items[i].click();
                    return 'BELL_SET_ALL_VIA_DOM';
                }
            }
            return 'BELL_DROPDOWN_NOT_FOUND';
        """)
        return r or f"BELL_FAILED:{res.get('status')}"

    # ─── COMMENT ──────────────────────────────────────────────────────

    async def post_comment(self, video_id, text):
        params = await self._js("""
            try {
                var str = JSON.stringify(window.ytInitialData || {});
                var match = str.match(/"createCommentParams":"([^"]+)"/);
                if (match) return match[1];
            } catch(e) {}
            return null;
        """)
        if params:
            res = await self._call_api_parsed("comment/create_comment", {
                "commentText": text,
                "createCommentParams": params
            })
            if res.get("status") == 200:
                return "COMMENT_POSTED_VIA_API"
        return "COMMENT_API_FAILED"

    # ─── PLAYER CONTROLS ──────────────────────────────────────────────

    async def set_quality(self, quality="medium"):
        r = await self._js(f"""
            var player = document.querySelector('#movie_player');
            if (!player) return 'PLAYER_NOT_FOUND';
            if (typeof player.setPlaybackQualityRange === 'function') {{
                player.setPlaybackQualityRange('{quality}', '{quality}');
                return 'QUALITY_SET:' + player.getPlaybackQuality();
            }}
            return 'METHOD_NOT_FOUND';
        """)
        return r

    async def set_autoplay(self, enabled=False):
        val = "true" if enabled else "false"
        r = await self._js(f"""
            var player = document.querySelector('#movie_player');
            if (player && typeof player.setAutonav === 'function') {{
                player.setAutonav({val});
                return 'AUTOPLAY_{"ON" if enabled else "OFF"}_API';
            }}
            var btn = document.querySelector('button.ytp-autonav-toggle-button');
            if (btn) {{
                var cur = (btn.getAttribute('aria-checked')||'').toLowerCase();
                var want = '{val}';
                if (cur !== want) btn.click();
                return 'AUTOPLAY_TOGGLED_DOM';
            }}
            return 'AUTOPLAY_NOT_FOUND';
        """)
        return r

    async def smart_ad_skip(self, max_wait=25):
        start = time.time()
        skipped = 0
        while time.time() - start < max_wait:
            r = await self._js("""
                var player = document.querySelector('#movie_player');
                var adShowing = player ? player.classList.contains('ad-showing') : false;
                if (!adShowing) {
                    var adOverlay = document.querySelector('.ytp-ad-player-overlay, .ytp-ad-simple-ad-badge');
                    if (!adOverlay) return 'NO_AD';
                }
                var skipBtns = document.querySelectorAll(
                    '.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern, [class*="skip-ad"]');
                for (var i = 0; i < skipBtns.length; i++) {
                    if (skipBtns[i].offsetParent !== null) {
                        skipBtns[i].click();
                        return 'SKIPPED';
                    }
                }
                var remaining = document.querySelector('.ytp-ad-duration-remaining, .ytp-ad-text');
                return 'AD_PLAYING:' + (remaining ? remaining.textContent : '');
            """)
            if r == "NO_AD":
                if time.time() - start < 5:
                    await asyncio.sleep(1)
                    continue
                return f"NO_AD_skipped={skipped}"
            elif r == "SKIPPED":
                skipped += 1
                await asyncio.sleep(2)
            else:
                await asyncio.sleep(1)
        return f"TIMEOUT_skipped={skipped}"
