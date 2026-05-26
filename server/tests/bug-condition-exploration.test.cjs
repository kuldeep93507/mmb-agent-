/**
 * Bug Condition Exploration Tests
 * 
 * These tests are EXPECTED TO FAIL on unfixed code.
 * Failure confirms the bugs exist.
 * DO NOT fix the code or tests when they fail.
 * 
 * Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8
 */

const fc = require('fast-check');
const path = require('path');
const fs = require('fs');

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TEST 1.1: Infinite Retry Loop in searchAndWatch()
// Bug Condition: input.context == 'searchAndWatch' AND input.state.searchFailed == true
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('Bug 1.1: Infinite Retry Loop in searchAndWatch()', () => {
  test('searchAndWatch returns false within maxRetries (3) attempts when search always fails', async () => {
    // Mock openVideoSmart to always return { success: false }
    const originalModule = require('../searchEngine.cjs');
    
    // We need to create a ProfileAgent with mocked dependencies
    // Intercept the require for searchEngine
    const Module = require('module');
    const originalRequire = Module.prototype.require;
    
    let openVideoSmartCallCount = 0;
    
    Module.prototype.require = function(id) {
      if (id === './searchEngine.cjs' || id.endsWith('searchEngine.cjs')) {
        return {
          ...originalModule,
          openVideoSmart: async () => {
            openVideoSmartCallCount++;
            return { success: false, source: 'youtube-search' };
          }
        };
      }
      return originalRequire.apply(this, arguments);
    };
    
    // Clear cached module to force re-require with mock
    delete require.cache[require.resolve('../agent.cjs')];
    const { ProfileAgent } = require('../agent.cjs');
    
    // Restore original require
    Module.prototype.require = originalRequire;
    
    // Create agent with mock browser context
    const agent = new ProfileAgent('test-profile-001', 'TestProfile', 9222);
    agent._warmedUp = true; // Skip warmup
    
    // Mock the browser context
    const mockPage = {
      url: () => 'https://www.youtube.com',
      goto: async () => {},
      evaluate: async (fn) => fn(),
      $: async () => null,
      $$: async () => [],
      keyboard: { press: async () => {}, type: async () => {} },
      mouse: { move: async () => {}, wheel: async () => {} },
      close: async () => {},
      waitForSelector: async () => {},
      emulateMedia: async () => {},
    };
    
    agent.context = {
      pages: () => [mockPage],
      newPage: async () => mockPage,
    };
    agent._lastPage = mockPage;
    
    // Call searchAndWatch — should return false within maxRetries
    // Set a timeout to detect infinite loop
    const timeoutMs = 10000; // 10 seconds max
    let result;
    let timedOut = false;
    
    const timeoutPromise = new Promise((resolve) => {
      setTimeout(() => { timedOut = true; resolve('TIMEOUT'); }, timeoutMs);
    });
    
    const searchPromise = agent.searchAndWatch('NonExistent Video Title', 'FakeChannel', {});
    
    result = await Promise.race([searchPromise, timeoutPromise]);
    
    // ASSERTION: Should NOT timeout (infinite loop = bug exists)
    expect(timedOut).toBe(false);
    // ASSERTION: Should return false (search failed)
    expect(result).toBe(false);
    // ASSERTION: Should have been called at most maxRetries + 1 times (initial + 3 retries = 4)
    expect(openVideoSmartCallCount).toBeLessThanOrEqual(4);
    
    // Clean up
    delete require.cache[require.resolve('../agent.cjs')];
  }, 15000);
});


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TEST 1.2: Zombie Browser — disconnect throws, close never called
// Bug Condition: input.context == 'workerCleanup' AND input.state.disconnectThrows == true
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('Bug 1.2: Zombie Browser — moreloginRequest not called when disconnect throws', () => {
  test('moreloginRequest("/api/env/close") is called even when agent.disconnect() throws', async () => {
    // Read the worker.cjs source to understand the cleanup flow
    const workerSource = fs.readFileSync(path.resolve(__dirname, '../worker.cjs'), 'utf8');
    
    // The bug: in worker.cjs Step 4, the code is:
    //   await agent.disconnect();
    //   await moreloginRequest('/api/env/close', { envId: profileId });
    // If disconnect() throws, the close call is skipped.
    
    // We simulate this by extracting the cleanup logic pattern
    let disconnectCalled = false;
    let closeCalled = false;
    
    const mockAgent = {
      disconnect: async () => {
        disconnectCalled = true;
        throw new Error('Target closed');
      }
    };
    
    const mockMoreloginRequest = async (endpoint, body) => {
      if (endpoint === '/api/env/close') {
        closeCalled = true;
      }
      return { code: 0 };
    };
    
    // Simulate the ACTUAL cleanup code from worker.cjs (Step 4)
    // This mirrors the unfixed code pattern:
    try {
      await mockAgent.disconnect();
      // Close MoreLogin profile browser (prevent RAM leak)
      await mockMoreloginRequest('/api/env/close', { envId: 'test-profile' });
    } catch (err) {
      // In the unfixed code, there's no catch around disconnect
      // The close call is simply after disconnect, not in a finally block
    }
    
    // ASSERTION: disconnect was called
    expect(disconnectCalled).toBe(true);
    // ASSERTION: close should STILL be called (but won't be in unfixed code)
    expect(closeCalled).toBe(true);
  });
});


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TEST 1.3: Race Condition in findAndVerifyVideo()
// Bug Condition: input.context == 'findAndVerifyVideo' AND input.state.domChangedBetweenCalls == true
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('Bug 1.3: Race Condition — DOM mutation between evaluate and $$', () => {
  test('when DOM shifts between page.evaluate() and page.$$(), wrong element gets clicked', async () => {
    // The bug: findAndVerifyVideo does:
    // 1. page.evaluate() → scans DOM, finds match at index N
    // 2. page.$$('ytd-video-renderer a#video-title') → gets element handles
    // Between steps 1 and 2, DOM can change (ad inserted, lazy load)
    // So element at index N in step 2 is DIFFERENT from what was found in step 1
    
    let evaluateCallCount = 0;
    let clickedElementIndex = -1;
    
    // Simulate: evaluate finds "Target Video" at index 2
    // But page.$$() returns shifted elements (ad inserted at index 0)
    const mockPage = {
      evaluate: async (fn) => {
        evaluateCallCount++;
        if (evaluateCallCount === 1) {
          // First call: check if results exist
          return 3; // 3 results
        }
        // Second call: scan results and find match
        // Returns results array with match at index 2
        return [
          { index: 0, title: 'Unrelated Video 1', channel: 'Other' },
          { index: 1, title: 'Unrelated Video 2', channel: 'Other' },
          { index: 2, title: 'Target Video Title', channel: 'Target Channel' },
        ];
      },
      $$: async (selector) => {
        // DOM has SHIFTED — ad inserted at position 0
        // Now index 2 points to a DIFFERENT element
        return [
          { // index 0: NEW AD (inserted after evaluate)
            boundingBox: async () => ({ x: 100, y: 100, width: 200, height: 30 }),
            click: async () => { clickedElementIndex = 0; },
          },
          { // index 1: was "Unrelated Video 1" (shifted from index 0)
            boundingBox: async () => ({ x: 100, y: 150, width: 200, height: 30 }),
            click: async () => { clickedElementIndex = 1; },
          },
          { // index 2: was "Unrelated Video 2" (shifted from index 1) — NOT the target!
            boundingBox: async () => ({ x: 100, y: 200, width: 200, height: 30 }),
            click: async () => { clickedElementIndex = 2; },
          },
          { // index 3: was "Target Video Title" (shifted from index 2)
            boundingBox: async () => ({ x: 100, y: 250, width: 200, height: 30 }),
            click: async () => { clickedElementIndex = 3; },
          },
        ];
      },
      mouse: {
        move: async () => {},
        wheel: async () => {},
      },
    };
    
    // Load findAndVerifyVideo from searchEngine
    const searchEngine = require('../searchEngine.cjs');
    
    // The function uses page.evaluate to find match, then page.$$ to get handles
    // With shifted DOM, it will click index 2 which is now the WRONG video
    
    // We can't easily call findAndVerifyVideo directly since it's not exported
    // Instead, verify the pattern: the code does evaluate → $$ → click by index
    // This is a structural test showing the race condition EXISTS
    
    // Verify the source code has the two-step pattern (evaluate then $$)
    const sourceCode = fs.readFileSync(path.resolve(__dirname, '../searchEngine.cjs'), 'utf8');
    
    // The bug pattern: page.evaluate() to find index, then page.$$() to get handles
    const hasEvaluateCall = sourceCode.includes("page.evaluate(");
    const hasSeparateQuerySelector = sourceCode.includes("page.$$('ytd-video-renderer a#video-title')");
    
    // ASSERTION: The code uses the two-step approach (race condition exists)
    // After fix, the code should use a single evaluate that both finds AND clicks
    expect(hasEvaluateCall).toBe(true);
    // ASSERTION: There should NOT be a separate page.$$() call after evaluate
    // (If this passes, the race condition is fixed. If it fails, bug exists.)
    expect(hasSeparateQuerySelector).toBe(false);
  });
});


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TEST 1.4: Quoted Query False Negatives
// Bug Condition: input.state.videoTitle CONTAINS_ANY ['[', ']', '(', ')', '{', '}', ':', '!', '?']
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('Bug 1.4: Quoted Query False Negatives — special chars in search queries', () => {
  test('searchBing/searchGoogle query does NOT contain special characters inside double quotes', () => {
    // Read the source code to inspect the query construction
    const sourceCode = fs.readFileSync(path.resolve(__dirname, '../searchEngine.cjs'), 'utf8');
    
    // The bug: searchBing and searchGoogle wrap the title in double quotes:
    // const bingQuery = channelName ? `"${channelName}" "${videoTitle}" youtube` : `"${videoTitle}" youtube`;
    // When videoTitle contains [](){}:!?, the quoted query fails on search engines
    
    // Property test: for any title with special chars, the query should NOT have them inside quotes
    fc.assert(
      fc.property(
        fc.record({
          videoTitle: fc.array(
            fc.oneof(
              fc.constant('['), fc.constant(']'),
              fc.constant('('), fc.constant(')'),
              fc.constant('{'), fc.constant('}'),
              fc.constant(':'), fc.constant('!'), fc.constant('?'),
              fc.constantFrom('a', 'b', 'c', 'd', 'e', 'R', 'T', ' ')
            ),
            { minLength: 5, maxLength: 50 }
          ).map(arr => arr.join('')),
          channelName: fc.string({ minLength: 3, maxLength: 20 }),
        }),
        ({ videoTitle, channelName }) => {
          // Simulate the ACTUAL query construction from searchBing/searchGoogle
          // This is the unfixed code pattern:
          const bingQuery = channelName ? `"${channelName}" "${videoTitle}" youtube` : `"${videoTitle}" youtube`;
          const googleQuery = channelName ? `"${channelName}" "${videoTitle}" youtube` : `"${videoTitle}" youtube`;
          
          // Extract content inside double quotes
          const quotedParts = bingQuery.match(/"([^"]*)"/g) || [];
          
          // ASSERTION: No quoted part should contain special characters
          const specialChars = /[\[\](){}:!?]/;
          for (const part of quotedParts) {
            const content = part.slice(1, -1); // Remove surrounding quotes
            if (content === channelName) continue; // Channel name is ok
            // The video title part should NOT contain special chars inside quotes
            if (content.includes(videoTitle) || videoTitle.includes(content)) {
              // This is the title part — it should be sanitized
              expect(specialChars.test(content)).toBe(false);
            }
          }
        }
      ),
      { numRuns: 50 }
    );
  });
});


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TEST 1.5: Stale Videos Array on Orchestrator Restart
// Bug Condition: input.context == 'orchestratorRestart' AND input.state.completedCount > 0
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('Bug 1.5: Stale Videos Array — second restart replays already-watched videos', () => {
  test('crash-restart-crash sequence: second restart does NOT replay already-watched videos', () => {
    // The bug in orchestrator.cjs:
    // In the error handler, it does: const remainingVideos = videos.slice(completedCount)
    // But `videos` is the ORIGINAL array from the outer startWorker() call
    // After first restart, `state.results` is reset to null
    // So on second crash, completedCount = state.results?.watched || 0 = 0
    // This means videos.slice(0) = ALL videos replayed
    
    // Simulate the orchestrator's error handler logic
    const originalVideos = [
      { title: 'Video 1' },
      { title: 'Video 2' },
      { title: 'Video 3' },
      { title: 'Video 4' },
      { title: 'Video 5' },
      { title: 'Video 6' },
      { title: 'Video 7' },
      { title: 'Video 8' },
      { title: 'Video 9' },
      { title: 'Video 10' },
    ];
    
    // Simulate the workerState as in orchestrator.cjs
    const workerState = {
      status: 'running',
      retries: 0,
      results: null, // Reset on each restart
    };
    
    const maxRetries = 3;
    
    // --- First run: watches 5 videos, then crashes ---
    workerState.results = { watched: 5 };
    
    // First crash — error handler fires
    workerState.retries++;
    const completedCount1 = workerState.results?.watched || 0; // = 5
    const remainingVideos1 = originalVideos.slice(completedCount1); // Videos 6-10
    
    // Verify first restart is correct
    expect(remainingVideos1.length).toBe(5);
    expect(remainingVideos1[0].title).toBe('Video 6');
    
    // --- Second run (restart): state.results is reset ---
    // The orchestrator calls startWorker again with remainingVideos1
    // But the error handler closure still references the ORIGINAL `videos` parameter
    // In the actual code, the restart calls startWorker(profileId, profileName, remainingVideos, config)
    // But the error handler in the NEW startWorker still uses `videos` (which is now remainingVideos1)
    // HOWEVER, the bug is that state.results is null after restart
    
    // Simulate: worker restarts, watches 2 more (Video 6, 7), then crashes again
    workerState.results = null; // Reset on restart (new worker)
    // After watching 2 videos in the restarted worker:
    workerState.results = { watched: 2 };
    
    // Second crash — error handler fires
    workerState.retries++;
    // BUG: The error handler uses `videos` from the closure
    // In the ORIGINAL startWorker call, `videos` = originalVideos (10 items)
    // completedCount comes from state.results?.watched which was reset
    // After the restart, a NEW startWorker is called with remainingVideos1
    // But if the orchestrator doesn't store remaining videos in state,
    // and the error handler references the original `videos` parameter...
    
    // Simulate the BUG: orchestrator error handler uses original videos reference
    // The actual code: const remainingVideos = videos.slice(completedCount)
    // where `videos` is the parameter passed to startWorker (captured in closure)
    // On second crash within the RESTARTED worker, state.results?.watched = 2
    // But `videos` in that closure is remainingVideos1 (5 items), so slice(2) = 3 items
    // This seems correct for the second call...
    
    // The REAL bug: state.results is set to null when startWorker is called again
    // because workerState is recreated. Let's trace the actual code:
    
    // In orchestrator.cjs startWorker():
    //   const workerState = { worker: null, status: 'starting', results: null, ... }
    //   this.workers.set(profileId, workerState);
    //   worker.on('message', (msg) => {
    //     const state = this.workers.get(profileId);
    //     if (msg.type === 'error') {
    //       const completedCount = state.results?.watched || 0;
    //       const remainingVideos = videos.slice(completedCount);  // <-- BUG: uses `videos` param
    //       this.startWorker(profileId, profileName, remainingVideos, config, 3000);
    //     }
    //   });
    
    // When startWorker is called again (restart), it:
    // 1. Calls this.stopWorker(profileId) — kills old worker
    // 2. Creates NEW workerState with results: null
    // 3. Sets this.workers.set(profileId, NEW workerState)
    // 4. The NEW worker's error handler closure captures the NEW `videos` param
    
    // So on second crash:
    // - The NEW error handler has `videos` = remainingVideos1 (5 items)
    // - state.results?.watched = 0 (because new workerState has results: null initially)
    //   WAIT — the worker sends 'status' messages with progress, but results is only set on 'done'
    //   The error fires BEFORE done, so state.results is still null!
    
    // THIS IS THE BUG: state.results is null when error fires (worker crashed before 'done')
    // So completedCount = state.results?.watched || 0 = 0
    // remainingVideos = videos.slice(0) = ALL videos passed to this startWorker call
    
    // For the SECOND restart:
    // videos = remainingVideos1 = [Video 6, 7, 8, 9, 10]
    // completedCount = 0 (state.results is null — worker crashed before sending 'done')
    // remainingVideos = videos.slice(0) = [Video 6, 7, 8, 9, 10] — REPLAYS Video 6 and 7!
    
    // Simulate this exact scenario:
    const secondStartVideos = remainingVideos1; // [Video 6, 7, 8, 9, 10]
    
    // Worker watches Video 6 and 7, then crashes
    // state.results is null (crash happens before 'done' message)
    const stateAfterSecondCrash = { results: null }; // Worker crashed, no 'done' sent
    
    const completedCount2 = stateAfterSecondCrash.results?.watched || 0; // = 0 (BUG!)
    const remainingVideos2 = secondStartVideos.slice(completedCount2); // slice(0) = ALL 5
    
    // ASSERTION: Second restart should only have Videos 8, 9, 10 (3 remaining)
    // But due to the bug, it has Videos 6, 7, 8, 9, 10 (all 5 — replays 6 and 7)
    expect(remainingVideos2.length).toBe(3);
    expect(remainingVideos2[0].title).toBe('Video 8');
  });
});


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TEST 1.6: Missing watchTime Value in watchByUrl()
// Bug Condition: input.context == 'watchByUrl' AND input.state.action == 'watchTime'
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('Bug 1.6: Missing watchTime Value — trackEngagement receives default 1 instead of actual seconds', () => {
  test('trackEngagement for watchTime action receives actual seconds NOT default value 1', () => {
    // Read the source code to verify the bug
    const sourceCode = fs.readFileSync(path.resolve(__dirname, '../agent.cjs'), 'utf8');
    
    // Find the watchByUrl function and check the trackEngagement call
    // The bug: trackEngagement(this.profileId, 'watchTime') — no third argument
    // Expected: trackEngagement(this.profileId, 'watchTime', Math.round(watchTime / 1000))
    
    // Extract the watchByUrl method body
    const watchByUrlStart = sourceCode.indexOf('async watchByUrl(');
    const watchByUrlSection = sourceCode.substring(watchByUrlStart, watchByUrlStart + 1500);
    
    // Find the trackEngagement call for watchTime within watchByUrl
    const watchTimeCallMatch = watchByUrlSection.match(
      /trackEngagement\(this\.profileId,\s*['"]watchTime['"](.*?)\)/
    );
    
    expect(watchTimeCallMatch).not.toBeNull();
    
    // The third argument should be the actual watch time in seconds
    // In the buggy code, there's no third argument (or it's empty)
    const thirdArg = watchTimeCallMatch[1].trim();
    
    // ASSERTION: The call should have a third argument with actual seconds
    // If thirdArg is empty or just a comma, the bug exists
    expect(thirdArg).not.toBe('');
    expect(thirdArg).toMatch(/,\s*Math\.round\(watchTime\s*\/\s*1000\)/);
  });
});


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TEST 1.7: Unused seed Variable in watchVideo() — Dead Code
// Bug Condition: input.context == 'watchVideo' AND input.state.seedUsed == false
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('Bug 1.7: Unused seed Variable — dead code in watchVideo()', () => {
  test('seed variable is declared but never referenced in watchVideo()', () => {
    // Static analysis: read the source and check if seed is used after declaration
    const sourceCode = fs.readFileSync(path.resolve(__dirname, '../agent.cjs'), 'utf8');
    
    // Find the watchVideo method
    const watchVideoStart = sourceCode.indexOf('async watchVideo(page, durationMs');
    expect(watchVideoStart).toBeGreaterThan(-1);
    
    // Get the function body (find the next method or end of class)
    const watchVideoSection = sourceCode.substring(watchVideoStart, watchVideoStart + 5000);
    
    // Check if 'seed' is declared
    const seedDeclaration = watchVideoSection.match(/const\s+seed\s*=\s*Math\.random\(\)/);
    expect(seedDeclaration).not.toBeNull();
    
    // Check if 'seed' is USED anywhere after declaration (not just declared)
    // Remove the declaration line itself, then search for 'seed' usage
    const afterDeclaration = watchVideoSection.substring(
      watchVideoSection.indexOf('const seed = Math.random()') + 'const seed = Math.random()'.length
    );
    
    // Look for any reference to `seed` (as a variable, not part of another word)
    const seedUsages = afterDeclaration.match(/\bseed\b/g);
    
    // ASSERTION: seed should be USED somewhere (not dead code)
    // If seedUsages is null or empty, the variable is dead code (bug exists)
    expect(seedUsages).not.toBeNull();
    expect(seedUsages.length).toBeGreaterThan(0);
  });
});
