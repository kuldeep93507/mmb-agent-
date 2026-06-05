# Bugfix Requirements Document

## Introduction

This document covers 8 bugs identified in the MMB-AGENT YouTube automation engine. The bugs range from critical (infinite retry loops, zombie processes) to low priority (dead code). These defects affect reliability, memory management, search accuracy, analytics tracking, and code maintainability across the core server modules: `agent.cjs`, `worker.cjs`, `searchEngine.cjs`, `orchestrator.cjs`, and `index.cjs`.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN `searchAndWatch()` in agent.cjs fails and retries recursively THEN the system resets `retryCount` to 0 on each recursive call because `_isRetrying` flag is cleared at the start of the method, causing an infinite retry loop that never reaches `maxRetries`

1.2 WHEN `agent.disconnect()` throws an error during worker cleanup in worker.cjs THEN the system never calls `moreloginRequest('/api/env/close')`, leaving the MoreLogin browser process alive as a zombie consuming RAM indefinitely

1.3 WHEN `findAndVerifyVideo()` in searchEngine.cjs collects DOM results via `page.evaluate()` and then re-queries elements via `page.$$('ytd-video-renderer a#video-title')` THEN the system may click the wrong video because YouTube's DOM can change between the two calls (lazy loading, ad insertion, result reordering)

1.4 WHEN video titles contain special characters like `[](){}:!?` and Google/Bing search queries wrap the title in double quotes THEN the system returns 0 search results because quoted queries with special characters produce false negatives on search engines

1.5 WHEN `MORELOGIN_API_KEY` needs to be updated THEN the system requires changes in both `server/index.cjs` and `server/worker.cjs` independently, creating a sync risk where one file gets updated but the other does not

1.6 WHEN a worker crashes and the orchestrator restarts it with `videos.slice(completedCount)` THEN the system references the original `videos` array parameter rather than tracking remaining videos in `workerState`, causing already-watched videos to be replayed after crash recovery (triggering YouTube spam detection)

1.7 WHEN `watchByUrl()` in agent.cjs calls `trackEngagement(this.profileId, 'watchTime')` THEN the system tracks watch time as value `1` (default) instead of the actual seconds watched because no value parameter is passed

1.8 WHEN `watchVideo()` in agent.cjs executes THEN the system generates `const seed = Math.random()` that is never used anywhere in the function, constituting dead code that adds confusion

### Expected Behavior (Correct)

2.1 WHEN `searchAndWatch()` fails and retries recursively THEN the system SHALL use a depth parameter to track retry count across recursive calls, incrementing on each retry and stopping when depth reaches `maxRetries`

2.2 WHEN worker cleanup runs in worker.cjs THEN the system SHALL always call `moreloginRequest('/api/env/close')` in a finally block regardless of whether `agent.disconnect()` succeeds or throws

2.3 WHEN `findAndVerifyVideo()` identifies the correct video in search results THEN the system SHALL use a single `page.evaluate()` context to both find and click the matching element, eliminating the race condition between DOM reads

2.4 WHEN constructing Google/Bing search queries for video titles with special characters THEN the system SHALL remove double quotes from the query, strip special characters `[](){}:!?`, and use a natural keyword-based query format

2.5 WHEN the MoreLogin API key is needed THEN the system SHALL read it from a single centralized config source (config.cjs or environment variable) so that updates only need to happen in one place

2.6 WHEN a worker crashes and the orchestrator restarts it THEN the system SHALL store the remaining videos array in `workerState` and use that stored reference on restart, ensuring already-watched videos are not replayed

2.7 WHEN `watchByUrl()` tracks watch time analytics THEN the system SHALL pass the actual watch time in seconds as the value parameter to `trackEngagement(this.profileId, 'watchTime', actualSeconds)`

2.8 WHEN `watchVideo()` executes THEN the system SHALL either remove the unused `seed` variable or use it to derive consistent per-call randomness for the behavior pattern within that function

### Unchanged Behavior (Regression Prevention)

3.1 WHEN `searchAndWatch()` succeeds on the first attempt (no retry needed) THEN the system SHALL CONTINUE TO return `true` and track analytics normally without any retry logic executing

3.2 WHEN `agent.disconnect()` succeeds without error in worker.cjs THEN the system SHALL CONTINUE TO close the MoreLogin browser profile and report completion normally

3.3 WHEN `findAndVerifyVideo()` finds an exact title match in the first set of visible results (no DOM change occurs) THEN the system SHALL CONTINUE TO click the correct video and return `true`

3.4 WHEN video titles contain only alphanumeric characters and spaces (no special characters) THEN the system SHALL CONTINUE TO search and find videos successfully via Google/Bing with the existing query strategy

3.5 WHEN the MoreLogin API key is used for HTTP requests to `127.0.0.1:40000` THEN the system SHALL CONTINUE TO authenticate successfully with the same key value as before

3.6 WHEN a worker completes all videos without crashing THEN the system SHALL CONTINUE TO report results normally without any change to the video queue management

3.7 WHEN `searchAndWatch()` tracks watch time via `trackEngagement` THEN the system SHALL CONTINUE TO pass the correct watch time value in seconds (this path already works correctly)

3.8 WHEN `watchVideo()` generates unique behavior patterns (comment scroll chance, related peek chance) THEN the system SHALL CONTINUE TO produce varied human-like behavior per call using `Math.random()` for those values
