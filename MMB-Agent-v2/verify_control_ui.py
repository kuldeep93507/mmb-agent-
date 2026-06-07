html = open("dashboard/templates/index.html", encoding="utf-8").read()
checks = [
    ("botBanner div",       "botBanner"),
    ("botStart function",   "function botStart"),
    ("botStop function",    "function botStop"),
    ("fetchBotStatus",      "function fetchBotStatus"),
    ("renderProfileGrid",   "function renderProfileGrid"),
    ("appendLogs",          "function appendLogs"),
    ("liveLog box",         "liveLog"),
    ("profileGrid div",     "profileGrid"),
    ("topBotDot",           "topBotDot"),
    ("Control tab panel",   "tab-control"),
    ("bot-banner CSS",      ".bot-banner"),
    ("profile-card CSS",    ".profile-card"),
    ("log-box CSS",         ".log-box"),
    ("bot_status endpoint", "api/bot/status"),
    ("start bot endpoint",  "api/bot/start"),
    ("stop bot endpoint",   "api/bot/stop"),
]
fails = 0
for name, token in checks:
    ok = token in html
    if not ok:
        fails += 1
    print(("  [PASS] " if ok else "  [FAIL] ") + name)
print()
print("ALL PASS" if fails == 0 else f"FAILS: {fails}")
