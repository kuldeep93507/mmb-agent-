# Automation Engine Fixes — Bugfix Design

## Overview

This design addresses 8 bugs in the MMB-AGENT YouTube automation engine spanning reliability (infinite retry loop, zombie processes), correctness (race condition, wrong analytics values, stale array reference), search accuracy (quoted query false negatives), maintainability (hardcoded API key duplication, dead code). The fix strategy is minimal and targeted: each bug gets a surgical change that resolves the defect without altering surrounding behavior.

## Glossary

- **Bug_Condition (C)**: The set of inputs/states that trigger one of the 8 identified defects
- **Property (P)**: The desired correct behavior when the bug condition holds — retry terminates, browser closes, correct video clicked, etc.
- **Preservation**: Existing behavior that must remain unchanged — successful first-attempt flows, mouse-click engagement, normal video completion
- **ProfileAgent**: Class in `server/agent.cjs` managing CDP connection and human-like YouTube watching per MoreLogin profile
- **Worker**: Isolated thread in `server/worker.cjs` that starts a profile, connects CDP, and watches videos sequentially
- **Orchestrator**: Pool manager in `server/orchestrator.cjs` that spawns workers, handles crash recovery, and auto-restarts
- **SearchEngine**: Module in `server/searchEngine.cjs` providing smart video discovery with escalation search and multi-source traffic
- **trackEngagement**: Helper function that POSTs analytics events to the backend API

## Bug Details

### Bug Condition

The 8 bugs manifest under distinct conditions across the automation pipeline. The composite bug condition is:

**Formal Specification:**
```
FUNCTION isBugCondition(input)
  INPUT: input of type { context: string, state: object }
  OUTPUT: boolean

  // Bug 1: Infinite retry loop
  IF input.context == 'searchAndWatch'
     AND input.state.searchFailed == true
     AND input.state.retryCount < maxRetries
  THEN RETURN true

  // Bug 2: Zombie browser
  IF input.context == 'workerCleanup'
     AND input.state.disconnectThrows == true
  THEN RETURN true

  // Bug 3: Race condition in findAndVerifyVideo
  IF input.context == 'findAndVerifyVideo'
     AND input.state.domChangedBetweenCalls == true
     AND input.state.matchIndex != actualIndex
  THEN RETURN true

  // Bug 4: Quoted query false negatives
  IF input.context == 'searchGoogle' OR input.context == 'searchBing'
     AND input.state.videoTitle CONTAINS_ANY ['[', ']', '(', ')', '{', '}', ':', '!', '?']
  THEN RETURN true

  // Bug 5: Hardcoded API key duplication
  IF input.context == 'apiKeyUpdate'
     AND input.state.updatedFiles != ['index.cjs', 'worker.cjs']
  THEN RETURN true

  // Bug 6: Stale videos array on restart
  IF input.context == 'orchestratorRestart'
     AND input.state.workerCrashed == true
     AND input.state.completedCount > 0
  THEN RETURN true

  // Bug 7: Missing watchTime value
  IF input.context == 'watchByUrl'
     AND input.state.trackEngagementCalled == true
     AND input.state.action == 'watchTime'
  THEN RETURN true

  // Bug 8: Unused seed variable
  IF input.context == 'watchVideo'
     AND input.state.seedDeclared == true
     AND input.state.seedUsed == false
  THEN RETURN true

  RETURN false
END FUNCTION
```

### Examples

- **Bug 1**: `searchAndWatch("My Video", "Channel")` fails 3 times → `_isRetrying` is set to `true` before recursive call, but cleared to `false` at the top of the next call, so `retryCount` resets to 0 → infinite loop
- **Bug 2**: Worker finishes videos, `agent.disconnect()` throws "Target closed" → catch block skips `moreloginRequest('/api/env/close')` → browser process stays alive consuming 200-500MB RAM
- **Bug 3**: `page.evaluate()` finds match at index 2, then `page.$$()` returns elements where index 2 is now a different video (ad inserted above) → wrong video clicked
- **Bug 4**: Title `"React Tutorial [2024] (Complete)"` → query becomes `"Channel" "React Tutorial [2024] (Complete)" youtube` → Google returns 0 results due to brackets inside quotes
- **Bug 6**: Worker watches 5/10 videos, crashes → orchestrator calls `videos.slice(5)` on the original 10-video array → correct. But on second crash after watching 2 more, `completedCount` is still from `state.results?.watched || 0` which is 0 (reset on restart) → replays from beginning
- **Bug 7**: `trackEngagement(profileId, 'watchTime')` → value defaults to `1` → analytics shows 1 second instead of actual 180 seconds watched

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- `searchAndWatch()` succeeding on first attempt returns `true` and tracks analytics normally
- `agent.disconnect()` succeeding without error still closes MoreLogin browser and reports completion
- `findAndVerifyVideo()` finding exact match in first visible results (no DOM change) clicks correctly
- Video titles with only alphanumeric characters and spaces search successfully via Google/Bing
- MoreLogin API authentication continues working with the same key value
- Workers completing all videos without crashing report results normally
- `searchAndWatch()` tracking watch time continues passing correct seconds value
- `watchVideo()` generating varied human-like behavior patterns per call continues working

**Scope:**
All inputs that do NOT trigger any of the 8 bug conditions should be completely unaffected by these fixes. This includes:
- Successful first-attempt video searches and watches
- Normal worker lifecycle (start → watch all → done)
- Videos with simple titles on any search engine
- Profiles that never crash during a session
- The `searchAndWatch` path's existing correct `trackEngagement` calls

## Hypothesized Root Cause

Based on code analysis, the root causes are:

1. **Infinite Retry Loop (agent.cjs:searchAndWatch)**: The `_isRetrying` flag is set to `true` before the recursive call, but at the top of `searchAndWatch()`, the code checks `if (!this._isRetrying) { this.retryCount = 0; }` then immediately sets `this._isRetrying = false`. This means on the recursive entry, `_isRetrying` is `true` so `retryCount` is preserved — but then it's cleared. On the NEXT recursive call from the catch block, `_isRetrying` was already cleared, so `retryCount` resets to 0. The flag-based approach is fundamentally flawed for recursive retry tracking.

2. **Zombie Browser (worker.cjs:runWorker)**: The cleanup section at the end of `runWorker()` calls `await agent.disconnect()` followed by `await moreloginRequest('/api/env/close')`. If `disconnect()` throws, execution jumps past the `close` call. There is no `try/finally` wrapping these two operations.

3. **Race Condition (searchEngine.cjs:findAndVerifyVideo)**: The function first calls `page.evaluate()` to scan all `ytd-video-renderer` elements and find a match by index, then separately calls `page.$$('ytd-video-renderer a#video-title')` to get element handles. Between these two calls, YouTube's lazy loading or ad injection can shift element positions.

4. **Quoted Query False Negatives (searchEngine.cjs:searchBing/searchGoogle)**: The query template `"${channelName}" "${videoTitle}" youtube` wraps the full title in double quotes. Search engines interpret quoted strings as exact-match phrases, and special characters like `[](){}` break the phrase parsing.

5. **Hardcoded API Key (index.cjs + worker.cjs)**: Both files declare `const MORELOGIN_API_KEY = 'dbc21d41...'` independently. No shared config module exists.

6. **Stale Videos Array (orchestrator.cjs:startWorker error handler)**: The error handler closure captures the `videos` parameter from the outer `startWorker()` call. It computes `remainingVideos = videos.slice(completedCount)` but `completedCount` comes from `state.results?.watched || 0`. After restart, `state.results` is reset to `null`, so on a second crash `completedCount` is 0 again.

7. **Missing watchTime Value (agent.cjs:watchByUrl)**: Line calls `trackEngagement(this.profileId, 'watchTime')` without the third `value` parameter. The `trackEngagement` function defaults missing value to `1`.

8. **Unused Seed (agent.cjs:watchVideo)**: `const seed = Math.random()` is declared but never referenced. The subsequent behavior variables (`commentScrollChance`, `relatedPeekChance`, etc.) each call `Math.random()` independently.

## Correctness Properties

Property 1: Bug Condition - Retry Termination

_For any_ call to `searchAndWatch()` where the search fails on every attempt, the retry mechanism SHALL terminate after exactly `maxRetries` attempts (default 3) and return `false`, regardless of whether retries occur via the success-path failure or the catch-block failure.

**Validates: Requirements 2.1**

Property 2: Bug Condition - Browser Cleanup Guarantee

_For any_ worker cleanup sequence where `agent.disconnect()` throws an error, the system SHALL still call `moreloginRequest('/api/env/close')` to terminate the MoreLogin browser process, preventing zombie processes.

**Validates: Requirements 2.2**

Property 3: Bug Condition - Atomic Find-and-Click

_For any_ call to `findAndVerifyVideo()` that identifies a matching video, the system SHALL find and click the element within a single `page.evaluate()` execution context, eliminating the window for DOM mutations between identification and action.

**Validates: Requirements 2.3**

Property 4: Bug Condition - Special Character Query Handling

_For any_ video title containing special characters `[](){}:!?`, the Google/Bing search query SHALL strip those characters and avoid wrapping the title in double quotes, producing a natural keyword query that returns results.

**Validates: Requirements 2.4**

Property 5: Bug Condition - Single API Key Source

_For any_ module requiring the MoreLogin API key, the system SHALL import it from a single centralized source, ensuring updates propagate to all consumers automatically.

**Validates: Requirements 2.5**

Property 6: Bug Condition - Correct Resume on Restart

_For any_ worker restart after a crash, the orchestrator SHALL use the remaining videos stored in `workerState` (updated after each successful watch) rather than re-slicing the original array, ensuring no video is replayed.

**Validates: Requirements 2.6**

Property 7: Bug Condition - Accurate Watch Time Tracking

_For any_ call to `watchByUrl()` that completes successfully, the `trackEngagement` call for `'watchTime'` SHALL pass the actual watch duration in seconds as the value parameter.

**Validates: Requirements 2.7**

Property 8: Bug Condition - Dead Code Removal

_For any_ execution of `watchVideo()`, there SHALL be no unused variable declarations; the `seed` variable SHALL be removed.

**Validates: Requirements 2.8**

Property 9: Preservation - Normal Operation Unchanged

_For any_ input where none of the 8 bug conditions hold (successful first-attempt searches, clean disconnects, simple titles, no crashes), the fixed functions SHALL produce exactly the same behavior and output as the original functions.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8**

## Fix Implementation

### Changes Required

**File**: `server/agent.cjs`

**Function**: `searchAndWatch()`

**Specific Changes**:
1. **Replace flag-based retry with depth parameter**: Remove `_isRetrying` flag logic. Add an optional `_retryDepth = 0` parameter to `searchAndWatch()`. On each retry, pass `_retryDepth + 1`. Check `if (_retryDepth >= this.maxRetries) return false` at the top instead of using `retryCount`.

---

**File**: `server/worker.cjs`

**Function**: `runWorker()` — cleanup section

**Specific Changes**:
2. **Wrap disconnect + close in try/finally**: Replace the sequential `await agent.disconnect()` / `await moreloginRequest('/api/env/close')` with a `try { await agent.disconnect() } finally { await moreloginRequest('/api/env/close') }` pattern.

---

**File**: `server/searchEngine.cjs`

**Function**: `findAndVerifyVideo()`

**Specific Changes**:
3. **Atomic find-and-click in single evaluate**: Replace the two-step approach (evaluate to find index → $$ to get handles → click by index) with a single `page.evaluate()` that finds the matching element AND clicks it via `element.click()` inside the browser context. Return `true/false` from evaluate.

---

**File**: `server/searchEngine.cjs`

**Functions**: `searchBing()`, `searchGoogle()`

**Specific Changes**:
4. **Sanitize query strings**: Before constructing the query, strip special characters `[](){}:!?—–` from `videoTitle`. Remove the double-quote wrapping around the title. Use format: `channelName videoTitle youtube` (unquoted, cleaned keywords).

---

**File**: `server/config.cjs` (new file)

**Specific Changes**:
5. **Create centralized config**: Create `server/config.cjs` exporting `MORELOGIN_API_KEY` (read from `process.env.MORELOGIN_API_KEY` with fallback to the current hardcoded value). Update `server/index.cjs` and `server/worker.cjs` to `require('./config.cjs')` instead of declaring the key locally.

---

**File**: `server/orchestrator.cjs`

**Function**: `startWorker()` — error handler

**Specific Changes**:
6. **Store remaining videos in workerState**: Add `remainingVideos: [...videos]` to `workerState`. On each `'status'` message with progress update, slice the remaining array. In the error handler, use `state.remainingVideos` instead of `videos.slice(completedCount)`.

---

**File**: `server/agent.cjs`

**Function**: `watchByUrl()`

**Specific Changes**:
7. **Pass actual watch time value**: Change `trackEngagement(this.profileId, 'watchTime')` to `trackEngagement(this.profileId, 'watchTime', Math.round(watchTime / 1000))`.

---

**File**: `server/agent.cjs`

**Function**: `watchVideo()`

**Specific Changes**:
8. **Remove unused seed variable**: Delete the line `const seed = Math.random();`.

## Testing Strategy

### Validation Approach

The testing strategy follows a two-phase approach: first, surface counterexamples that demonstrate the bugs on unfixed code, then verify the fixes work correctly and preserve existing behavior.

### Exploratory Bug Condition Checking

**Goal**: Surface counterexamples that demonstrate the bugs BEFORE implementing the fix. Confirm or refute the root cause analysis. If we refute, we will need to re-hypothesize.

**Test Plan**: Write unit tests that exercise each bug condition in isolation. Run these tests on the UNFIXED code to observe failures and confirm root causes.

**Test Cases**:
1. **Retry Loop Test**: Mock `openVideoSmart` to always fail, call `searchAndWatch()`, assert it returns within `maxRetries` calls (will hang/timeout on unfixed code)
2. **Zombie Browser Test**: Mock `agent.disconnect()` to throw, verify `moreloginRequest('/api/env/close')` is still called (will fail on unfixed code)
3. **Race Condition Test**: Mock `page.evaluate()` to return index 2, mock `page.$$()` to return shifted elements, verify wrong element is clicked (demonstrates bug on unfixed code)
4. **Quoted Query Test**: Pass title `"React [2024] (Guide)"` to `searchBing()`, capture the query string, assert it doesn't contain `[]()` inside quotes (will fail on unfixed code)
5. **Stale Array Test**: Simulate crash-restart-crash sequence, verify second restart doesn't replay already-watched videos (will fail on unfixed code)
6. **Missing Value Test**: Mock `trackEngagement`, call `watchByUrl()`, assert `watchTime` action receives actual seconds not `1` (will fail on unfixed code)

**Expected Counterexamples**:
- Bug 1: `searchAndWatch` never returns (infinite recursion until stack overflow)
- Bug 2: `moreloginRequest('/api/env/close')` never called when disconnect throws
- Bug 4: Query string contains `"React [2024] (Guide)"` with special chars inside quotes
- Bug 7: `trackEngagement` called with `('profileId', 'watchTime')` — no third argument

### Fix Checking

**Goal**: Verify that for all inputs where the bug condition holds, the fixed function produces the expected behavior.

**Pseudocode:**
```
FOR ALL input WHERE isBugCondition(input) DO
  result := fixedFunction(input)
  ASSERT expectedBehavior(result)
END FOR
```

Specifically:
- Bug 1: `searchAndWatch_fixed()` with always-failing search → returns `false` after exactly 3 retries
- Bug 2: `runWorker_fixed()` with throwing disconnect → `moreloginRequest('/api/env/close')` called
- Bug 3: `findAndVerifyVideo_fixed()` with shifting DOM → still clicks correct video
- Bug 4: `searchBing_fixed()` with special-char title → query is clean keywords, no quotes around title
- Bug 5: Both files import from `config.cjs` → single update point
- Bug 6: Crash-restart-crash → second restart uses stored remaining videos
- Bug 7: `watchByUrl_fixed()` → `trackEngagement` receives actual seconds
- Bug 8: `watchVideo_fixed()` → no `seed` variable in function body

### Preservation Checking

**Goal**: Verify that for all inputs where the bug condition does NOT hold, the fixed function produces the same result as the original function.

**Pseudocode:**
```
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT originalFunction(input) = fixedFunction(input)
END FOR
```

**Testing Approach**: Property-based testing is recommended for preservation checking because:
- It generates many test cases automatically across the input domain
- It catches edge cases that manual unit tests might miss
- It provides strong guarantees that behavior is unchanged for all non-buggy inputs

**Test Plan**: Observe behavior on UNFIXED code first for normal inputs, then write property-based tests capturing that behavior.

**Test Cases**:
1. **Successful Search Preservation**: Generate random video titles (alphanumeric only), verify `searchAndWatch` flow is identical before/after fix
2. **Clean Disconnect Preservation**: Verify worker cleanup with non-throwing disconnect still calls close in same order
3. **Simple Title Query Preservation**: Generate titles without special chars, verify Google/Bing query format is unchanged
4. **No-Crash Worker Preservation**: Verify orchestrator with no crashes never touches `remainingVideos` logic
5. **searchAndWatch watchTime Preservation**: Verify the existing correct `trackEngagement('watchTime', seconds)` call in `searchAndWatch` is unchanged

### Unit Tests

- Test `searchAndWatch` retry termination with mocked search failure
- Test worker cleanup with mocked disconnect error
- Test `findAndVerifyVideo` with mocked DOM that shifts between calls
- Test query sanitization for titles with various special characters
- Test config module exports correct API key from env or fallback
- Test orchestrator restart uses stored remaining videos
- Test `watchByUrl` passes correct watch time value
- Test `watchVideo` has no unused variables (static analysis / lint)

### Property-Based Tests

- Generate random retry depths (0 to 100) and verify `searchAndWatch` always terminates within `maxRetries`
- Generate random video titles with arbitrary Unicode/special characters and verify query sanitization produces valid search strings
- Generate random crash sequences (0-5 crashes per worker) and verify no video is watched twice
- Generate random watch durations and verify `trackEngagement` always receives the correct seconds value

### Integration Tests

- End-to-end test: start worker with 5 videos, simulate crash after video 3, verify restart watches only videos 4-5
- End-to-end test: run `searchAndWatch` with a title containing `[brackets]`, verify search engine returns results
- End-to-end test: verify no zombie `chrome.exe` processes remain after worker completes with disconnect error
