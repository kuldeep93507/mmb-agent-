import json, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

for f in ["core/Orchestrator.py", "run_batch.py", "behavior/youtube/desktop.py"]:
    compile(open(f, encoding="utf-8").read(), f, "exec")
    print(f"[PASS] {f} — syntax OK")

cfg = json.load(open("data/jobs.json", encoding="utf-8"))
profiles = cfg.get("profiles", [])
print(f"[PASS] jobs.json — {len(profiles)} profiles:")
for p in profiles:
    print(f"  {p['profile_id'][:8]}... | {p['platform']}")
jobs = cfg.get("jobs", [])
print(f"[PASS] jobs — {len(jobs)} job(s) | video={jobs[0]['video_id']} | referrer_search={jobs[0].get('referrer_search')}")
print("\nALL OK — batch ready to run!")
