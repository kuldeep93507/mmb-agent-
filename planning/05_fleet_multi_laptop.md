# Plan — Fleet Mode (5 Laptops, Ek Saath Control)

> **Status: PLAN ONLY — research done, no code yet.** Owner ne approve kiya to
> phase-by-phase banayenge. Rule: existing single-machine kaam todna nahi hai —
> Fleet mode ek alag layer ke roop mein add hoga (optional, off by default).

## Goal
Ek central screen se **5 (ya zyada) laptop ek saath control** karna — same
action (Like/Subscribe/Comment/Shuffle/Engagement) sabhi selected laptops pe
**parallel** chale, aur sab ka live status ek hi jagah dikhe.

## Research — architecture pattern (industry standard)
- **Centralized orchestration**: ek "Controller" (manager) + har machine pe ek
  "Agent" (worker). Controller high-level command deta hai, har agent apne
  laptop pe locally execute karta hai. Pura plan ek jagah visible — debug easy.
  (Source: AI agent fleet management; Rancher Fleet controller+agent model.)
- **Connectivity**: **Tailscale** — har laptop ko ek stable `100.x.y.z` IP deta
  hai, alag-alag network/WiFi/firewall ke piche ho to bhi connect, WireGuard se
  encrypted. 5 laptops kahin bhi ho — ek private network ban jaata hai.
  (Source: Tailscale docs — features, connect-to-devices, security.)

Sources:
- https://fast.io/resources/ai-agent-fleet-management/
- https://fleet.rancher.io/explanations/architecture
- https://tailscale.com/docs/features
- https://tailscale.com/kb/1452/connect-to-devices

---

## Kya-kya banega (components)

### 1. Agent (har laptop pe)
- **Ye already ~exist karta hai** = current `server_python/main.py` backend.
  Har laptop pe yahi chalega, apne local profiles control karega.
- **Naya kaam:** har agent ko ek **machine identity** do (machineId + name +
  Tailscale IP), aur ek `/api/agent/info` endpoint jo bataye: kaunsa laptop,
  kitne profiles, kya chal raha hai. (Choti addition — existing backend reuse.)

### 2. Controller (central dashboard — ek laptop "master" banega)
- Ek nayi UI layer + ek light "fleet router" jo saare agents se baat kare.
- **Machines / Fleet page (UI):**
  - Laptops add/remove (naam + Tailscale IP:3100 + API key)
  - Har machine ka live status: online/offline, running profiles, errors
  - "All / select machines" checkbox
- **Broadcast/fan-out layer (backend):**
  - Ek command → parallel mein selected agents ko bheje (async fan-out)
  - Har agent ka response collect kare, aggregate kare
  - Timeout + retry per machine (ek laptop down ho to baaki na ruke)

### 3. Aggregated views
- **Fleet Dashboard**: total profiles across 5 laptops, total running,
  combined analytics (har laptop ka data merge)
- **Fleet Monitor**: live — kaunse laptop pe kaunsa profile kya kar raha

### 4. Network setup (one-time, owner side)
- Saare 5 laptop pe **Tailscale install + same account login** → har ek ko
  `100.x` IP milega
- Har laptop pe backend `--host 0.0.0.0` pe chale (already `vite --host` jaisa)
- **Same API key** sab pe (auth)
- Firewall: port 3100 allow (Tailscale ke through automatically secure)

---

## Security (zaroori)
- Sirf Tailscale network ke andar reachable (public internet pe expose NAHI)
- Har request pe API key (already hai)
- Controller → Agent calls encrypted (Tailscale WireGuard)
- Ek "read-only vs control" mode — galti se sab laptops pe destructive action na ho

---

## Phases (chhote, safe, ek-ek karke)

**Phase 0 — Network proof (no code)**
Tailscale 2 laptop pe lagao, ek laptop se dusre ka `http://100.x:3100/api/health`
khulta hai confirm karo. Ye base hai — ye chala to fleet possible hai.

**Phase 1 — Agent identity**
Har backend ko machineId/name do + `/api/agent/info` endpoint. (Single machine
pe bhi safe — kuch todta nahi.)

**Phase 2 — Machines registry (UI)**
Nayi "Fleet" page — laptops add karo (IP + key), online/offline status dikhe.
Abhi sirf status, koi action nahi.

**Phase 3 — Broadcast layer**
Controller se ek action → selected agents ko parallel bheje + results aggregate.
Pehle safe action (jaise "status refresh"), phir engagement/shuffle.

**Phase 4 — Aggregated dashboard + monitor**
Saare laptops ka combined view — ek screen pe sab.

**Phase 5 — Polish**
Per-machine retry/timeout, partial-failure handling, "select all / groups".

---

## Reuse vs New
| Cheez | Status |
|------|--------|
| Per-laptop profile control (backend) | ✅ already hai — reuse |
| Engagement / Shuffle / actions | ✅ already hai — reuse per agent |
| Machine identity + /api/agent/info | 🔨 naya (chhota) |
| Fleet page (UI) | 🔨 naya |
| Broadcast/fan-out router | 🔨 naya (core) |
| Aggregated dashboard/monitor | 🔨 naya |
| Tailscale network | ⚙️ owner setup (no code) |

## Important honesty
- Ye ek **naya optional layer** hai — current single-laptop sab kuch waise hi
  chalega, fleet off rahega jab tak owner use na kare.
- Sabse pehli + zaroori cheez = **network (Tailscale)**. Wo chala, baaki software
  side incrementally banega.
- Koi existing working code (locked YouTube actions, profiles, engagement) NAHI
  chhedenge.
</content>
