# Requirements Document

## Introduction

This document specifies the requirements for fixing 8 critical bugs and adding 7 advanced anti-detection features to the MMB-AGENT YouTube automation engine. The system uses Playwright CDP to control antidetect browsers (MoreLogin/AdsPower/Multilogin) via worker threads for parallel profile execution. The fixes and features are organized into four phases: Phase A (critical bugs), Phase B (medium bugs), Phase C (advanced anti-detection), and Phase D (advanced realism).

## Glossary

- **Agent**: The ProfileAgent class in agent.cjs that controls a single browser profile session via Playwright CDP
- **Worker**: An isolated worker thread (worker.cjs) that manages one profile's complete lifecycle (start browser → connect → watch videos → cleanup)
- **Orchestrator**: The module (orchestrator.cjs) that spawns and manages multiple Worker threads, handles crash recovery and restart logic
- **Search_Engine**: The module (searchEngine.cjs) that discovers and opens target videos via multiple traffic sources (YouTube, Google, Bing, DuckDuckGo, Yahoo)
- **Config_Module**: A centralized configuration file (config.cjs) providing a single source of truth for API keys, ports, and limits
- **CDP**: Chrome DevTools Protocol — the interface Playwright uses to control the antidetect browser
- **MoreLogin_API**: The local HTTP API (port 40000) used to start, stop, and query antidetect browser profiles
- **Traffic_Source**: The method used to navigate to a target video (YouTube search, Google, Bing, DuckDuckGo, Yahoo, channel page, direct URL)
- **Bezier_Curve**: A parametric curve used to generate natural-looking mouse movement paths with acceleration and deceleration
- **Profile_Personality**: A behavioral archetype assigned to each profile that determines engagement rates, watch percentages, and interaction patterns
- **Retry_Depth**: A parameter tracking the current recursion level during search retry attempts, preventing infinite loops

---

## Requirements

---

### Phase A: Critical Bug Fixes

---

### Requirement 1: Eliminate Infinite Retry Loop in searchAndWatch

**User Story:** As a system operator, I want the retry mechanism in searchAndWatch to terminate after the configured maximum retries, so that the system does not enter an infinite loop consuming CPU and memory indefinitely.

#### Acceptance Criteria

1. WHEN searchAndWatch fails to find a video, THE Agent SHALL increment a retry depth counter passed as a function parameter rather than relying on instance-level flags
2. WHEN the retry depth parameter equals zero, THE Agent SHALL reset the retryCount to zero (fresh call only)
3. WHEN the retry depth exceeds maxRetries (default 3), THE Agent SHALL return false without making further recursive calls
4. THE Agent SHALL NOT use the _isRetrying flag to control retry count resets
5. IF searchAndWatch is called recursively for retry, THEN THE Agent SHALL pass _retryDepth + 1 to prevent retryCount from resetting on re-entry

---

### Requirement 2: Prevent Browser Zombie Processes in Worker

**User Story:** As a system operator, I want the Worker to always close the MoreLogin browser process regardless of disconnection errors, so that zombie browser processes do not accumulate in RAM.

#### Acceptance Criteria

1. THE Worker SHALL wrap the agent.disconnect() call in a try-catch block that logs but does not propagate disconnection errors
2. THE Worker SHALL call MoreLogin_API /api/env/close inside a finally block that executes regardless of whether agent.disconnect() succeeds or throws
3. IF agent.disconnect() throws an error, THEN THE Worker SHALL log the error at warn level and continue to the browser close step
4. IF the MoreLogin_API /api/env/close call fails, THEN THE Worker SHALL log the failure at warn level without crashing the worker process
5. WHEN CDP connection fails during initial setup, THE Worker SHALL still call MoreLogin_API /api/env/close before returning an error

---

### Requirement 3: Eliminate Race Condition in findAndVerifyVideo

**User Story:** As a system operator, I want video discovery and clicking to happen in a single atomic DOM operation, so that lazy-loaded DOM changes between evaluate() and $$() calls do not cause the wrong video to be clicked.

#### Acceptance Criteria

1. THE Search_Engine SHALL perform video title matching and clicking within a single page.evaluate() call to prevent DOM changes between discovery and click
2. THE Search_Engine SHALL NOT use separate evaluate() and $$() calls with index-based correlation for video clicking
3. WHEN a matching video is found inside evaluate(), THE Search_Engine SHALL click the element directly within the same JavaScript execution context
4. THE Search_Engine SHALL match videos by comparing the expected title and channel name against each ytd-video-renderer element's title attribute and channel name text
5. IF no matching video is found in the current results, THEN THE Search_Engine SHALL return false to trigger the next escalation query

---

### Phase B: Medium Bug Fixes

---

### Requirement 4: Track Actual Watch Time Value in watchByUrl

**User Story:** As a system operator, I want watchByUrl to report the actual seconds watched to the analytics backend, so that watch time metrics are accurate rather than always recording 1.

#### Acceptance Criteria

1. WHEN watchByUrl completes watching a video, THE Agent SHALL calculate the actual watch time in seconds as Math.round(duration * watchPercent / 100 / 1000)
2. WHEN calling trackEngagement for watchTime, THE Agent SHALL pass the calculated seconds value as the third parameter
3. THE Agent SHALL NOT call trackEngagement for watchTime without a numeric value parameter

---

### Requirement 5: Centralized Configuration Module

**User Story:** As a developer, I want all shared configuration values (API keys, ports, limits) in a single config.cjs file, so that changes only need to be made in one place and sync risks are eliminated.

#### Acceptance Criteria

1. THE Config_Module SHALL export MORELOGIN_API_KEY, MORELOGIN_PORT, and BACKEND_PORT as named constants
2. THE Worker SHALL import MORELOGIN_API_KEY from Config_Module instead of declaring it as a hardcoded string
3. THE server index.cjs SHALL import MORELOGIN_API_KEY from Config_Module instead of declaring it as a hardcoded string
4. THE Config_Module SHALL be the single source of truth for all shared configuration values across server modules
5. IF a configuration value is needed by multiple modules, THEN THE Config_Module SHALL define that value exactly once

---

### Requirement 6: Fix Stale Videos on Worker Restart in Orchestrator

**User Story:** As a system operator, I want the Orchestrator to track remaining videos per worker so that restarted workers resume from the correct position rather than re-queuing already-watched videos.

#### Acceptance Criteria

1. THE Orchestrator SHALL store the current videos array in the workerState object for each profile
2. WHEN a worker reports an error and triggers a restart, THE Orchestrator SHALL calculate remainingVideos from the stored workerState.videos using the completed count
3. WHEN calculating remainingVideos, THE Orchestrator SHALL update workerState.videos to the remaining subset for potential subsequent restarts
4. THE Orchestrator SHALL NOT reference the outer-scope original videos array during restart calculations

---

### Requirement 7: Fix Quoted Query False Negatives in External Search

**User Story:** As a system operator, I want Google and Bing searches to use unquoted natural queries, so that video titles containing special characters do not produce zero results.

#### Acceptance Criteria

1. THE Search_Engine SHALL provide a buildExternalQuery function that strips special characters (brackets, colons, pipes, dashes, exclamation marks, question marks) from video titles
2. WHEN constructing Google search queries, THE Search_Engine SHALL use buildExternalQuery output without wrapping in double quotes
3. WHEN constructing Bing search queries, THE Search_Engine SHALL use buildExternalQuery output without wrapping in double quotes
4. THE buildExternalQuery function SHALL limit the cleaned title to a maximum of 8 words to prevent overly specific queries
5. WHEN a channel name is provided, THE buildExternalQuery function SHALL prepend the channel name and append "youtube" to the query

---

### Requirement 8: Remove Dead Code — Unused Seed Variable

**User Story:** As a developer, I want the unused seed variable in watchVideo() to either be removed or used meaningfully, so that the codebase has no dead code.

#### Acceptance Criteria

1. THE Agent watchVideo() method SHALL use the seed variable to derive commentScrollChance, relatedPeekChance, and mouseMoveChance values for consistent per-call randomization
2. THE Agent SHALL NOT declare variables that are never referenced in subsequent code

---

### Phase C: Advanced Anti-Detection Features

---

### Requirement 9: Bezier Curve Mouse Movement

**User Story:** As a system operator, I want mouse movements to follow bezier curve paths with acceleration, deceleration, and micro-jitter, so that bot detection systems cannot distinguish automated movements from human ones.

#### Acceptance Criteria

1. THE Agent SHALL implement a bezierMouseMove function that generates curved paths between two points using cubic bezier interpolation with randomized control points
2. WHEN moving the mouse, THE Agent SHALL apply acceleration at the start of the path (increasing step distances) and deceleration at the end (decreasing step distances)
3. THE Agent SHALL add micro-jitter of 1-3 pixels perpendicular to the movement direction at each step to simulate hand tremor
4. THE Agent SHALL vary the total number of movement steps between 15 and 40 based on the distance to be traveled
5. THE Agent SHALL use bezierMouseMove as the default mouse movement method replacing the current linear humanMouseMove function
6. WHEN generating control points for the bezier curve, THE Agent SHALL randomize their positions within 30-70% of the path length to create natural-looking arcs

---

### Requirement 10: Profile Personality System

**User Story:** As a system operator, I want each profile to be assigned a persistent personality type that determines its engagement behavior, so that profiles exhibit diverse and consistent behavioral patterns that resist coordinated-activity detection.

#### Acceptance Criteria

1. THE Agent SHALL define four personality types: casual-viewer (watch 40-65%, like 5%, comment 1%, subscribe 1%), engaged-fan (watch 80-100%, like 40%, comment 15%, subscribe 10%), speed-browser (watch 20-45%, like 2%, comment 0%, subscribe 0%), and researcher (watch 60-90%, like 15%, comment 5%, subscribe 3%)
2. WHEN a ProfileAgent is constructed, THE Agent SHALL assign a personality type based on a deterministic hash of the profileId to ensure consistency across sessions
3. WHILE a profile has an assigned personality, THE Agent SHALL use that personality's engagement probabilities for like, comment, and subscribe actions instead of hardcoded values
4. WHILE a profile has an assigned personality, THE Agent SHALL use that personality's watch percentage range as the default watchTimeMin and watchTimeMax when config does not override them
5. THE Agent SHALL expose the assigned personality type in the agent status for monitoring purposes

---

### Requirement 11: Human Typing with Typos and Corrections

**User Story:** As a system operator, I want the typing simulation to occasionally make typos and correct them, so that the typing pattern appears more human-like to behavioral analysis systems.

#### Acceptance Criteria

1. WHEN typing each character, THE Agent SHALL have a configurable typo probability (default 10%) of typing an adjacent keyboard character instead of the correct one
2. WHEN a typo is generated, THE Agent SHALL pause for 100-400ms, press Backspace to delete the wrong character, pause for 50-200ms, then type the correct character
3. THE Agent SHALL vary typing speed per character based on character type: faster for common letters, slower for numbers and special characters
4. THE Agent SHALL insert thinking pauses of 300-1200ms between words with a probability of 15-25%
5. THE Agent SHALL NOT generate typos in the first 2 characters of any typed string to avoid triggering autocomplete on wrong prefixes

---

### Phase D: Advanced Realism Features

---

### Requirement 12: Tab Lifecycle Pre-Browse Realism

**User Story:** As a system operator, I want profiles to browse YouTube homepage, trending, or subscriptions pages before navigating to the target video, so that the session history appears natural to YouTube's behavioral analysis.

#### Acceptance Criteria

1. WHEN starting a new video session (first video only), THE Agent SHALL have a 40% probability of performing a pre-browse routine before searching for the target video
2. WHEN pre-browsing is triggered, THE Agent SHALL randomly select one activity from: browse homepage (scroll and pause 5-15s), visit trending page (scroll 2-4 times), or visit subscriptions feed (scroll 1-3 times)
3. WHILE pre-browsing, THE Agent SHALL perform human-like scrolling and mouse movements with random pauses between 2-8 seconds
4. THE Agent SHALL complete the pre-browse routine within a maximum of 45 seconds before proceeding to the target video search
5. THE Agent SHALL NOT perform pre-browse on subsequent videos within the same session (only the first video triggers it)

---

### Requirement 13: Network Timing Randomization

**User Story:** As a system operator, I want random delays injected before page navigation requests, so that the timing pattern of network requests appears consistent with real internet usage variability.

#### Acceptance Criteria

1. WHEN navigating to any URL via page.goto(), THE Agent SHALL inject a random pre-navigation delay between 500ms and 3000ms
2. THE Agent SHALL vary the delay distribution based on the target domain: shorter delays (500-1500ms) for same-domain navigation (youtube.com to youtube.com), longer delays (1500-3000ms) for cross-domain navigation
3. THE Agent SHALL NOT apply network timing delays to internal API calls (MoreLogin_API, analytics tracking)
4. WHILE watching a video, THE Agent SHALL NOT inject additional navigation delays for in-page interactions (scrolling, clicking buttons)

---

### Requirement 14: Complete Search Engine Rewrite with DuckDuckGo and Yahoo Support

**User Story:** As a system operator, I want the search engine module to use unquoted natural queries, single-evaluate atomic clicks, and support DuckDuckGo and Yahoo as additional traffic sources, so that search reliability improves and traffic diversity increases.

#### Acceptance Criteria

1. THE Search_Engine SHALL support six traffic sources: YouTube search, Google, Bing, DuckDuckGo, Yahoo, and channel page
2. WHEN searching via DuckDuckGo, THE Search_Engine SHALL navigate to duckduckgo.com, type the query using humanType, find YouTube links in results, and verify title and channel match before clicking
3. WHEN searching via Yahoo, THE Search_Engine SHALL navigate to search.yahoo.com, type the query using humanType, find YouTube links in results, and verify title and channel match before clicking
4. THE Search_Engine SHALL use the buildExternalQuery function (no quotes, cleaned special characters, max 8 words) for all external search engines (Google, Bing, DuckDuckGo, Yahoo)
5. WHEN clicking a verified YouTube link from any external search engine, THE Search_Engine SHALL use a shared clickVerifiedYouTubeLink helper that checks up to 8 result links for title and channel match
6. THE Search_Engine assignTrafficSource function SHALL accept duckduckgo and yahoo percentages from the trafficMix configuration object
