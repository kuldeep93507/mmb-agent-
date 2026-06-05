# Implementation Plan

## Overview

This task list implements fixes for 8 bugs in the MMB-AGENT YouTube automation engine using the exploratory bugfix workflow: write tests BEFORE fix to understand the bug, write preservation tests for non-buggy behavior, implement the fix, then validate everything passes.

## Tasks

- [x] 1. Write bug condition exploration tests
  - **Property 1: Bug Condition** - Automation Engine Defects (Infinite Retry, Zombie Browser, Race Condition, Query False Negatives, Missing WatchTime Value)
  - **CRITICAL**: These tests MUST FAIL on unfixed code - failure confirms the bugs exist
  - **DO NOT attempt to fix the tests or the code when they fail**
  - **NOTE**: These tests encode the expected behavior - they will validate the fixes when they pass after implementation
  - **GOAL**: Surface counterexamples that demonstrate the 8 bugs exist
  - **Scoped PBT Approach**: For each deterministic bug, scope the property to the concrete failing case(s) to ensure reproducibility
  - Test 1.1: Mock `openVideoSmart` to always return `{ success: false }`, call `searchAndWatch()`, assert it returns `false` within `maxRetries` (3) attempts and does NOT recurse infinitely (from Bug Condition: `input.context == 'searchAndWatch' AND input.state.searchFailed == true`)
  - Test 1.2: Mock `agent.disconnect()` to throw an error, run worker cleanup, assert `moreloginRequest('/api/env/close')` is still called (from Bug Condition: `input.context == 'workerCleanup' AND input.state.disconnectThrows == true`)
  - Test 1.3: Mock `page.evaluate()` to return match at index N, mock `page.$$()` to return shifted elements (simulating DOM mutation), verify the wrong element gets clicked (from Bug Condition: `input.context == 'findAndVerifyVideo' AND input.state.domChangedBetweenCalls == true`)
  - Test 1.4: Pass title containing `[](){}:!?` to `searchBing()`/`searchGoogle()`, capture the constructed query string, assert it does NOT contain special characters inside double quotes (from Bug Condition: `input.state.videoTitle CONTAINS_ANY ['[', ']', '(', ')', '{', '}', ':', '!', '?']`)
  - Test 1.5: Simulate crash-restart-crash sequence in orchestrator, verify second restart replays already-watched videos (from Bug Condition: `input.context == 'orchestratorRestart' AND input.state.completedCount > 0`)
  - Test 1.6: Mock `trackEngagement`, call `watchByUrl()` to completion, assert `trackEngagement` for `'watchTime'` action receives actual seconds NOT default value `1` (from Bug Condition: `input.context == 'watchByUrl' AND input.state.action == 'watchTime'`)
  - Test 1.7: Inspect `watchVideo()` function body, assert `seed` variable is declared but never referenced (static analysis — from Bug Condition: `input.context == 'watchVideo' AND input.state.seedUsed == false`)
  - Run tests on UNFIXED code
  - **EXPECTED OUTCOME**: Tests FAIL (this is correct - it proves the bugs exist)
  - Document counterexamples found:
    - Bug 1: `searchAndWatch` never returns (infinite recursion / timeout)
    - Bug 2: `moreloginRequest('/api/env/close')` never called when disconnect throws
    - Bug 3: Element at shifted index gets clicked instead of correct match
    - Bug 4: Query string contains `"React [2024] (Guide)"` with special chars inside quotes
    - Bug 5: Second restart replays videos from beginning (completedCount resets to 0)
    - Bug 6: `trackEngagement` called with `('profileId', 'watchTime')` — no third argument (value defaults to 1)
    - Bug 7: `const seed = Math.random()` exists but is never used
  - Mark task complete when tests are written, run, and failures are documented
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8_

- [ ] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** - Normal Operation Unchanged for All Non-Buggy Inputs
  - **IMPORTANT**: Follow observation-first methodology
  - Observe: `searchAndWatch("Valid Title", "Channel")` with mocked successful `openVideoSmart` returns `true` and calls `trackEngagement` with correct watch time on unfixed code
  - Observe: Worker cleanup with non-throwing `agent.disconnect()` calls `moreloginRequest('/api/env/close')` in correct order on unfixed code
  - Observe: `findAndVerifyVideo()` with stable DOM (no mutations) clicks the correct element at the matched index on unfixed code
  - Observe: Video titles with only alphanumeric characters and spaces produce valid Google/Bing queries and return results on unfixed code
  - Observe: Orchestrator with no crashes completes all videos without touching restart logic on unfixed code
  - Observe: `searchAndWatch()` path's `trackEngagement('watchTime', seconds)` passes correct value on unfixed code
  - Observe: `watchVideo()` generates varied behavior patterns (commentScrollChance, relatedPeekChance) using `Math.random()` on unfixed code
  - Write property-based tests:
    - For all successful first-attempt searches (no retry triggered), `searchAndWatch` returns `true` and tracks analytics identically to unfixed code (from Preservation Requirements 3.1, 3.7)
    - For all clean disconnects (no throw), worker cleanup calls close in same sequence (from Preservation Requirements 3.2)
    - For all stable DOMs (no mutation between evaluate calls), `findAndVerifyVideo` clicks the correct video (from Preservation Requirements 3.3)
    - For all titles containing only `[a-zA-Z0-9 ]`, Google/Bing query format produces valid search strings (from Preservation Requirements 3.4)
    - For all workers completing without crashes, video queue management is unchanged (from Preservation Requirements 3.6)
    - For all `watchVideo()` calls, human-like behavior variation continues using `Math.random()` for commentScrollChance, relatedPeekChance (from Preservation Requirements 3.8)
  - Verify tests PASS on UNFIXED code
  - **EXPECTED OUTCOME**: Tests PASS (this confirms baseline behavior to preserve)
  - Mark task complete when tests are written, run, and passing on unfixed code
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8_

- [ ] 3. Fix for infinite retry loop in searchAndWatch()

  - [ ] 3.1 Replace `_isRetrying` flag with depth parameter in `server/agent.cjs`
    - Add optional `_retryDepth = 0` parameter to `searchAndWatch(videoTitle, channelName, config, _retryDepth = 0)`
    - Remove `this._isRetrying` flag logic (both the check at top and the set before recursive call)
    - Remove `if (!this._isRetrying) { this.retryCount = 0; }` and `this._isRetrying = false` lines
    - Replace retry condition: `if (_retryDepth < this.maxRetries)` instead of `if (this.retryCount < this.maxRetries)`
    - Pass `_retryDepth + 1` on recursive calls: `return await this.searchAndWatch(videoTitle, channelName, config, _retryDepth + 1)`
    - Remove `this.retryCount++` and `this._isRetrying = true` before recursive calls
    - Keep `this.retryCount = 0` reset on success (for status reporting)
    - _Bug_Condition: isBugCondition(input) where input.context == 'searchAndWatch' AND input.state.searchFailed == true AND retryCount < maxRetries_
    - _Expected_Behavior: searchAndWatch terminates after exactly maxRetries (3) recursive calls and returns false_
    - _Preservation: Successful first-attempt searches return true without retry logic executing (Req 3.1)_
    - _Requirements: 1.1, 2.1, 3.1_

  - [ ] 3.2 Verify bug condition exploration test now passes for Bug 1
    - **Property 1: Expected Behavior** - Retry Termination
    - **IMPORTANT**: Re-run the SAME test from task 1 (Test 1.1) - do NOT write a new test
    - The test from task 1 asserts `searchAndWatch` returns `false` within maxRetries attempts
    - When this test passes, it confirms the infinite retry loop is fixed
    - Run bug condition exploration test from step 1
    - **EXPECTED OUTCOME**: Test PASSES (confirms bug is fixed)
    - _Requirements: 2.1_

  - [ ] 3.3 Verify preservation tests still pass
    - **Property 2: Preservation** - Successful Search Unchanged
    - **IMPORTANT**: Re-run the SAME tests from task 2 - do NOT write new tests
    - Run preservation property tests from step 2
    - **EXPECTED OUTCOME**: Tests PASS (confirms no regressions)
    - Confirm successful first-attempt searches still return true and track analytics normally

- [ ] 4. Fix for zombie browser processes in worker.cjs

  - [ ] 4.1 Wrap disconnect + close in try/finally in `server/worker.cjs`
    - In `runWorker()` Step 4 cleanup section, replace sequential calls with:
    - ```try { await agent.disconnect(); } finally { try { await moreloginRequest('/api/env/close', { envId: profileId }); sendLog(profileId, 'info', 'MoreLogin browser closed ✓'); } catch (err) { sendLog(profileId, 'warn', `Could not close MoreLogin browser: ${err.message}`); } }```
    - This ensures `moreloginRequest('/api/env/close')` is ALWAYS called regardless of disconnect success/failure
    - _Bug_Condition: isBugCondition(input) where input.context == 'workerCleanup' AND input.state.disconnectThrows == true_
    - _Expected_Behavior: moreloginRequest('/api/env/close') is called in finally block regardless of disconnect outcome_
    - _Preservation: Clean disconnects still close browser and report completion normally (Req 3.2)_
    - _Requirements: 1.2, 2.2, 3.2_

  - [ ] 4.2 Verify bug condition exploration test now passes for Bug 2
    - **Property 1: Expected Behavior** - Browser Cleanup Guarantee
    - **IMPORTANT**: Re-run the SAME test from task 1 (Test 1.2) - do NOT write a new test
    - Run bug condition exploration test from step 1
    - **EXPECTED OUTCOME**: Test PASSES (confirms zombie browser bug is fixed)
    - _Requirements: 2.2_

  - [ ] 4.3 Verify preservation tests still pass
    - **Property 2: Preservation** - Clean Disconnect Unchanged
    - **IMPORTANT**: Re-run the SAME tests from task 2 - do NOT write new tests
    - **EXPECTED OUTCOME**: Tests PASS (confirms no regressions)

- [ ] 5. Fix for race condition in findAndVerifyVideo()

  - [ ] 5.1 Implement atomic find-and-click in single evaluate context in `server/searchEngine.cjs`
    - In `findAndVerifyVideo()`, replace the two-step approach (evaluate to find index → `page.$$()` to get handles → click by index)
    - Use a single `page.evaluate()` that both finds the matching element AND clicks it via `element.click()` inside the browser context
    - The evaluate should: scan all `ytd-video-renderer` elements, check title/channel match, and call `.click()` on the matched `a#video-title` element directly
    - Return `true` from evaluate if clicked, `false` if no match found
    - Remove the separate `page.$$('ytd-video-renderer a#video-title')` call and the `boundingBox` / external click logic
    - _Bug_Condition: isBugCondition(input) where input.context == 'findAndVerifyVideo' AND input.state.domChangedBetweenCalls == true_
    - _Expected_Behavior: Find and click happen atomically in one evaluate — no window for DOM mutations_
    - _Preservation: Stable DOM searches still click the correct video (Req 3.3)_
    - _Requirements: 1.3, 2.3, 3.3_

  - [ ] 5.2 Verify bug condition exploration test now passes for Bug 3
    - **Property 1: Expected Behavior** - Atomic Find-and-Click
    - **IMPORTANT**: Re-run the SAME test from task 1 (Test 1.3) - do NOT write a new test
    - Run bug condition exploration test from step 1
    - **EXPECTED OUTCOME**: Test PASSES (confirms race condition is eliminated)
    - _Requirements: 2.3_

  - [ ] 5.3 Verify preservation tests still pass
    - **Property 2: Preservation** - Stable DOM Search Unchanged
    - **IMPORTANT**: Re-run the SAME tests from task 2 - do NOT write new tests
    - **EXPECTED OUTCOME**: Tests PASS (confirms no regressions)

- [ ] 6. Fix for quoted query false negatives in searchEngine.cjs

  - [ ] 6.1 Sanitize query strings in `searchBing()` and `searchGoogle()` in `server/searchEngine.cjs`
    - Create a helper function `sanitizeSearchQuery(title)` that:
      - Strips special characters: `[](){}:!?—–` using regex `.replace(/[\[\](){}:!?—–]/g, ' ')`
      - Removes double quotes: `.replace(/"/g, '')`
      - Collapses multiple spaces: `.replace(/\s+/g, ' ').trim()`
    - In `searchBing()`: Replace `const bingQuery = channelName ? \`"${channelName}" "${videoTitle}" youtube\`` with `const cleanTitle = sanitizeSearchQuery(videoTitle); const bingQuery = channelName ? \`${channelName} ${cleanTitle} youtube\`` (no quotes around title)
    - In `searchGoogle()`: Replace `const googleQuery = channelName ? \`"${channelName}" "${videoTitle}" youtube\`` with `const cleanTitle = sanitizeSearchQuery(videoTitle); const googleQuery = channelName ? \`${channelName} ${cleanTitle} youtube\`` (no quotes around title)
    - Keep channel name unquoted as well for consistency
    - _Bug_Condition: isBugCondition(input) where videoTitle CONTAINS_ANY ['[', ']', '(', ')', '{', '}', ':', '!', '?']_
    - _Expected_Behavior: Query is clean keywords without special chars or quotes, producing valid search results_
    - _Preservation: Titles with only alphanumeric chars still search successfully (Req 3.4)_
    - _Requirements: 1.4, 2.4, 3.4_

  - [ ] 6.2 Verify bug condition exploration test now passes for Bug 4
    - **Property 1: Expected Behavior** - Special Character Query Handling
    - **IMPORTANT**: Re-run the SAME test from task 1 (Test 1.4) - do NOT write a new test
    - Run bug condition exploration test from step 1
    - **EXPECTED OUTCOME**: Test PASSES (confirms query sanitization works)
    - _Requirements: 2.4_

  - [ ] 6.3 Verify preservation tests still pass
    - **Property 2: Preservation** - Simple Title Queries Unchanged
    - **IMPORTANT**: Re-run the SAME tests from task 2 - do NOT write new tests
    - **EXPECTED OUTCOME**: Tests PASS (confirms no regressions)

- [ ] 7. Fix for hardcoded API key duplication

  - [ ] 7.1 Create `server/config.cjs` with centralized configuration
    - Create new file `server/config.cjs`
    - Export `MORELOGIN_API_KEY`: read from `process.env.MORELOGIN_API_KEY` with fallback to current hardcoded value `'dbc21d41137f29238f4679e71b7986decb0581115e34a84e'`
    - Export `MORELOGIN_BASE`: `'http://127.0.0.1:40000'`
    - _Requirements: 2.5_

  - [ ] 7.2 Update `server/index.cjs` to import from config
    - Replace `const MORELOGIN_API_KEY = 'dbc21d41...'` with `const { MORELOGIN_API_KEY } = require('./config.cjs')`
    - Keep `MORELOGIN_BASE` usage or import it from config as well
    - _Requirements: 2.5, 3.5_

  - [ ] 7.3 Update `server/worker.cjs` to import from config
    - Replace `const MORELOGIN_API_KEY = 'dbc21d41...'` with `const { MORELOGIN_API_KEY } = require('./config.cjs')`
    - _Bug_Condition: isBugCondition(input) where input.context == 'apiKeyUpdate' AND updatedFiles != both files_
    - _Expected_Behavior: Single source of truth — update config.cjs and both files get the new key_
    - _Preservation: MoreLogin API authentication continues working with same key value (Req 3.5)_
    - _Requirements: 1.5, 2.5, 3.5_

  - [ ] 7.4 Verify API key is read from single source
    - Confirm both `index.cjs` and `worker.cjs` import from `config.cjs`
    - Confirm no hardcoded API key remains in either file
    - _Requirements: 2.5_

- [ ] 8. Fix for stale videos array on orchestrator restart

  - [ ] 8.1 Store remaining videos in workerState in `server/orchestrator.cjs`
    - Add `remainingVideos: [...videos]` to the `workerState` object in `startWorker()`
    - In the `'status'` message handler, when progress updates (e.g., `msg.progress` like `"3/10"`), update `state.remainingVideos` by slicing based on completed count
    - In the `'error'` handler, replace `const remainingVideos = videos.slice(completedCount)` with `const remainingVideos = state.remainingVideos || videos`
    - On restart call, pass `state.remainingVideos` instead of re-slicing the original `videos` parameter
    - _Bug_Condition: isBugCondition(input) where input.context == 'orchestratorRestart' AND workerCrashed == true AND completedCount > 0_
    - _Expected_Behavior: Restart uses stored remainingVideos from workerState, never replays already-watched videos_
    - _Preservation: Workers completing without crashes report results normally (Req 3.6)_
    - _Requirements: 1.6, 2.6, 3.6_

  - [ ] 8.2 Verify bug condition exploration test now passes for Bug 5/6
    - **Property 1: Expected Behavior** - Correct Resume on Restart
    - **IMPORTANT**: Re-run the SAME test from task 1 (Test 1.5) - do NOT write a new test
    - Run bug condition exploration test from step 1
    - **EXPECTED OUTCOME**: Test PASSES (confirms stale array bug is fixed)
    - _Requirements: 2.6_

  - [ ] 8.3 Verify preservation tests still pass
    - **Property 2: Preservation** - No-Crash Worker Unchanged
    - **IMPORTANT**: Re-run the SAME tests from task 2 - do NOT write new tests
    - **EXPECTED OUTCOME**: Tests PASS (confirms no regressions)

- [ ] 9. Fix for watchByUrl() missing watchTime value

  - [ ] 9.1 Pass actual watch time seconds in `server/agent.cjs` watchByUrl()
    - Change `await trackEngagement(this.profileId, 'watchTime').catch(...)` to `await trackEngagement(this.profileId, 'watchTime', Math.round(watchTime / 1000)).catch(...)`
    - The `watchTime` variable (in milliseconds) is already calculated earlier in the function as `Math.round(duration * (watchPercent / 100))`
    - _Bug_Condition: isBugCondition(input) where input.context == 'watchByUrl' AND action == 'watchTime'_
    - _Expected_Behavior: trackEngagement receives actual watch duration in seconds as third parameter_
    - _Preservation: searchAndWatch() path's existing correct trackEngagement calls unchanged (Req 3.7)_
    - _Requirements: 1.7, 2.7, 3.7_

  - [ ] 9.2 Verify bug condition exploration test now passes for Bug 7
    - **Property 1: Expected Behavior** - Accurate Watch Time Tracking
    - **IMPORTANT**: Re-run the SAME test from task 1 (Test 1.6) - do NOT write a new test
    - Run bug condition exploration test from step 1
    - **EXPECTED OUTCOME**: Test PASSES (confirms watch time value is passed correctly)
    - _Requirements: 2.7_

  - [ ] 9.3 Verify preservation tests still pass
    - **Property 2: Preservation** - searchAndWatch WatchTime Unchanged
    - **IMPORTANT**: Re-run the SAME tests from task 2 - do NOT write new tests
    - **EXPECTED OUTCOME**: Tests PASS (confirms no regressions)

- [ ] 10. Fix for unused seed variable in watchVideo()

  - [ ] 10.1 Remove dead code from `server/agent.cjs` watchVideo()
    - Delete the line `const seed = Math.random();` from the `watchVideo()` function
    - Verify no other code references `seed` in that function scope
    - _Bug_Condition: isBugCondition(input) where input.context == 'watchVideo' AND seedDeclared == true AND seedUsed == false_
    - _Expected_Behavior: No unused variable declarations in watchVideo()_
    - _Preservation: watchVideo() continues generating varied behavior via independent Math.random() calls (Req 3.8)_
    - _Requirements: 1.8, 2.8, 3.8_

  - [ ] 10.2 Verify bug condition exploration test now passes for Bug 8
    - **Property 1: Expected Behavior** - Dead Code Removal
    - **IMPORTANT**: Re-run the SAME test from task 1 (Test 1.7) - do NOT write a new test
    - Run bug condition exploration test from step 1
    - **EXPECTED OUTCOME**: Test PASSES (confirms dead code is removed)
    - _Requirements: 2.8_

  - [ ] 10.3 Verify preservation tests still pass
    - **Property 2: Preservation** - Behavior Variation Unchanged
    - **IMPORTANT**: Re-run the SAME tests from task 2 - do NOT write new tests
    - **EXPECTED OUTCOME**: Tests PASS (confirms no regressions)

- [ ] 11. Checkpoint - Ensure all tests pass
  - Run full test suite: all bug condition exploration tests should now PASS
  - Run full test suite: all preservation property tests should still PASS
  - Verify no zombie processes remain after worker completion with disconnect errors
  - Verify `searchAndWatch` terminates within 3 retries for any failing search
  - Verify query sanitization handles all special character combinations
  - Verify orchestrator correctly resumes from stored remaining videos after any crash sequence
  - Verify `watchByUrl` analytics report actual seconds watched
  - Verify no unused variables remain (lint check)
  - Ensure all tests pass, ask the user if questions arise.

## Task Dependency Graph

```json
{
  "waves": [
    { "tasks": ["1", "2"] },
    { "tasks": ["3", "4", "5", "6", "7", "8", "9", "10"] },
    { "tasks": ["11"] }
  ]
}
```

## Notes

- All exploration tests (task 1) must be written and run BEFORE any implementation begins
- All preservation tests (task 2) must pass on UNFIXED code before proceeding
- Implementation tasks 3-10 can be done in parallel but are ordered by priority (CRITICAL → HIGH → MEDIUM → LOW)
- Each implementation task includes verification sub-tasks that re-run the SAME tests from tasks 1 and 2
- The `config.cjs` file (task 7) should be created early as it's a dependency for both `index.cjs` and `worker.cjs`
