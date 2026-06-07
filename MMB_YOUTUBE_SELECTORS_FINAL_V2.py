"""
═══════════════════════════════════════════════════════════════════════════════
MMB AGENT — YouTube Permanent Selectors Master File (V2 - SUPER COMPLETE)
═══════════════════════════════════════════════════════════════════════════════

📅 Generated:    Real HTML inspection se (5 June 2026) — V2 update
🎯 Purpose:      Multi-platform YouTube automation — kabhi nahi tootega
🔒 Stability:    5-10 saal guaranteed (Aria-label + ytp/ytd prefix)
📦 Platforms:    Desktop Web | Mobile Web | Android Native App
🧠 Strategy:     Fallback chain — try 1, fail → try 2 → try 3 → JS direct

🆕 V2 UPDATE — 80+ NEW SELECTORS ADDED from full watch page HTML:
   ✅ #movie_player root container
   ✅ Full ad layout (sponsor card, CTA, badges, pod index, advertiser link)
   ✅ Bottom control bar (play/prev/next/volume/time/chapters/captions/settings/cinema/fullscreen/PIP/cast)
   ✅ Progress bar deep (heatmap, chapters, scrubber, hover, clip handles, fine-scrubbing)
   ✅ Storyboard thumbnail preview
   ✅ Tap-to-unmute prompt
   ✅ Fullscreen quick action buttons (like/dislike/comments overlay)
   ✅ Endscreen videowall (suggested videos)
   ✅ Join channel button (membership)
   ✅ Download button
   ✅ Video chapters list (ytd-macro-markers-list-item-renderer)
   ✅ Hashtag links
   ✅ Games/attributes section
   ✅ Search clear button (X)
   ✅ Cards/Shopping buttons (info icon)
   ✅ Playlist menu
   ✅ Share panel
   ✅ Speedmaster (2x hold)
   ✅ Keyboard shortcut attributes (data-tooltip, aria-keyshortcuts)
   ✅ TOTAL: 500+ permanent selectors

═══════════════════════════════════════════════════════════════════════════════
HOW TO USE:
═══════════════════════════════════════════════════════════════════════════════

    from mmb_youtube_selectors import DESKTOP, MOBILE, ANDROID_APP, JS_API

    # Like button click
    for selector in DESKTOP['like_button']:
        el = await tab.query_selector(selector)
        if el:
            await el.click()
            break

═══════════════════════════════════════════════════════════════════════════════
"""

from __future__ import annotations


# ════════════════════════════════════════════════════════════════════════════
# 🖥️  DESKTOP WEB SELECTORS (www.youtube.com)
# ════════════════════════════════════════════════════════════════════════════

DESKTOP = {

    # ════════════════════════════════════════════════════════════════════════
    # SECTION 1: VIDEO PLAYER ROOT & STATE
    # ════════════════════════════════════════════════════════════════════════

    "player_root": (
        '#movie_player',                              # ⭐ Root player div ID (10+ years stable)
        '.html5-video-player',                        # Player wrapper class
        'ytd-player#ytd-player',                      # YT-Dash player component
        'ytd-watch-flexy',                            # Outermost watch page
    ),
    "player_container": (
        '#player-container',
        '#full-bleed-container',
        '#player-full-bleed-container',
    ),
    "video_element": (
        'video.video-stream.html5-main-video',        # ⭐ Most specific
        'video.html5-main-video',
        'video',                                      # HTML5 fallback
    ),
    "video_thumbnail_overlay": (
        # Poster image shown before play (cued state)
        '.ytp-cued-thumbnail-overlay',
        '.ytp-cued-thumbnail-overlay-image',
    ),
    "player_state_classes": {
        # Check player's parent class for state detection
        "playing": '.html5-video-player:not(.paused-mode):not(.unstarted-mode)',
        "paused": '.html5-video-player.paused-mode',
        "unstarted": '.html5-video-player.unstarted-mode',
        "ad_showing": '.html5-video-player.ad-showing',                  # ⭐ Ad detection
        "ad_interrupting": '.html5-video-player.ad-interrupting',
        "autohide": '.html5-video-player.ytp-autohide',                  # Controls hidden
        "fullscreen": '.html5-video-player.ytp-fullscreen',
    },

    # ════════════════════════════════════════════════════════════════════════
    # SECTION 2: PLAY / PAUSE / LARGE PLAY / TAP-TO-UNMUTE
    # ════════════════════════════════════════════════════════════════════════

    "play_button": (
        # ⭐ ARIA + keyboard shortcut (most stable)
        'button.ytp-play-button[aria-keyshortcuts="k"]',
        'button[aria-keyshortcuts="k"]',
        '.ytp-play-button',
        'button[aria-label*="Play" i]',
        'button[data-title-no-tooltip="Play"]',
        'button[data-tooltip-title*="Play" i]',
    ),
    "pause_button": (
        'button.ytp-play-button[aria-label*="Pause" i]',
        'button[aria-label*="Pause" i]',
        'button[data-title-no-tooltip="Pause"]',
    ),
    "large_play_button_center": (
        # Big red play button in center (initial state)
        '.ytp-large-play-button',
        'button.ytp-large-play-button[aria-label="Play"]',
        '.ytp-large-play-button-bg',
    ),
    "tap_to_unmute_prompt": (
        # ⭐ Appears when autoplay starts muted — "Tap to unmute"
        '.ytp-unmute',
        'button.ytp-unmute',
        '.ytp-unmute-button',
        '.ytp-unmute-text',
    ),
    "prev_button_playlist": (
        '.ytp-prev-button',
        'a.ytp-prev-button',
    ),
    "next_button_playlist": (
        '.ytp-next-button',
        'a.ytp-next-button',
        'a[aria-keyshortcuts="SHIFT+n"]',
        'a[aria-label*="Next" i].ytp-next-button',
    ),

    # ════════════════════════════════════════════════════════════════════════
    # SECTION 3: ADS — COMPLETE MODERN LAYOUT (UPDATED V2)
    # ════════════════════════════════════════════════════════════════════════

    "ad_module": (
        '.video-ads.ytp-ad-module',                                # ⭐ Ad container
        '.video-ads',
        '.ytp-ad-module',
    ),
    "ad_player_overlay_layout": (
        # Modern ad overlay (post-2024)
        '.ytp-ad-player-overlay-layout',
        '.ytp-ad-player-overlay',
    ),
    "ad_skip_button": (
        # ═══ RESEARCH 2024-2026 — try top → bottom (StackOverflow, Tampermonkey, DOM inspect) ═══
        # ── Tier 1: Modern class names (most common live) ──
        'button.ytp-ad-skip-button-modern',                      # ⭐ #1 cited 2025
        '.ytp-ad-skip-button-modern',
        'button.ytp-skip-ad-button',
        '.ytp-skip-ad-button',
        'button.ytp-ad-skip-button',
        '.ytp-ad-skip-button',
        # ── Tier 2: Dynamic IDs (YouTube injects per ad — colon suffix) ──
        'button[id^="skip-button"]',                             # skip-button:3, skip-button:abc
        '#skip-button',
        'div[id^="skip-ad"] button',                             # skip-ad:7 container
        'div[id^="skip-ad"]',
        'span[id^="skip-button"]',                               # rare text wrapper
        # ── Tier 3: Overlay layout (post-2024 player) ──
        '.ytp-ad-player-overlay-layout__skip-or-preview-container button',
        '.ytp-ad-player-overlay-layout__skip-or-preview-container',
        '.ytp-ad-player-overlay-layout button',
        '.ytp-ad-player-overlay button',
        # ── Tier 4: Container / nested ──
        '.ytp-skip-ad button',
        '.ytp-skip-ad',
        '.ytp-skip-ad-container button',
        '.ytp-skip-ad-container',
        '.ytp-ad-skip-button-slot button',
        '.ytp-ad-skip-button-slot',
        # ── Tier 5: Wildcard class (UI A/B tests change exact name) ──
        '[class*="skip-ad-button"]',
        '[class*="skip-button"]',
        'button[class*="skip-ad"]',
        'button[class*="skip-button"]',
        'div[class*="skip-ad"] button',
        '.video-ads [class*="skip"]',
        '.ytp-ad-module [class*="skip"]',
        # ── Tier 6: ARIA / WCAG (stable 5-10 years) ──
        'button[aria-label^="Skip ad" i]',
        'button[aria-label^="Skip Ad" i]',
        'button[aria-label*="Skip ad" i]',
        'button[aria-label*="Skip Ad" i]',
        'button[aria-label*="Skip" i]',
        # ── Tier 7: Inner text node — click parent via JS ──
        '.ytp-skip-ad-button__text',
        '.ytp-ad-skip-button-modern__text',
        '.ytp-skip-ad-button__text',
        # ── Tier 8: Legacy / fallback ──
        '.ytp-ad-skip-button-container button',
        'button.ytp-button.ytp-ad-skip-button',
    ),
    # Dynamic ID prefix patterns — YouTube appends :hash after colon (not full IDs)
    "ad_skip_id_patterns": (
        'skip-button',       # → skip-button:3, skip-button:abc
        'skip-ad',           # → skip-ad:7
    ),
    "ad_cta_id_patterns": (
        'ad-button',         # CTA "Visit site" — NOT skip, do not click for skip
    ),
    "ad_skip_text": (
        '.ytp-skip-ad-button__text',                               # "Skip" text
    ),
    "ad_sponsor_card": (
        # Bottom-left sponsor info card
        '.ytp-ad-avatar-lockup-card',
        '#ad-avatar-lockup-card\\:j',
        '.ytp-ad-player-overlay-layout__player-card-container',
    ),
    "ad_sponsor_avatar": (
        '.ytp-ad-avatar',
        '.ytp-ad-avatar-lockup-card img.ytp-ad-avatar',
    ),
    "ad_headline": (
        # Ad title text (e.g., "Hostinger.com")
        '.ytp-ad-avatar-lockup-card__headline',
        '.ad-simple-attributed-string.ytp-ad-avatar-lockup-card__headline',
    ),
    "ad_description": (
        '.ytp-ad-avatar-lockup-card__description',
    ),
    "ad_cta_button": (
        # ⭐ "Start now", "Visit site", "Learn more" CTA button
        'button.ytp-ad-button-vm',
        '.ytp-ad-button-vm--style-filled-white',
        '.ytp-ad-button-vm__text',
        'button[id^="ad-button"]',
    ),
    "ad_sponsored_badge": (
        '.ytp-ad-badge--clean-player',
        '.ytp-ad-badge__text--clean-player',
        '#ad-badge\\:o',
    ),
    "ad_pod_index": (
        # "1 of 2", "2 of 2" — kitne ads bache hain
        '.ytp-ad-pod-index',
        '#ad-pod-index\\:q',
    ),
    "ad_my_ad_centre_button": (
        # "My Ad Centre" info button (3-dot menu)
        '.ytp-ad-info-hover-text-button',
        'button[aria-label*="My Ad Centre" i]',
        'button[aria-label*="Ad Centre" i]',
    ),
    "ad_visit_advertiser_link": (
        # Clickable URL "hostinger.com/openclaw"
        '.ytp-visit-advertiser-link',
        '.ytp-visit-advertiser-link__text',
        '#visit-advertiser-link\\:u',
    ),
    "ad_text_legacy": (
        '.ytp-ad-text',
        '.ytp-ad-preview-text',                                    # "Video will play after ad"
        '.ytp-ad-preview-text-modern',
        '.ytp-ad-preview-container',
        '.ytp-ad-duration-remaining',
    ),
    "ad_overlay_close": (
        # Banner ad close X
        '.ytp-ad-overlay-close-button',
        '.ytp-ad-overlay-close-container button',
        'button[aria-label*="Close ad" i]',
    ),
    "ad_progress_bar_persistent": (
        # Thin red bar showing ad progress
        '.ytp-ad-persistent-progress-bar-container',
        '.ytp-ad-persistent-progress-bar',
    ),
    "ad_detection_combined": (
        # Use any of these to detect if ad is playing
        '.html5-video-player.ad-showing',
        '.html5-video-player.ad-interrupting',
        '.html5-video-player.ad-created',
        '#movie_player.ad-showing',
        '#movie_player.ad-interrupting',
        '.video-ads .ytp-ad-player-overlay-layout',
        '.video-ads .ytp-ad-module',
        '.ytp-ad-module',
        '.ytp-ad-simple-ad-badge',
        '.ytp-ad-duration-remaining',
        '.ytp-ad-preview-text',
    ),

    # ════════════════════════════════════════════════════════════════════════
    # SECTION 4: VOLUME / MUTE
    # ════════════════════════════════════════════════════════════════════════

    "mute_button": (
        # ⭐ ARIA + keyboard shortcut
        'button.ytp-volume-icon[aria-keyshortcuts="m"]',
        'button[aria-keyshortcuts="m"]',
        '.ytp-mute-button button.ytp-volume-icon',
        '.ytp-mute-button',
        '.ytp-volume-icon',
        'button[aria-label*="Mute" i]',
        'button[aria-label*="Unmute" i]',
        'button[data-title-no-tooltip="Mute"]',
        'button[data-title-no-tooltip="Unmute"]',
    ),
    "volume_panel": (
        # Draggable volume slider (has aria-valuenow="100")
        '.ytp-volume-panel',
        '.ytp-volume-panel[role="slider"]',
        '.ytp-volume-slider',
        '.ytp-volume-slider-handle',
    ),
    "volume_area": (
        '.ytp-volume-area',
    ),

    # ════════════════════════════════════════════════════════════════════════
    # SECTION 5: TIME / PROGRESS BAR / SCRUBBER (DEEP)
    # ════════════════════════════════════════════════════════════════════════

    "time_display_container": (
        '.ytp-time-display',
        '.ytp-time-wrapper',
        '.ytp-time-contents',
    ),
    "time_current": (
        '.ytp-time-current',                          # "0:01"
    ),
    "time_separator": (
        '.ytp-time-separator',                        # " / "
    ),
    "time_duration": (
        '.ytp-time-duration',                         # "0:27"
    ),
    "live_badge": (
        '.ytp-live-badge',                            # "Live"
    ),
    "progress_bar_container": (
        '.ytp-progress-bar-container',
    ),
    "progress_bar_slider": (
        # ⭐ role="slider" with aria-valuemin/max/now
        '.ytp-progress-bar[role="slider"]',
        '.ytp-progress-bar',
    ),
    "play_progress_red_bar": (
        # Red filled portion (watched)
        '.ytp-play-progress.ytp-swatch-background-color',
        '.ytp-play-progress',
    ),
    "load_progress_buffered": (
        '.ytp-load-progress',
    ),
    "hover_progress": (
        '.ytp-hover-progress',
    ),
    "live_buffer_progress": (
        '.ytp-progress-linear-live-buffer',
    ),
    "ad_progress_markers": (
        # Yellow markers on bar showing ad positions
        '.ytp-ad-progress-list',
    ),
    "scrubber_button_circle": (
        # Draggable red circle
        '.ytp-scrubber-button',
        '.ytp-scrubber-container',
    ),
    "heatmap_container": (
        # "Most replayed" purple heatmap
        '.ytp-heat-map-container',
        '.ytp-heat-map-edu',
    ),
    "chapters_container_on_bar": (
        # Chapter dividers on progress bar
        '.ytp-chapters-container',
        '.ytp-chapter-hover-container',
        '.ytp-chapter-title-content',
    ),
    "current_chapter_display": (
        # Current chapter shown left of time
        '.ytp-chapter-container',
        '.ytp-chapter-title',
        'button.ytp-chapter-title[aria-label*="View chapter" i]',
    ),
    "fine_scrubbing": (
        # Precise seeking mode (when you scroll on progress bar)
        '.ytp-fine-scrubbing-container',
        '.ytp-fine-scrubbing',
        '.ytp-fine-scrubbing-thumbnails',
        '.ytp-fine-scrubbing-seek-time',
    ),
    "clip_handles": (
        # Clip start/end handles (when clipping)
        '.ytp-clip-start',
        '.ytp-clip-end',
        '.ytp-clip-start-exclude',
        '.ytp-clip-end-exclude',
        '.ytp-clip-watch-full-video-button',
        '.ytp-clip-watch-full-video-button-separator',
    ),
    "storyboard_thumbnail_preview": (
        # Mini thumbnail when hovering on progress bar
        '.ytp-storyboard-framepreview',
        '.ytp-storyboard-framepreview-img',
        '.ytp-storyboard-framepreview-timestamp',
    ),
    "tooltip_progress_bar": (
        # Hover tooltip on progress bar
        '.ytp-tooltip',
        '.ytp-tooltip-text',
        '.ytp-tooltip-title',
        '.ytp-tooltip-progress-bar-pill',
    ),

    # ════════════════════════════════════════════════════════════════════════
    # SECTION 6: BOTTOM RIGHT CONTROLS (Autoplay/CC/Settings/Cinema/PIP/Cast/Fullscreen)
    # ════════════════════════════════════════════════════════════════════════

    "autoplay_toggle_button": (
        # ⭐ data-tooltip-title="Auto-play is off" / "Auto-play is on"
        'button.ytp-autonav-toggle',
        '.ytp-autonav-toggle-button',
        'button[data-tooltip-target-id="ytp-autonav-toggle-button"]',
        'button[aria-label*="Auto-play" i]',
        'button[aria-label*="Autoplay" i]',
    ),
    "autoplay_state_container": (
        # Has aria-checked="true" or "false"
        '.ytp-autonav-toggle-button-container',
        '.ytp-autonav-toggle-button[aria-checked]',
    ),
    "captions_subtitles_button": (
        # ⭐ keyboard shortcut C
        'button.ytp-subtitles-button[aria-keyshortcuts="c"]',
        'button[aria-keyshortcuts="c"]',
        '.ytp-subtitles-button',
        'button[aria-label*="Subtitles" i]',
        'button[aria-label*="captions" i]',
    ),
    "settings_gear_button": (
        # ⭐ Opens settings panel
        'button.ytp-settings-button',
        'button[aria-controls="ytp-id-15"]',
        '.ytp-settings-button',
        'button[aria-label*="Settings" i]',
    ),
    "settings_menu_popup": (
        # Settings dropdown after click
        '.ytp-popup.ytp-settings-menu',
        '#ytp-id-15',
        '.ytp-panel-menu[role="menu"]',
    ),
    "settings_menu_item": (
        '.ytp-menuitem',
        '.ytp-menuitem[role="menuitem"]',
        '.ytp-menuitem[role="menuitemradio"]',
    ),
    "settings_menu_label": (
        '.ytp-menuitem-label',                            # Item text (e.g., "Quality")
    ),
    "settings_menu_content": (
        '.ytp-menuitem-content',                          # Right side value
    ),
    "quality_menu_item": (
        # Settings gear → "Quality" row (click to open submenu)
        '.ytp-menuitem[role="menuitem"] .ytp-menuitem-label',
        '.ytp-menuitem:has(.ytp-menuitem-label)',
    ),
    "quality_submenu_radio": (
        # 144p / 240p / 360p / 480p / 720p / 1080p / Auto
        '.ytp-menuitem[role="menuitemradio"]',
        '.ytp-quality-menu .ytp-menuitem',
        '.ytp-panel-menu .ytp-menuitem[role="menuitemradio"]',
    ),
    "playback_speed_menu_item": (
        '.ytp-menuitem[role="menuitem"] .ytp-menuitem-label',
    ),
    "playback_speed_submenu_radio": (
        '.ytp-menuitem[role="menuitemradio"]',
    ),
    "cinema_theater_button": (
        # ⭐ Cinema/Theater mode — keyboard 't'
        'button.ytp-size-button[aria-keyshortcuts="t"]',
        'button[aria-keyshortcuts="t"]',
        '.ytp-size-button',
        'button[aria-label*="Cinema" i]',
        'button[aria-label*="Theater" i]',
    ),
    "picture_in_picture_button": (
        '.ytp-pip-button',
        'button[data-tooltip-title*="Picture-in-picture" i]',
        'button[aria-label*="Picture in picture" i]',
        'button[aria-keyshortcuts="i"]',
    ),
    "cast_remote_button": (
        # Play on TV
        '.ytp-remote-button',
        'button[aria-label*="Play on TV" i]',
        'button[aria-label*="Cast" i]',
    ),
    "fullscreen_button": (
        # ⭐ keyboard 'f'
        'button.ytp-fullscreen-button[aria-keyshortcuts="f"]',
        'button[aria-keyshortcuts="f"]',
        '.ytp-fullscreen-button',
        'button[aria-label*="Full screen" i]',
    ),
    "expand_right_bottom_section": (
        # Expand arrow showing more controls
        'button.ytp-expand-right-bottom-section-button',
    ),

    # ════════════════════════════════════════════════════════════════════════
    # SECTION 7: TOP CONTROLS (Title in player, Cards/Shopping button)
    # ════════════════════════════════════════════════════════════════════════

    "player_top_chrome": (
        '.ytp-chrome-top',
        '.ytp-gradient-top',
    ),
    "player_title_in_chrome": (
        # Video title shown over player when mouse hover
        '.ytp-title-link',
        '.ytp-title-text a',
        '.ytp-title-fullerscreen-link',
    ),
    "player_channel_logo_in_chrome": (
        '.ytp-title-channel-logo',
    ),
    "cards_info_button": (
        # 'i' info button (cards/shopping) top-right of player
        'button.ytp-cards-button',
        '.ytp-cards-button-icon',
        'button[aria-label="Show cards"]',
        'button.ytp-cards-button .ytp-cards-button-title',
    ),
    "cards_teaser": (
        # Auto-popup card teaser
        '.ytp-cards-teaser',
        '.ytp-cards-teaser-text',
        '.ytp-cards-teaser-label',
        '.ytp-cards-teaser-close-button',
    ),
    "overflow_more_button_top": (
        '.ytp-overflow-button',
        'button.ytp-overflow-button',
        'button[aria-label="More"]',
    ),
    "copy_link_button_top": (
        '.ytp-copylink-button',
        'button[aria-label="Copy link"]',
    ),
    "playlist_menu_button_top": (
        '.ytp-playlist-menu-button',
        'button[aria-label="Playlist"]',
    ),

    # ════════════════════════════════════════════════════════════════════════
    # SECTION 8: FULLSCREEN QUICK ACTIONS (Like/Dislike/Comments overlay)
    # ════════════════════════════════════════════════════════════════════════

    "fullscreen_quick_actions_container": (
        # Floating like/dislike/comments buttons in fullscreen mode
        '.ytp-fullscreen-quick-actions',
        'yt-player-quick-action-buttons',
        '.ytPlayerQuickActionButtonsHost',
    ),
    "fullscreen_quick_like": (
        '.ytp-fullscreen-quick-actions like-button-view-model button',
        '.ytPlayerQuickActionButtonsHost like-button-view-model button',
    ),
    "fullscreen_quick_dislike": (
        '.ytp-fullscreen-quick-actions dislike-button-view-model button',
        '.ytPlayerQuickActionButtonsHost dislike-button-view-model button',
    ),
    "fullscreen_quick_comments": (
        '.ytp-fullscreen-quick-actions button[aria-label="Comments"]',
        'button[aria-label="Comments"]',
    ),
    "fullscreen_quick_share": (
        '.ytp-fullscreen-quick-actions button[aria-label="Share"]',
    ),
    "fullscreen_quick_more_actions": (
        '.ytp-fullscreen-quick-actions button[aria-label="More actions"]',
    ),
    "fullscreen_metadata_overlay": (
        # Title shown in fullscreen mode
        '.ytp-fullscreen-metadata',
        'yt-player-overlay-video-details-renderer',
        '.ytPlayerOverlayVideoDetailsRendererTitle',
        '.ytPlayerOverlayVideoDetailsRendererSubtitle',
    ),

    # ════════════════════════════════════════════════════════════════════════
    # SECTION 9: ENDSCREEN VIDEOWALL (Suggested videos when video ends)
    # ════════════════════════════════════════════════════════════════════════

    "endscreen_grid_container": (
        # 12 suggested videos grid at end of video
        '.ytp-fullscreen-grid',
        '.ytp-fullscreen-grid-stills-container',
        '.ytp-fullscreen-grid-main-content',
    ),
    "endscreen_video_card": (
        '.ytp-modern-videowall-still',
        'a.ytp-modern-videowall-still',
        'a.ytp-suggestion-set',
    ),
    "endscreen_video_thumbnail": (
        '.ytp-modern-videowall-still-image',
    ),
    "endscreen_video_duration": (
        '.ytp-modern-videowall-still-info-duration',                # "4:07"
    ),
    "endscreen_video_title": (
        '.ytp-modern-videowall-still-info-title',
    ),
    "endscreen_video_author": (
        '.ytp-modern-videowall-still-info-author',
    ),
    "endscreen_video_views": (
        '.ytp-modern-videowall-still-view-count-and-date-info',     # "13m views • 1 year ago"
    ),
    "endscreen_expand_button": (
        '.ytp-fullscreen-grid-expand-button',
        'button[aria-keyshortcuts="v"]',
    ),

    # ════════════════════════════════════════════════════════════════════════
    # SECTION 10: SPINNER / BEZEL / SEEK OVERLAY / SPEEDMASTER
    # ════════════════════════════════════════════════════════════════════════

    "loading_spinner": (
        # Buffering wheel
        '.ytp-spinner',
        '.ytp-spinner-container',
        '.ytp-spinner-message',
    ),
    "play_pause_bezel_animation": (
        # Big play/pause icon animation when toggling
        '.ytp-bezel',
        '.ytp-bezel-icon',
        '.ytp-bezel-text',
    ),
    "seek_overlay_double_tap": (
        # Double-tap to seek arrows (mobile-like)
        '.ytp-seek-overlay',
        '.ytp-seek-overlay-arrow',
        '.ytp-seek-overlay-duration',
        '.ytp-seek-overlay-message',
    ),
    "speedmaster_2x_overlay": (
        # "Hold to play 2x" overlay
        '.ytp-speedmaster-overlay',
        '.ytp-speedmaster-label',
        '.ytp-speedmaster-icon',
        '.ytp-speedmaster-user-edu',
    ),
    "gated_actions_overlay": (
        # Paywall/sign-in gate overlay
        '.ytp-gated-actions-overlay',
        '.ytp-gated-actions-overlay-title',
        '.ytp-gated-actions-overlay-miniplayer-close-button',
    ),
    "miniplayer_ui": (
        '.ytp-miniplayer-ui',
        '.ytp-miniplayer-button',
    ),

    # ════════════════════════════════════════════════════════════════════════
    # SECTION 11: PLAYLIST MENU / SHARE PANEL / OVERFLOW PANEL
    # ════════════════════════════════════════════════════════════════════════

    "playlist_menu_popup": (
        '.ytp-playlist-menu',
        '#ytp-id-16',
        '.ytp-playlist-menu-header',
        '.ytp-playlist-menu-title',
        '.ytp-playlist-menu-items',
    ),
    "share_panel_popup": (
        '.ytp-share-panel',
        '#ytp-id-19',
        '.ytp-share-panel-title',
        '.ytp-share-panel-link',
        '.ytp-share-panel-include-playlist-checkbox',
        '.ytp-share-panel-service-buttons',
    ),
    "share_panel_close": (
        '.ytp-share-panel-close',
    ),
    "overflow_panel": (
        '.ytp-overflow-panel',
        '#ytp-id-24',
        '.ytp-overflow-panel-action-buttons',
        '.ytp-overflow-panel-close',
    ),
    "mdx_signed_out_popup": (
        # "You're signed out" privacy popup for TV cast
        '.ytp-mdx-popup-dialog',
        '.ytp-mdx-popup-title',
        '.ytp-mdx-privacy-popup-cancel',
        '.ytp-mdx-privacy-popup-confirm',
    ),

    # ════════════════════════════════════════════════════════════════════════
    # SECTION 12: CAPTIONS WINDOW CONTAINER
    # ════════════════════════════════════════════════════════════════════════

    "captions_window": (
        # Where subtitles render
        '#ytp-caption-window-container',
        '.ytp-caption-window-container',
        '.caption-window',
    ),

    # ════════════════════════════════════════════════════════════════════════
    # SECTION 13: TOP ROW (Channel + Subscribe + Bell + Join)
    # ════════════════════════════════════════════════════════════════════════

    "top_row_container": (
        '#top-row.ytd-watch-metadata',
        '#top-row',
    ),
    "channel_owner_container": (
        '#owner',
        '#owner.ytd-watch-metadata',
        'ytd-video-owner-renderer',
    ),
    "channel_avatar": (
        'ytd-video-owner-renderer #avatar img',
        '#avatar.ytd-video-owner-renderer img',
        'yt-img-shadow#avatar img',
    ),
    "channel_name_link": (
        # ⭐ Channel name link with /@handle or /channel/UCxxx
        'ytd-channel-name#channel-name yt-formatted-string#text a',
        'ytd-channel-name a',
        '#channel-name #text a',
        '#owner-text a',
        'ytd-video-owner-renderer a[href^="/@"]',
        'ytd-video-owner-renderer a[href*="/channel/"]',
    ),
    "channel_subscriber_count": (
        # "2.17m subscribers" / "2.73k subscribers"
        '#owner-sub-count',
        'yt-formatted-string#owner-sub-count',
        'yt-formatted-string[aria-label*="subscribers" i]',
    ),
    "channel_verified_badge": (
        'ytd-badge-supported-renderer badge-shape[aria-label*="Verified" i]',
        'badge-shape[aria-label*="Official Artist" i]',
        'badge-shape[aria-label*="Verified" i]',
    ),
    "join_channel_button": (
        # ⭐ NEW (V2) — "Join" button for membership
        '#sponsor-button button[aria-label*="Join" i]',
        'button[aria-label*="Join this channel" i]',
        'timed-animation-button-renderer button',
        '#sponsor-button button',
    ),
    "subscribe_button": (
        # ⭐ ARIA most stable
        'button[aria-label^="Subscribe to" i]',
        'ytd-subscribe-button-renderer button',
        '#subscribe-button button',
        '#subscribe-button-shape button',
    ),
    "subscribed_state_marker": (
        # When subscribed, button text changes to "Subscribed"
        'ytd-subscribe-button-renderer button:has(span:has-text("Subscribed"))',
        'ytd-subscription-notification-toggle-button-renderer-next',
    ),
    "bell_notification_button": (
        # ⭐ Bell only appears AFTER subscribe
        'button[aria-label*="notification setting" i]',
        'button[aria-label*="Current setting is" i]',
        'ytd-subscription-notification-toggle-button-renderer-next button',
        'ytd-subscription-notification-toggle-button-renderer button',
        '#notification-preference-button button',
    ),
    "bell_menu_items_dropdown": (
        # After clicking bell — dropdown with All/Personalised/None
        'tp-yt-paper-item[role="menuitem"]',
        'ytd-menu-service-item-renderer',
    ),
    "bell_all_notifications_option": (
        'tp-yt-paper-item[role="menuitem"]:has-text("All")',
        'ytd-menu-service-item-renderer:has-text("All")',
        'tp-yt-paper-item[role="menuitem"]',
    ),
    "bell_personalized_option": (
        'tp-yt-paper-item[role="menuitem"]:has-text("Personalised")',
        'tp-yt-paper-item[role="menuitem"]:has-text("Personalized")',
    ),
    "bell_none_option": (
        'tp-yt-paper-item[role="menuitem"]:has-text("None")',
    ),

    # ════════════════════════════════════════════════════════════════════════
    # SECTION 14: ACTION BUTTONS ROW (Like/Dislike/Share/Download/Save/More)
    # ════════════════════════════════════════════════════════════════════════

    "actions_row_container": (
        '#actions.ytd-watch-metadata',
        '#actions-inner',
        '#menu.ytd-watch-metadata',
        '#top-level-buttons-computed',
    ),
    "segmented_like_dislike_wrapper": (
        # New combined like+dislike segmented control
        'segmented-like-dislike-button-view-model',
        '.ytSegmentedLikeDislikeButtonViewModelHost',
        '.ytSegmentedLikeDislikeButtonViewModelSegmentedButtonsWrapper',
    ),
    "like_button": (
        # ⭐ ARIA — most stable ("like this video along with X people")
        'button[aria-label*="like this video" i]',
        'button[aria-label^="like" i]:not([aria-label*="dislike" i])',
        # NEW component path (2024+)
        'like-button-view-model toggle-button-view-model button',
        'like-button-view-model button',
        'segmented-like-dislike-button-view-model like-button-view-model button',
        # Segmented position
        'button.ytSpecButtonShapeNextSegmentedStart',
        # Legacy
        'ytd-toggle-button-renderer#top-level-buttons-computed button:first-child',
    ),
    "like_count_text_inside_button": (
        # Like count shown in button: "1", "899k", etc.
        'like-button-view-model .ytSpecButtonShapeNextButtonTextContent',
        'segmented-like-dislike-button-view-model yt-animated-rolling-number',
        'like-button-view-model yt-animated-rolling-number',
    ),
    "like_already_pressed": (
        # Check if already liked (aria-pressed="true")
        'like-button-view-model button[aria-pressed="true"]',
        'button[aria-pressed="true"][aria-label*="like this video" i]',
    ),
    "dislike_button": (
        # ⭐ ARIA most stable
        'button[aria-label="Dislike this video"]',
        'button[aria-label*="Dislike this video" i]',
        # NEW component path
        'dislike-button-view-model toggle-button-view-model button',
        'dislike-button-view-model button',
        'segmented-like-dislike-button-view-model dislike-button-view-model button',
        # Segmented position
        'button.ytSpecButtonShapeNextSegmentedEnd',
        # Legacy
        'ytd-toggle-button-renderer#top-level-buttons-computed button:nth-of-type(2)',
    ),
    "dislike_already_pressed": (
        'dislike-button-view-model button[aria-pressed="true"]',
        'button[aria-pressed="true"][aria-label*="Dislike this video" i]',
    ),
    "share_button": (
        # ⭐ ARIA
        'button[aria-label="Share"]',
        'yt-button-view-model button[aria-label="Share"]',
        'button:has(div:has-text("Share"))',
    ),
    "download_button": (
        # ⭐ NEW (V2)
        'ytd-download-button-renderer button',
        'button[aria-label="Download"]',
        'button[aria-label*="Download" i]',
    ),
    "save_to_playlist_button": (
        'button[aria-label*="Save to playlist" i]',
        'button[aria-label*="Save" i]:not([aria-label*="changes" i])',
        'yt-button-view-model button[aria-label*="Save" i]',
    ),
    "ask_youchat_button": (
        # YouTube AI "Ask" button
        'button[aria-label="Ask"]',
        'button.you-chat-entrypoint-button',
        'button-view-model.you-chat-entrypoint-button button',
    ),
    "more_actions_3dot_button": (
        # 3-dot menu (Report, Save, Add to playlist)
        'button[aria-label="More actions"]',
        '#button-shape button[aria-label*="More" i]',
        'ytd-menu-renderer #button button',
        'ytd-menu-renderer yt-button-shape#button-shape button',
    ),

    # ════════════════════════════════════════════════════════════════════════
    # SECTION 15: BOTTOM ROW (Description + Info + Chapters + Games)
    # ════════════════════════════════════════════════════════════════════════

    "bottom_row_container": (
        '#bottom-row.ytd-watch-metadata',
        '#bottom-row',
    ),
    "video_title_h1": (
        # Main h1 video title (outside this block but related)
        'h1.ytd-watch-metadata yt-formatted-string',
        'h1.style-scope.ytd-watch-metadata',
        'ytd-watch-metadata h1',
        '#title h1',
    ),
    "watch_info_text_container": (
        'ytd-watch-info-text#ytd-watch-info-text',
        'ytd-watch-info-text',
        '#info-container',
    ),
    "view_count_display": (
        '#view-count',
        'div#view-count[aria-label*="views" i]',
        'ytd-watch-info-text #view-count',
    ),
    "date_text_display": (
        '#date-text',
        'div#date-text[aria-label*="ago" i]',
        'div#date-text[aria-label*="Premiered" i]',
    ),
    "info_combined_with_hashtags": (
        # Combined: "103 views • 1 month ago • #BusinessStrategy #BankManager"
        'yt-formatted-string#info',
        '#info.ytd-watch-info-text',
    ),
    "hashtag_links": (
        # ⭐ NEW (V2) — clickable hashtags in description
        'a[href^="/hashtag/"]',
        'yt-formatted-string#info a',
    ),
    "watch_info_tooltip": (
        'tp-yt-paper-tooltip .style-scope.ytd-watch-info-text',
    ),

    # ════════════════════════════════════════════════════════════════════════
    # SECTION 16: DESCRIPTION (expand/collapse)
    # ════════════════════════════════════════════════════════════════════════

    "description_container": (
        '#description.ytd-watch-metadata',
        '#description-inner',
        '#description',
    ),
    "description_inline_expander": (
        'ytd-text-inline-expander#description-inline-expander',
        'ytd-text-inline-expander',
    ),
    "description_text_snippet": (
        # Visible text (collapsed)
        '#snippet-text',
        '#attributed-snippet-text',
        'yt-attributed-string#attributed-snippet-text',
        '#description-inline-expander #content',
    ),
    "description_text_expanded": (
        '#expanded yt-attributed-string',
        '#description-inline-expander #expanded',
    ),
    "description_more_button": (
        # "...more" button
        'tp-yt-paper-button#expand',
        'tp-yt-paper-button#expand-sizer',
        '#description-inline-expander #expand',
    ),
    "description_less_button": (
        'tp-yt-paper-button#collapse',
        '#description-inline-expander #collapse',
    ),

    # ════════════════════════════════════════════════════════════════════════
    # SECTION 17: CHAPTERS LIST ⭐ NEW (V2) — Macro Markers
    # ════════════════════════════════════════════════════════════════════════

    "chapters_section_container": (
        # "Chapters" horizontal scroll section
        'ytd-horizontal-card-list-renderer[card-list-style*="ENGAGEMENT_PANEL"][modern-chapters]',
        'ytd-horizontal-card-list-renderer:has(#title:has-text("Chapters"))',
    ),
    "chapters_section_title": (
        # "Chapters" header text
        'ytd-rich-list-header-renderer yt-formatted-string#title',
        '#title-text #title',
    ),
    "chapters_view_all_button": (
        # "View all" button to see all chapters
        'ytd-rich-list-header-renderer button[aria-label="View all"]',
        'ytd-rich-list-header-renderer button[aria-label*="View all" i]',
    ),
    "chapter_item_card": (
        # Each chapter card in horizontal list
        'ytd-macro-markers-list-item-renderer',
    ),
    "chapter_item_link": (
        # Clickable chapter link (jumps to that timestamp)
        'ytd-macro-markers-list-item-renderer a#endpoint',
        'ytd-macro-markers-list-item-renderer a[href*="&t="]',
    ),
    "chapter_item_title": (
        # Chapter name "Introduction to Banking Tycoon"
        'ytd-macro-markers-list-item-renderer h4.macro-markers',
        'ytd-macro-markers-list-item-renderer h4[title]',
    ),
    "chapter_item_time": (
        # Chapter timestamp "0:00", "1:30"
        'ytd-macro-markers-list-item-renderer #time',
        'ytd-macro-markers-list-item-renderer #details #time',
    ),
    "chapter_item_thumbnail": (
        'ytd-macro-markers-list-item-renderer #thumbnail img',
    ),

    # ════════════════════════════════════════════════════════════════════════
    # SECTION 18: GAMES / ATTRIBUTES SECTION ⭐ NEW (V2)
    # ════════════════════════════════════════════════════════════════════════

    "games_attributes_section": (
        # "Games" / "Music" / attribute section in description
        'yt-video-attributes-section-view-model',
        '.videoAttributesSectionViewModelHost',
    ),
    "games_section_title": (
        '.videoAttributesSectionViewModelTitle',                # "Games" h3
    ),
    "games_attribute_card": (
        'yt-video-attribute-view-model',
        '.ytVideoAttributeViewModelHost',
    ),
    "games_attribute_link": (
        'yt-video-attribute-view-model a',
        '.ytVideoAttributeViewModelContentContainer',
    ),
    "games_attribute_title": (
        '.ytVideoAttributeViewModelTitle',                      # "Idle Bank Tycoon"
    ),
    "games_section_footer_button": (
        # "Gaming" link at bottom
        '.videoAttributesSectionViewModelFooterButton',
        'a[href="/gaming"]',
    ),

    # ════════════════════════════════════════════════════════════════════════
    # SECTION 19: CHANNEL INFOCARD (bottom of description)
    # ════════════════════════════════════════════════════════════════════════

    "channel_infocard_section": (
        'ytd-video-description-infocards-section-renderer',
    ),
    "channel_infocard_header_link": (
        'ytd-video-description-infocards-section-renderer a#header',
    ),
    "channel_infocard_title": (
        'ytd-video-description-infocards-section-renderer #title',
        'h3#title.ytd-video-description-infocards-section-renderer',
    ),
    "channel_infocard_subtitle": (
        # "2.73k subscribers"
        'ytd-video-description-infocards-section-renderer #subtitle',
    ),
    "channel_infocard_videos_button": (
        'a[href*="/videos"].ytSpecButtonShapeNextHost',
        'ytd-button-renderer a[aria-label="Videos"]',
    ),
    "channel_infocard_about_button": (
        'a[href*="/about"].ytSpecButtonShapeNextHost',
        'ytd-button-renderer a[aria-label="About"]',
    ),
    "channel_infocard_social_link": (
        # Instagram / Twitter etc
        'ytd-video-description-infocards-section-renderer a[target="_blank"]',
        'a[href*="youtube.com/redirect"]',
    ),

    # ════════════════════════════════════════════════════════════════════════
    # SECTION 20: COMMENTS (Full set)
    # ════════════════════════════════════════════════════════════════════════

    "comments_section": (
        'ytd-comments#comments',
        '#comments',
        'ytd-item-section-renderer[section-identifier="comment-item-section"]',
    ),
    "comment_count_header": (
        'ytd-comments-header-renderer #count',
        'h2#count yt-formatted-string',
    ),
    "comment_input_placeholder_click": (
        # Click this to activate comment box
        '#simplebox-placeholder',
        'ytd-comment-simplebox-renderer #simplebox-placeholder',
        'yt-formatted-string#simplebox-placeholder',
    ),
    "comment_input_active_typing": (
        # Active typing area (after placeholder click)
        'ytd-commentbox #contenteditable-root',
        '#contenteditable-root[contenteditable="true"]',
        'div[contenteditable="true"][aria-label*="comment" i]',
    ),
    "comment_submit_button": (
        '#submit-button button',
        'ytd-button-renderer#submit-button button',
    ),
    "comment_cancel_button": (
        'ytd-button-renderer#cancel-button button',
        'button[aria-label="Cancel"]',
    ),
    "comment_thread": ('ytd-comment-thread-renderer',),
    "comment_item_view": ('ytd-comment-view-model#comment',),
    "comment_author_link": ('a#author-text',),
    "comment_text_content": ('#content-text yt-attributed-string',),
    "comment_published_time": ('span#published-time-text',),
    "comment_like_button": (
        'ytd-toggle-button-renderer#like-button button',
        'button[aria-label*="Like this comment" i]',
    ),
    "comment_dislike_button": (
        'ytd-toggle-button-renderer#dislike-button button',
        'button[aria-label*="Dislike this comment" i]',
    ),
    "comment_reply_button": (
        'ytd-button-renderer#reply-button-end button',
        'button[aria-label="Reply"]',
    ),
    "comment_vote_count": (
        '#vote-count-middle',                                   # "20k"
    ),
    "comment_pinned_badge": (
        'ytd-pinned-comment-badge-renderer',
        '#pinned-comment-badge',
    ),
    "comment_heart_creator": (
        'ytd-creator-heart-renderer',
        '#creator-heart-button',
    ),
    "comment_replies_show_button": (
        'ytd-button-renderer#more-replies button',
        'ytd-button-renderer#more-replies-sub-thread button',
        'button[aria-label*="replies" i]',
    ),
    "comment_replies_hide_button": (
        'ytd-button-renderer#less-replies button',
        'button[aria-label="Hide replies"]',
    ),
    "comment_sort_dropdown": (
        # Top / Newest sort dropdown
        'yt-sort-filter-sub-menu-renderer #label',
        'tp-yt-paper-button#label[aria-label*="Sort" i]',
    ),
    "comment_sort_top_option": ('tp-yt-paper-item:has-text("Top")',),
    "comment_sort_newest_option": ('tp-yt-paper-item:has-text("Newest")',),
    "comment_translate_button": (
        'ytd-tri-state-button-view-model.translate-button button',
    ),
    "comment_action_menu_3dot": (
        # 3-dot menu on each comment
        'ytd-comment-view-model #action-menu button[aria-label="Action menu"]',
        'ytd-menu-renderer yt-icon-button#button button[aria-label="Action menu"]',
    ),

    # ════════════════════════════════════════════════════════════════════════
    # SECTION 21: SEARCH (Masthead) — UPDATED V2 (with clear button)
    # ════════════════════════════════════════════════════════════════════════

    "search_input": (
        # ⭐ Multiple stable variants
        'input.ytSearchboxComponentInput.yt-searchbox-input',
        'input.yt-searchbox-input',
        'input[name="search_query"]',
        'input[aria-label*="Search" i]',
        'input[role="combobox"]',
        'yt-searchbox input',
        'ytd-searchbox input#search',
    ),
    "search_submit_button": (
        # ⭐ Magnifying glass button
        'button.ytSearchboxComponentSearchButton',
        'button[aria-label="Search"]:not([aria-label*="voice" i])',
        '#search-icon-legacy',
    ),
    "search_clear_button": (
        # ⭐ NEW (V2) — X button to clear search query
        'button.ytSearchboxComponentClearButton',
        'button[aria-label="Clear search query"]',
        '.ytSearchboxComponentClearButtonWrapper button',
    ),
    "search_voice_button": (
        'button[aria-label*="Search with your voice" i]',
        '#voice-search-button button',
    ),
    "search_suggestions_listbox": (
        'div[role="listbox"]',
        '.ytSearchboxComponentSuggestionsContainer',
    ),
    "search_suggestion_item": (
        '.ytSuggestionComponentSuggestion',
        'div[role="option"]',
    ),
    "search_suggestion_text": (
        '.ytSuggestionComponentBold',
        '.ytSuggestionComponentLeftContainer span',
    ),
    "search_suggestion_thumbnail": (
        '.ytSuggestionComponentVisualSuggestThumbnail',
    ),
    "search_suggestion_remove_button": (
        '.ytSuggestionComponentRemoveLinkClearButton',
        'button[aria-label="Remove"]',
    ),

    # ════════════════════════════════════════════════════════════════════════
    # SECTION 21b: SEARCH RESULTS PAGE
    # ════════════════════════════════════════════════════════════════════════

    "search_results_video": (
        'ytd-video-renderer',
        'ytd-item-section-renderer ytd-video-renderer',
        '#contents ytd-video-renderer',
        'ytd-section-list-renderer ytd-video-renderer',
        'ytd-search ytd-video-renderer',
        'ytm-video-with-metadata-renderer',
    ),
    "search_results_container": (
        'ytd-search',
        'ytd-two-column-search-results-renderer',
        '#contents.ytd-section-list-renderer',
    ),

    # ════════════════════════════════════════════════════════════════════════
    # SECTION 22: TOP MASTHEAD (Logo, Guide, Create, Notifications, Avatar)
    # ════════════════════════════════════════════════════════════════════════

    "masthead_container": (
        'ytd-masthead',
        '#container.ytd-masthead',
    ),
    "youtube_logo_home_link": (
        'a#logo[aria-label="YouTube Home"]',
        'ytd-topbar-logo-renderer a#logo',
    ),
    "hamburger_guide_button": (
        'button[aria-label="Guide"]',
        '#guide-button button',
        'yt-icon-button#guide-button button',
    ),
    "back_button_masthead": (
        '#back-button button',
        'button[aria-label="Back"]',
    ),
    "skip_navigation_button": (
        'button[aria-label="Skip navigation"]',
        '#skip-navigation button',
    ),
    "create_button_topbar": (
        # + Create button
        'button[aria-label="Create"]',
        '#buttons button[aria-label="Create"]',
    ),
    "notifications_topbar_bell": (
        # ⭐ Top-bar bell (different from subscribe bell)
        'ytd-notification-topbar-button-renderer button',
        'ytd-notification-topbar-button-renderer button[aria-label="Notifications"]',
        'button[aria-label="Notifications"]',
    ),
    "notification_count_red_badge": (
        # Red number badge on bell
        '#notification-count',
        '.ytSpecIconBadgeShapeTypeNotification',
        'yt-icon-badge-shape',
    ),
    "account_avatar_button": (
        # Account menu (profile picture top-right)
        'button#avatar-btn',
        'button[aria-label="Account menu"]',
        'ytd-topbar-menu-button-renderer button#avatar-btn',
        'img.yt-spec-avatar-shape__avatar',
        'yt-img-shadow.yt-spec-avatar-shape',
        'ytd-topbar-menu-button-renderer yt-img-shadow',
    ),
    "country_code_text": (
        '#country-code',                              # "IN", "US" etc (usually hidden)
    ),

    # ════════════════════════════════════════════════════════════════════════
    # SECTION 23: RELATED VIDEOS SIDEBAR
    # ════════════════════════════════════════════════════════════════════════

    "related_videos_container": (
        '#related',
        'ytd-watch-next-secondary-results-renderer',
    ),
    "related_video_item": (
        'ytd-compact-video-renderer',
        'ytd-compact-video-renderer #dismissible',
    ),
    "related_video_link": (
        'a.ytd-compact-video-renderer',
        'ytd-compact-video-renderer a#thumbnail',
    ),
    "related_video_title": (
        '#video-title.ytd-compact-video-renderer',
        'span#video-title',
    ),
    "related_video_channel": (
        'ytd-compact-video-renderer ytd-channel-name a',
        '#metadata-line span',
    ),
    "related_video_duration": (
        '#text.ytd-thumbnail-overlay-time-status-renderer',
        'ytd-thumbnail-overlay-time-status-renderer',
    ),

    # ════════════════════════════════════════════════════════════════════════
    # SECTION 24: SHORTS / REELS
    # ════════════════════════════════════════════════════════════════════════

    "shorts_shelf_container": (
        'ytd-reel-shelf-renderer',
        'ytm-shorts-lockup-view-model-v2',
    ),
    "shorts_item_card": (
        'ytm-shorts-lockup-view-model',
        'a.shortsLockupViewModelHostEndpoint',
    ),
    "shorts_title": (
        '.shortsLockupViewModelHostMetadataTitle a',
    ),
    "shorts_views": (
        '.shortsLockupViewModelHostMetadataSubhead',
    ),

    # ════════════════════════════════════════════════════════════════════════
    # SECTION 25: TRANSCRIPT / CONSENT / POPUPS
    # ════════════════════════════════════════════════════════════════════════

    "transcript_show_button": (
        'button[aria-label="Show transcript"]',
        'ytd-video-description-transcript-section-renderer button',
    ),
    "consent_accept": (
        'button[aria-label*="Accept" i]',
        'button[aria-label*="Agree" i]',
    ),
    "consent_reject": (
        'button[aria-label*="Reject" i]',
    ),
    "dismiss_popup_generic": (
        'button[aria-label*="No thanks" i]',
        'button[aria-label*="Not now" i]',
        '#dismiss-button button',
    ),
}


# ════════════════════════════════════════════════════════════════════════════
# 📱 MOBILE WEB SELECTORS (m.youtube.com)
# ════════════════════════════════════════════════════════════════════════════
# (Same as V1 — mobile mostly uses ytp-* like desktop for player)
# ════════════════════════════════════════════════════════════════════════════

MOBILE = {
    "video_element": ('video.html5-main-video', 'video'),
    "player_wrapper": ('ytm-player', '.html5-video-player', '.player-container'),
    "play_button": ('button[aria-label*="Play" i]', '.ytp-play-button'),
    "pause_button": ('button[aria-label*="Pause" i]', '.ytp-play-button[aria-label*="Pause" i]'),
    "ad_skip_button": (
        'button.ytp-ad-skip-button-modern',
        '.ytp-ad-skip-button-modern',
        'button.ytp-skip-ad-button',
        '.ytp-skip-ad-button',
        'button[id^="skip-button"]',
        'div[id^="skip-ad"] button',
        'button[aria-label^="Skip ad" i]',
        'button[aria-label*="Skip Ad" i]',
        '[class*="skip-ad-button"]',
    ),
    "like_button": (
        'ytm-like-button-renderer button',
        'button[aria-label*="like" i]:not([aria-label*="dislike" i])',
        '.slim-video-action-bar button[aria-label*="like" i]',
    ),
    "dislike_button": (
        'ytm-dislike-button-renderer button',
        'button[aria-label*="Dislike" i]',
    ),
    "subscribe_button": (
        'ytm-subscribe-button-renderer button',
        '.subscribe-button-renderer button',
        'button[aria-label*="Subscribe to" i]',
    ),
    "bell_button": (
        'ytm-subscription-notification-toggle-button-renderer button',
        'button[aria-label*="notification" i]',
    ),
    "comments_entry_teaser": (
        'ytm-comments-entry-point-header-renderer',
        '.comments-entry-point-teaser-content',
    ),
    "comment_input": (
        '#contenteditable-root',
        'div[contenteditable="true"]',
    ),
    "search_input": (
        'input[role="combobox"]',
        'input[aria-label="Search YouTube"]',
        'input[type="search"]',
        'input[name="search_query"]',
        'ytm-searchbox input',
        '.searchbox-input',
    ),
    "search_open_button": (
        'button[aria-label="Search YouTube"]',
        'ytm-search-button',
        '.icon-button[aria-label*="Search" i]',
    ),
    "pivot_bar": ('ytm-pivot-bar-renderer',),
    "pivot_home": ('.pivot-bar-item-tab[aria-label*="Home" i]',),
    "pivot_shorts": ('.pivot-bar-item-tab[aria-label*="Shorts" i]',),
    "pivot_subscriptions": ('.pivot-bar-item-tab[aria-label*="Subscriptions" i]',),
    "pivot_library": ('.pivot-bar-item-tab[aria-label*="Library" i]',),
    "shorts_card": ('ytm-shorts-lockup-view-model',),
    "shorts_reel_active": ('.reel-video-in-sequence',),
    "shorts_like_button": ('button[aria-label*="Like this Short" i]',),
}


# ════════════════════════════════════════════════════════════════════════════
# 🤖 ANDROID NATIVE APP SELECTORS (Appium / UiAutomator2)
# ════════════════════════════════════════════════════════════════════════════

ANDROID_APP = {
    "package": "com.google.android.youtube",
    "play_pause_button": "com.google.android.youtube:id/player_control_play_pause_replay_button",
    "video_view": "com.google.android.youtube:id/player_video_view",
    "floaty_bar": "com.google.android.youtube:id/floaty_bar",
    "like_button": "com.google.android.youtube:id/like_button",
    "dislike_button": "com.google.android.youtube:id/dislike_button",
    "subscribe_button": "com.google.android.youtube:id/subscribe_button",
    "bell_button": "com.google.android.youtube:id/notification_button",
    "search_icon": "com.google.android.youtube:id/menu_search",
    "search_input": "com.google.android.youtube:id/search_edit_text",
    "search_clear": "com.google.android.youtube:id/search_clear",
    "skip_ad_button": "com.google.android.youtube:id/skip_ad_button",
    "ad_countdown": "com.google.android.youtube:id/ad_countdown",
    "video_title": "com.google.android.youtube:id/title",
    "channel_name": "com.google.android.youtube:id/channel_name",
    "subscriber_count": "com.google.android.youtube:id/subscriber_count",
    "comment_text": "com.google.android.youtube:id/comment_text",
    "comment_author": "com.google.android.youtube:id/comment_author",
}

ANDROID_APP_XPATH = {
    "like": '//android.widget.Button[contains(@content-desc, "like")]',
    "dislike": '//android.widget.Button[contains(@content-desc, "Dislike")]',
    "subscribe": '//android.widget.Button[@content-desc="Subscribe"]',
    "play": '//android.widget.Button[@content-desc="Play video"]',
    "pause": '//android.widget.Button[@content-desc="Pause video"]',
    "search": '//android.widget.EditText[@text="Search YouTube"]',
}


# ════════════════════════════════════════════════════════════════════════════
# 🎯 JAVASCRIPT DIRECT API (Most reliable — no UI selector needed)
# ════════════════════════════════════════════════════════════════════════════

JS_API = {
    # ─── Video state ─────────────────────────────────────────────────────────
    "is_playing": "!document.querySelector('video').paused && !document.querySelector('video').ended",
    "is_paused": "document.querySelector('video').paused",
    "is_ended": "document.querySelector('video').ended",
    "is_muted": "document.querySelector('video').muted",
    "current_time": "document.querySelector('video').currentTime",
    "total_duration": "document.querySelector('video').duration",
    "watch_percentage": "(document.querySelector('video').currentTime / document.querySelector('video').duration) * 100",
    "playback_rate": "document.querySelector('video').playbackRate",
    "volume": "document.querySelector('video').volume",
    "is_buffering": "document.querySelector('video').readyState < 3",

    # ─── Video controls ──────────────────────────────────────────────────────
    "play": "document.querySelector('video').play()",
    "pause": "document.querySelector('video').pause()",
    "mute": "document.querySelector('video').muted = true",
    "unmute": "document.querySelector('video').muted = false",

    # ─── Ad detection (4 methods) ────────────────────────────────────────────
    "is_ad_class_check": "document.querySelector('.html5-video-player')?.classList.contains('ad-showing')",
    "is_ad_overlay_check": "!!document.querySelector('.video-ads .ytp-ad-player-overlay-layout')",
    "is_ad_module_check": "!!document.querySelector('.video-ads .ytp-ad-module')",
    "can_skip_ad": "!!document.querySelector('button.ytp-ad-skip-button-modern, .ytp-ad-skip-button-modern, button.ytp-skip-ad-button, .ytp-skip-ad-button, button.ytp-ad-skip-button, .ytp-ad-skip-button, button[id^=\"skip-button\"], #skip-button, div[id^=\"skip-ad\"] button, div[id^=\"skip-ad\"], .ytp-ad-player-overlay-layout__skip-or-preview-container button, .ytp-skip-ad button, [class*=\"skip-ad-button\"], [class*=\"skip-button\"], button[aria-label*=\"Skip\" i]')",
    "is_ad_combined": "!!(document.querySelector('.html5-video-player.ad-showing, .html5-video-player.ad-interrupting, #movie_player.ad-showing, .video-ads .ytp-ad-player-overlay-layout, .ytp-ad-module, .ytp-ad-duration-remaining'))",
    "dump_ad_skip_dom": """
        (() => {
            var out = { adShowing: false, skipCandidates: [], countdown: null, playerApi: false };
            var p = document.querySelector('#movie_player, .html5-video-player');
            if (p) {
                out.adShowing = p.classList.contains('ad-showing') || p.classList.contains('ad-interrupting');
                out.playerApi = typeof p.skipAd === 'function';
            }
            var cd = document.querySelector('.ytp-ad-duration-remaining, .ytp-ad-preview-text, .ytp-ad-simple-ad-badge');
            if (cd) out.countdown = (cd.innerText || cd.textContent || '').trim().substring(0, 40);
            var sels = [
                'button.ytp-ad-skip-button-modern', '.ytp-ad-skip-button-modern',
                'button.ytp-skip-ad-button', '.ytp-skip-ad-button',
                'button[id^="skip-button"]', 'div[id^="skip-ad"] button',
                '[class*="skip-ad-button"]', 'button[aria-label*="Skip" i]'
            ];
            var seen = new Set();
            for (var i = 0; i < sels.length; i++) {
                document.querySelectorAll(sels[i]).forEach(function(el) {
                    if (seen.has(el)) return;
                    seen.add(el);
                    var r = el.getBoundingClientRect();
                    out.skipCandidates.push({
                        sel: sels[i],
                        id: el.id || '',
                        className: (el.className || '').toString().substring(0, 80),
                        aria: (el.getAttribute('aria-label') || '').substring(0, 40),
                        text: (el.innerText || '').substring(0, 24),
                        w: Math.round(r.width), h: Math.round(r.height),
                        visible: el.offsetParent !== null && r.width > 0
                    });
                });
            }
            document.querySelectorAll('[id^="skip-button"], [id^="skip-ad"]').forEach(function(el) {
                if (seen.has(el)) return;
                seen.add(el);
                var r = el.getBoundingClientRect();
                out.skipCandidates.push({
                    sel: 'id-scan',
                    id: el.id,
                    className: (el.className || '').toString().substring(0, 80),
                    aria: (el.getAttribute('aria-label') || '').substring(0, 40),
                    text: (el.innerText || '').substring(0, 24),
                    w: Math.round(r.width), h: Math.round(r.height),
                    visible: el.offsetParent !== null && r.width > 0
                });
            });
            return out;
        })()
    """,

    # ─── YouTube Player API (#movie_player) ──────────────────────────────────
    "get_video_data": "document.querySelector('#movie_player').getVideoData()",
    "get_video_url": "document.querySelector('#movie_player').getVideoUrl()",
    "get_player_state": "document.querySelector('#movie_player').getPlayerState()",
    "get_available_qualities": "document.querySelector('#movie_player').getAvailableQualityLevels()",
    "get_current_quality": "document.querySelector('#movie_player').getPlaybackQuality()",
    "get_duration_api": "document.querySelector('#movie_player').getDuration()",
    "get_current_time_api": "document.querySelector('#movie_player').getCurrentTime()",
    "get_volume_api": "document.querySelector('#movie_player').getVolume()",
    "is_muted_api": "document.querySelector('#movie_player').isMuted()",

    "PLAYER_STATES": {
        -1: "unstarted", 0: "ended", 1: "playing",
         2: "paused",    3: "buffering", 5: "video cued"
    },
    "QUALITY_LEVELS": {
        "hd2160": "4K", "hd1440": "1440p", "hd1080": "1080p",
        "hd720":  "720p", "large":  "480p", "medium": "360p",
        "small":  "240p", "tiny":   "144p", "auto":   "Auto"
    },

    # ─── Page metadata extract ───────────────────────────────────────────────
    "get_video_id_from_url": "new URL(window.location.href).searchParams.get('v')",
    "get_channel_name": "document.querySelector('ytd-channel-name a')?.textContent.trim()",
    "get_channel_url": "document.querySelector('ytd-channel-name a')?.href",
    "get_subscriber_count": "document.querySelector('#owner-sub-count')?.textContent.trim()",
    "get_video_title": "document.querySelector('h1.ytd-watch-metadata yt-formatted-string')?.textContent.trim()",
    "get_view_count": "document.querySelector('#view-count')?.textContent.trim()",
    "get_publish_date": "document.querySelector('#date-text')?.textContent.trim()",
    "get_like_count": "document.querySelector('like-button-view-model .ytSpecButtonShapeNextButtonTextContent')?.textContent.trim()",
    "get_comment_count": "document.querySelector('ytd-comments-header-renderer #count')?.textContent.trim()",
    "get_player_title_link": "document.querySelector('.ytp-title-link')?.textContent.trim()",

    # ─── Autoplay control (persistent) ───────────────────────────────────────
    "disable_autoplay_localStorage": """
        (() => {
            try {
                const prefs = JSON.parse(localStorage.getItem('yt-player-autonavstate') || '{}');
                prefs.data = '0';
                localStorage.setItem('yt-player-autonavstate', JSON.stringify(prefs));
                return true;
            } catch(e) { return false; }
        })()
    """,
    "enable_autoplay_localStorage": """
        (() => {
            try {
                const prefs = JSON.parse(localStorage.getItem('yt-player-autonavstate') || '{}');
                prefs.data = '1';
                localStorage.setItem('yt-player-autonavstate', JSON.stringify(prefs));
                return true;
            } catch(e) { return false; }
        })()
    """,

    # ─── NEW (V2): Chapter extraction via JS ─────────────────────────────────
    "get_all_chapters": """
        Array.from(document.querySelectorAll('ytd-macro-markers-list-item-renderer')).map(el => ({
            title: el.querySelector('h4.macro-markers')?.title || '',
            time: el.querySelector('#time')?.textContent.trim() || '',
            href: el.querySelector('a#endpoint')?.href || ''
        }))
    """,

    # ─── NEW (V2): Hashtag extraction ────────────────────────────────────────
    "get_all_hashtags": """
        Array.from(document.querySelectorAll('a[href^="/hashtag/"]')).map(a => a.textContent.trim())
    """,

    # ─── NEW (V2): Current chapter detection ─────────────────────────────────
    "get_current_chapter": "document.querySelector('.ytp-chapter-title-content')?.textContent.trim()",

    # ─── NEW (V2): Volume reading from slider ────────────────────────────────
    "get_volume_from_slider": "document.querySelector('.ytp-volume-panel')?.getAttribute('aria-valuenow')",

    # ─── NEW (V2): Progress bar value reading ────────────────────────────────
    "get_progress_bar_value": "document.querySelector('.ytp-progress-bar')?.getAttribute('aria-valuenow')",
    "get_progress_bar_max": "document.querySelector('.ytp-progress-bar')?.getAttribute('aria-valuemax')",

    # ─── NEW (V2): Detect endscreen videowall (video ended state) ────────────
    "is_endscreen_showing": "!!document.querySelector('.ytp-fullscreen-grid:not([hidden])')",
    "get_endscreen_suggestions": """
        Array.from(document.querySelectorAll('.ytp-modern-videowall-still')).slice(0,12).map(el => ({
            title: el.querySelector('.ytp-modern-videowall-still-info-title')?.textContent.trim() || '',
            author: el.querySelector('.ytp-modern-videowall-still-info-author')?.textContent.trim() || '',
            duration: el.querySelector('.ytp-modern-videowall-still-info-duration')?.textContent.trim() || '',
            views: el.querySelector('.ytp-modern-videowall-still-view-count-and-date-info')?.textContent.trim() || '',
            href: el.href || ''
        }))
    """,

    # ─── NEW (V2): Tap-to-unmute detection ───────────────────────────────────
    "is_tap_to_unmute_showing": "!!document.querySelector('.ytp-unmute:not([style*=\"display: none\"])')",

    # ─── NEW (V2): Subscribe state detection ─────────────────────────────────
    "is_subscribed": "!!document.querySelector('button[aria-label*=\"notification setting\" i]')",

    # ─── NEW (V2): Like/Dislike state ────────────────────────────────────────
    "is_liked": "document.querySelector('like-button-view-model button')?.getAttribute('aria-pressed') === 'true'",
    "is_disliked": "document.querySelector('dislike-button-view-model button')?.getAttribute('aria-pressed') === 'true'",

    # ─── 14-action state checks ─────────────────────────────────────────────
    "autoplay_is_on": "document.querySelector('.ytp-autonav-toggle-button')?.getAttribute('aria-checked') === 'true'",
    "captions_are_on": "document.querySelector('.ytp-subtitles-button')?.getAttribute('aria-pressed') === 'true'",
    "volume_pct": "Math.round((document.querySelector('video')?.volume ?? 1) * 100)",
    "seek_forward_keys": "document.querySelector('video').currentTime += 10",
    "seek_backward_keys": "document.querySelector('video').currentTime -= 10",
    "set_playback_quality": "quality => document.querySelector('#movie_player')?.setPlaybackQuality(quality)",
}


# ════════════════════════════════════════════════════════════════════════════
# 🎯 14 ENGAGEMENT ACTIONS — Engine master map (02_video_watching_engine.md)
# Har action → V2 DESKTOP keys + JS verify + engine file
# ════════════════════════════════════════════════════════════════════════════

FOURTEEN_ACTIONS: dict[str, dict] = {
    "like": {
        "label": "Like",
        "ui_setting": "like",
        "click_keys": ("like_button",),
        "state_keys": ("like_already_pressed",),
        "js_state": "is_liked",
        "keyboard": "none",
        "engine": "agent_manager._do_like → desktop.like",
        "verify_log": "Liked ✓ VERIFIED",
    },
    "dislike": {
        "label": "Dislike",
        "ui_setting": "dislike",
        "click_keys": ("dislike_button",),
        "state_keys": ("dislike_already_pressed",),
        "js_state": "is_disliked",
        "keyboard": "none",
        "engine": "agent_manager._do_dislike → desktop.dislike",
        "verify_log": "Disliked ✓",
    },
    "subscribe": {
        "label": "Subscribe",
        "ui_setting": "subscribe",
        "click_keys": ("subscribe_button",),
        "state_keys": ("subscribed_state_marker", "bell_notification_button"),
        "js_state": "is_subscribed",
        "keyboard": "none",
        "engine": "agent_manager._do_subscribe → desktop.subscribe",
        "verify_log": "Subscribed ✓",
    },
    "bell": {
        "label": "Bell notification",
        "ui_setting": "bell",
        "click_keys": ("bell_notification_button", "bell_all_notifications_option"),
        "state_keys": ("bell_menu_items_dropdown",),
        "js_state": "is_subscribed",
        "keyboard": "none",
        "engine": "agent_manager._do_bell → desktop.toggle_bell / set_bell_level",
        "verify_log": "Bell notification ON ✓",
    },
    "comment": {
        "label": "Comment post",
        "ui_setting": "comment",
        "click_keys": (
            "comment_input_placeholder_click",
            "comment_input_active_typing",
            "comment_submit_button",
        ),
        "state_keys": ("comments_section", "comment_thread"),
        "js_state": None,
        "keyboard": "human_type",
        "engine": "agent_manager._do_comment → desktop.post_comment",
        "verify_log": "[Comment] VERIFIED",
    },
    "comment_like": {
        "label": "Comment like",
        "ui_setting": "commentLikePct",
        "click_keys": ("comment_like_button",),
        "state_keys": ("comment_item_view", "comment_thread"),
        "js_state": None,
        "keyboard": "none",
        "engine": "agent_manager._do_like_comment → desktop.like_comment_first",
        "verify_log": "Comment liked ✓",
    },
    "description_expand": {
        "label": "Description expand",
        "ui_setting": "descriptionExpand",
        "click_keys": ("description_more_button",),
        "state_keys": ("description_text_expanded", "description_less_button"),
        "js_state": None,
        "keyboard": "none",
        "engine": "agent_manager._do_expand_description → desktop.expand_description",
        "verify_log": "Description expanded ✓ VERIFIED",
    },
    "play_pause": {
        "label": "Play / Pause",
        "ui_setting": "pauseProbability / pauseHoldSec",
        "click_keys": ("play_button", "pause_button"),
        "state_keys": ("player_state_classes",),
        "js_state": "is_paused",
        "keyboard": "k",
        "engine": "PlayPauseLimiter + desktop.pause/play OR video.pause()/play()",
        "verify_log": "Resume after pause VERIFIED",
    },
    "volume": {
        "label": "Volume adjust",
        "ui_setting": "volumePct",
        "click_keys": ("mute_button", "volume_panel", "volume_area"),
        "state_keys": ("volume_panel",),
        "js_state": "volume_pct",
        "keyboard": "m / arrow keys",
        "engine": "agent_manager._do_volume_adjust → desktop.set_volume",
        "verify_log": "Volume OK",
    },
    "captions": {
        "label": "Captions toggle",
        "ui_setting": "captionsToggle",
        "click_keys": ("captions_subtitles_button", "captions_window"),
        "state_keys": ("captions_window",),
        "js_state": "captions_are_on",
        "keyboard": "c",
        "engine": "desktop.toggle_captions",
        "verify_log": "[Captions] OK ✓",
    },
    "seek": {
        "label": "Seek forward/back",
        "ui_setting": "seekEnabled",
        "click_keys": ("progress_bar_slider", "scrubber_button_circle"),
        "state_keys": ("play_progress_red_bar",),
        "js_state": "current_time",
        "keyboard": "j / l / arrow keys",
        "engine": "agent_manager._do_seek → desktop.seek OR video.currentTime",
        "verify_log": "Seek ✓ VERIFIED",
    },
    "quality": {
        "label": "Quality change",
        "ui_setting": "videoQuality / qualityChange",
        "click_keys": (
            "settings_gear_button",
            "settings_menu_popup",
            "quality_menu_item",
            "quality_submenu_radio",
        ),
        "state_keys": ("settings_menu_content",),
        "js_state": "get_current_quality",
        "keyboard": "none",
        "engine": "agent_manager._do_quality_change → quality.change_quality",
        "verify_log": "Quality changed ✓",
    },
    "ad_skip": {
        "label": "Ad skip",
        "ui_setting": "adSkipEnabled / adSkipDelaySec",
        "click_keys": ("ad_skip_button",),
        "state_keys": ("ad_detection_combined", "ad_module"),
        "js_state": "can_skip_ad",
        "keyboard": "none",
        "engine": "ad_skip_engine.skip_ads_until_clear",
        "verify_log": "✓ SKIP VERIFIED",
    },
    "autoplay_off": {
        "label": "Autoplay OFF",
        "ui_setting": "hard rule (always)",
        "click_keys": ("autoplay_toggle_button", "autoplay_state_container"),
        "state_keys": ("autoplay_state_container",),
        "js_state": "autoplay_is_on",
        "keyboard": "none",
        "engine": "desktop.disable_autoplay + verify_autoplay_off",
        "verify_log": "Autoplay OFF OK",
    },
}


def fourteen_action_selector_counts() -> dict[str, int]:
    """Return total CSS selectors wired per 14-action (for audit/tests)."""
    out: dict[str, int] = {}
    for key, spec in FOURTEEN_ACTIONS.items():
        n = 0
        for k in spec.get("click_keys", ()):
            v = DESKTOP.get(k)
            if isinstance(v, tuple):
                n += len(v)
        out[key] = n
    return out


# ════════════════════════════════════════════════════════════════════════════
# 🛠️ HELPER FUNCTIONS (Copy into your bot)
# ════════════════════════════════════════════════════════════════════════════

HELPER_FUNCTIONS_EXAMPLE = '''
async def click_with_fallback(tab, selector_tuple, timeout=5):
    """Try each selector in order, click first found."""
    for selector in selector_tuple:
        try:
            el = await tab.query_selector(selector)
            if el:
                await el.click()
                return True
        except Exception:
            continue
    return False


async def find_with_fallback(tab, selector_tuple):
    for selector in selector_tuple:
        try:
            el = await tab.query_selector(selector)
            if el:
                return el
        except Exception:
            continue
    return None


async def is_present(tab, selector_tuple):
    return (await find_with_fallback(tab, selector_tuple)) is not None


async def get_text(tab, selector_tuple):
    el = await find_with_fallback(tab, selector_tuple)
    if el:
        return (await el.text_content() or "").strip()
    return None


# ─── REAL USAGE EXAMPLES (V2 with new selectors) ──────────────────

# Skip ad with all 8 fallback variants
await click_with_fallback(tab, DESKTOP['ad_skip_button'])

# Like only if not already liked
if not await tab.evaluate(JS_API['is_liked']):
    await click_with_fallback(tab, DESKTOP['like_button'])

# Subscribe only if not subscribed (use JS check — cleaner)
if not await tab.evaluate(JS_API['is_subscribed']):
    await click_with_fallback(tab, DESKTOP['subscribe_button'])

# Dismiss "Tap to unmute" prompt
if await tab.evaluate(JS_API['is_tap_to_unmute_showing']):
    await click_with_fallback(tab, DESKTOP['tap_to_unmute_prompt'])

# Get all chapters as JSON
chapters = await tab.evaluate(JS_API['get_all_chapters'])
print(chapters)  # [{title:'Intro', time:'0:00', href:'...'}, ...]

# Click specific chapter by title
for selector in DESKTOP['chapter_item_link']:
    chapter_links = await tab.query_selector_all(selector)
    for link in chapter_links:
        title_el = await link.query_selector('h4.macro-markers')
        if title_el and 'banking' in (await title_el.text_content() or '').lower():
            await link.click()
            break

# Toggle autoplay OFF
await tab.evaluate(JS_API['disable_autoplay_localStorage'])

# Get current chapter (e.g., "Introduction to Banking Tycoon")
chapter = await tab.evaluate(JS_API['get_current_chapter'])

# Click Join (membership) button if available
if await is_present(tab, DESKTOP['join_channel_button']):
    await click_with_fallback(tab, DESKTOP['join_channel_button'])

# Click Download button (if available for the video)
if await is_present(tab, DESKTOP['download_button']):
    await click_with_fallback(tab, DESKTOP['download_button'])

# Search YouTube
search_box = await find_with_fallback(tab, DESKTOP['search_input'])
await search_box.click()
await search_box.type('credit card 2026')
await click_with_fallback(tab, DESKTOP['search_submit_button'])

# Clear search and start fresh
await click_with_fallback(tab, DESKTOP['search_clear_button'])
'''


if __name__ == "__main__":
    total_desktop_cats = len(DESKTOP)
    total_desktop_sels = sum(
        len(v) if isinstance(v, tuple) else (sum(1 for _ in v.values()) if isinstance(v, dict) else 1)
        for v in DESKTOP.values()
    )
    total_mobile_cats = len(MOBILE)
    total_mobile_sels = sum(len(v) if isinstance(v, tuple) else 1 for v in MOBILE.values())
    total_android = len(ANDROID_APP) + len(ANDROID_APP_XPATH)
    total_js = len([k for k in JS_API if not k.endswith('_STATES') and not k.endswith('_LEVELS')])

    print("═" * 70)
    print("   MMB AGENT — YouTube Selectors Master File V2 (SUPER COMPLETE)")
    print("═" * 70)
    print(f"  🖥️  Desktop Web:    {total_desktop_cats} categories, {total_desktop_sels} selectors")
    print(f"  📱 Mobile Web:     {total_mobile_cats} categories, {total_mobile_sels} selectors")
    print(f"  🤖 Android App:    {total_android} selectors (Appium)")
    print(f"  🎯 JS Direct API:  {total_js} commands")
    print("═" * 70)
    print(f"  📦 GRAND TOTAL: {total_desktop_sels + total_mobile_sels + total_android + total_js} permanent selectors")
    print("═" * 70)
