import urllib.request, json
base = "http://localhost:5000"
for path in ["/api/jobs", "/api/profiles"]:
    try:
        with urllib.request.urlopen(base + path, timeout=3) as r:
            d = json.loads(r.read())
        if "jobs" in d:     print("GET " + path + " -> jobs: "     + str(len(d["jobs"])))
        if "profiles" in d: print("GET " + path + " -> profiles: " + str(len(d["profiles"])))
        if "error" in d:    print("GET " + path + " -> ERROR: "    + str(d["error"]))
    except Exception as e:
        print("GET " + path + " -> FAIL: " + str(e))
