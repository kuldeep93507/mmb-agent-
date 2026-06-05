# Implementation Plan: Multi-Browser Support

## Overview

This plan implements the provider pattern for multi-browser antidetect support (MoreLogin, AdsPower, Multilogin) across both the main YouTube app and MMB AGENT SITES sub-project. The implementation is organized in 6 independent phases: base setup, MoreLogin wrapper, AdsPower integration, Multilogin integration, frontend UI updates, and testing.

## Tasks

- [x] 1. PHASE 1: Base Setup (BrowserProvider + ProviderFactory + Environment Config)

  - [x] 1.1 Create BrowserProvider abstract base class
    - Create `server/providers/BrowserProvider.cjs`
    - Define abstract methods: createProfile(options), startProfile(profileId), stopProfile(profileId), deleteProfile(profileId), listProfiles(pageNo, pageSize), getProfileStatus(profileId)
    - Implement shared `makeRequest(url, options)` utility with timeout (10s default) and retry logic (3 retries, exponential backoff: 1s, 2s, 4s for 429 responses)
    - Implement shared `handleError(error)` that maps errors to standardized codes: -1 (connection/timeout), -2 (auth), -3 (rate limit exhausted), -5 (validation)
    - Implement `validateProxy(proxy)` that checks server and port are present, returns code -5 error if missing
    - All methods return `{ code, message, data }` standardized response format
    - _Requirements: 1.1, 1.2, 1.3, 8.1, 8.2, 8.3, 8.4, 10.5_

  - [x] 1.2 Create ProviderFactory module
    - Create `server/providers/ProviderFactory.cjs`
    - Implement `getProvider(providerName)` that resolves: param > process.env.BROWSER_PROVIDER > "morelogin" default
    - Validate provider name is one of "morelogin", "adspower", "multilogin" — throw descriptive error if invalid
    - Implement `validateConfig(providerName)` that checks required env vars per provider and throws if missing/empty
    - Cache provider instances in a Map (singleton per provider name)
    - Required env vars: MoreLogin (MORELOGIN_API_KEY), AdsPower (ADSPOWER_API_URL), Multilogin (MULTILOGIN_EMAIL, MULTILOGIN_PASSWORD, MULTILOGIN_FOLDER_ID)
    - _Requirements: 1.6, 1.7, 5.3, 5.5, 5.6, 5.7_

  - [x] 1.3 Update .env.example with all new environment variables
    - Add BROWSER_PROVIDER with comment (accepted: morelogin, adspower, multilogin)
    - Add ADSPOWER_API_URL with default value and comment
    - Add MULTILOGIN_EMAIL, MULTILOGIN_PASSWORD, MULTILOGIN_FOLDER_ID with placeholder values and comments
    - Keep existing MoreLogin variables unchanged
    - _Requirements: 5.1, 5.2, 5.3, 5.4_

  - [x] 1.4 Create profileRouter Express router
    - Create `server/providers/profileRouter.cjs`
    - Implement POST /api/profiles/list — accepts `provider` query param, delegates to factory.getProvider(provider).listProfiles()
    - Implement POST /api/profiles/create — delegates to provider.createProfile(req.body)
    - Implement POST /api/profiles/start — delegates to provider.startProfile(req.body.profileId)
    - Implement POST /api/profiles/stop — delegates to provider.stopProfile(req.body.profileId)
    - Implement POST /api/profiles/delete — delegates to provider.deleteProfile(req.body.profileId)
    - Return HTTP 200 for code===0, HTTP 400 for invalid provider, HTTP 502 for provider errors
    - Log every operation with timestamp, provider, profileId, operation, result
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 8.5_

  - [x] 1.5 Mount profileRouter in server/index.cjs
    - Require profileRouter at top of file
    - Mount with `app.use(profileRouter)` after existing middleware
    - Keep all existing routes unchanged
    - _Requirements: 7.1_

  - [x] 1.6 Mount profileRouter in MMB AGENT SITES/server/index.cjs
    - Require profileRouter using relative path `../../server/providers/profileRouter.cjs`
    - Mount with `app.use(profileRouter)` after existing middleware
    - Keep all existing routes unchanged
    - _Requirements: 7.1_

- [x] 2. Checkpoint — Verify Phase 1
  - Ensure server starts without errors with default BROWSER_PROVIDER=morelogin or no BROWSER_PROVIDER set
  - Verify profileRouter responds to requests (can test with curl or manual check)
  - Ensure all tests pass, ask the user if questions arise.

- [x] 3. PHASE 2: MoreLogin Provider Wrapper (Backward Compatible)

  - [x] 3.1 Create MoreLoginProvider class
    - Create `server/providers/MoreLoginProvider.cjs`
    - Extend BrowserProvider base class
    - Delegate all API calls to the existing `moreloginRequest()` function pattern (http module, POST to 127.0.0.1:40000)
    - Read MORELOGIN_API_KEY from process.env (fallback to hardcoded key for backward compat)
    - Read MORELOGIN_PORT from process.env (default: 40000)
    - _Requirements: 4.1, 4.4_

  - [x] 3.2 Implement MoreLoginProvider method mappings
    - `listProfiles(pageNo, pageSize)` → POST /api/env/page with {pageNo, pageSize}, map response dataList to StandardProfile array (id, envName→name, status, debugPort, browserType:"morelogin")
    - `createProfile(options)` → POST /api/env/create/quick, map proxy fields (server→proxyIp, port→proxyPort, username, password, protocol→proxyType)
    - `startProfile(profileId)` → POST /api/env/start with {envId: profileId}, return cdpPort from debugPort field
    - `stopProfile(profileId)` → POST /api/env/close with {envId: profileId}
    - `deleteProfile(profileId)` → POST /api/env/removeToRecycleBin/batch with {envIds: [profileId]}
    - `getProfileStatus(profileId)` → POST /api/env/status with {envId: profileId}
    - Map MoreLogin response (code, msg, data) → StandardResponse (code, message, data)
    - Return error with message "MoreLogin application must be started" on connection refused
    - _Requirements: 4.1, 4.2, 4.3, 4.5, 4.6, 10.4_

- [x] 4. Checkpoint — Verify Phase 2
  - Ensure MoreLoginProvider returns same data as existing direct moreloginRequest calls
  - Test via profileRouter endpoints with provider=morelogin (or no provider param)
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. PHASE 3: AdsPower Provider Implementation

  - [x] 5.1 Create AdsPowerProvider class
    - Create `server/providers/AdsPowerProvider.cjs`
    - Extend BrowserProvider base class
    - Read ADSPOWER_API_URL from process.env (default: "http://local.adspower.com:50325")
    - Use base class makeRequest for HTTP calls with 5s connect timeout, 30s start timeout
    - _Requirements: 2.7_

  - [x] 5.2 Implement AdsPowerProvider methods
    - `listProfiles(pageNo, pageSize)` → GET /api/v1/user/list?page={pageNo}&page_size={pageSize}, map user_id→id, name→name, browserType:"adspower"
    - `createProfile(options)` → POST /api/v1/user/create, map proxy to user_proxy_config (proxy_soft, proxy_type, proxy_host, proxy_port, proxy_user, proxy_password), return created user_id as id
    - `startProfile(profileId)` → GET /api/v1/browser/start?user_id={profileId}, return debug_port as cdpPort (handle already-running case: return existing port)
    - `stopProfile(profileId)` → GET /api/v1/browser/stop?user_id={profileId}
    - `deleteProfile(profileId)` → POST /api/v1/user/delete with {user_ids: [profileId]}
    - `getProfileStatus(profileId)` → GET /api/v1/browser/active?user_id={profileId}
    - Map AdsPower error responses (non-zero code, msg field) to standardized error
    - Return error with message "AdsPower application must be started" on connection refused/timeout
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 10.1_

- [x] 6. Checkpoint — Verify Phase 3
  - Test AdsPower provider via profileRouter with provider=adspower query param
  - Verify error handling when AdsPower app is not running (should return code -1 with descriptive message)
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. PHASE 4: Multilogin Provider Implementation

  - [x] 7.1 Create MultiloginProvider class with token management
    - Create `server/providers/MultiloginProvider.cjs`
    - Extend BrowserProvider base class
    - Read MULTILOGIN_EMAIL, MULTILOGIN_PASSWORD, MULTILOGIN_FOLDER_ID from process.env
    - Implement `authenticate()` → POST https://api.multilogin.com/user/signin with {email, password}, store token + calculate 25-min expiry (refresh before 30-min actual expiry)
    - Implement `refreshToken()` → called on 401 response, retry signin once, return code -4 if refresh fails
    - Implement `getAuthHeaders()` → returns { Authorization: `Bearer ${token}` }, auto-authenticates on first call
    - Validate MULTILOGIN_FOLDER_ID is set, return error at startup if missing
    - _Requirements: 3.7, 3.9, 3.10, 3.11_

  - [x] 7.2 Implement MultiloginProvider profile methods
    - `listProfiles(pageNo, pageSize)` → POST https://api.multilogin.com/profile/search with {offset: (pageNo-1)*pageSize, limit: pageSize, folder_id}, map profile_id→id, name→name, browserType:"multilogin"
    - `createProfile(options)` → POST https://api.multilogin.com/profile/create with {folder_id, browser_type, parameters: {proxy: {host, port, username, password, type}}}
    - `startProfile(profileId)` → GET https://launcher.mlx.yt:45001/api/v2/profile/f/{folder_id}/p/{profileId}/start?automation_type=playwright, return port as cdpPort (30s timeout)
    - `stopProfile(profileId)` → GET https://launcher.mlx.yt:45001/api/v1/profile/stop?profile_id={profileId} (15s timeout)
    - `deleteProfile(profileId)` → POST https://api.multilogin.com/profile/remove with {profile_ids: [profileId]}
    - On 401 response: call refreshToken(), retry request once
    - Return error with message "Multilogin launcher must be connected" on launcher connection refused
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.8, 10.2_

- [x] 8. Checkpoint — Verify Phase 4
  - Test Multilogin provider via profileRouter with provider=multilogin query param
  - Verify token refresh flow works (simulate expired token scenario)
  - Verify error handling when launcher is not running
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. PHASE 5: Frontend UI Updates

  - [x] 9.1 Create browserProviderApi.ts service for main app
    - Create `src/services/browserProviderApi.ts`
    - Define TypeScript interfaces: StandardResponse, StandardProfile, CreateProfileOptions, ProxyConfig
    - Implement functions: listProfiles(provider, pageNo, pageSize), createProfile(provider, options), startProfile(provider, profileId), stopProfile(provider, profileId), deleteProfile(provider, profileId)
    - All functions call backend /api/profiles/* endpoints with ?provider= query param
    - Use existing fetch pattern from moreloginApi.ts (relative URLs via Vite proxy)
    - _Requirements: 6.3, 7.2_

  - [x] 9.2 Create browserProviderApi.ts service for MMB AGENT SITES
    - Create `MMB AGENT SITES/src/services/browserProviderApi.ts`
    - Same interface and implementation as main app version
    - Use the MMB AGENT SITES backend URL pattern (/backend-api prefix or direct port 3200)
    - _Requirements: 6.3, 7.2_

  - [x] 9.3 Update main app useStore.ts with browserProvider state
    - Add `browserProvider` state field (type: "morelogin" | "adspower" | "multilogin")
    - Initialize from localStorage key "mmb_browser_provider" (default: "morelogin")
    - Add `setBrowserProvider(provider)` action that: updates state, persists to localStorage, clears profiles, sets loading=true, calls fetchProfiles with new provider
    - Update `fetchProfiles()` to use browserProviderApi with current browserProvider value
    - On fetch failure after provider change: keep empty profiles, set loading=false, log error with provider name
    - _Requirements: 6.1, 6.2, 6.5, 6.6, 6.7_

  - [x] 9.4 Update MMB AGENT SITES useStore.ts with browserProvider state
    - Add `browserProvider` state field (type: "morelogin" | "adspower" | "multilogin")
    - Initialize from localStorage key "mmb_browser_provider" (default: "morelogin")
    - Add `setBrowserProvider(provider)` action with same logic as main app
    - Update `fetchProfiles()` to use browserProviderApi with current browserProvider value
    - _Requirements: 6.1, 6.2, 6.5, 6.6, 6.7_

  - [x] 9.5 Update main app SettingsPage with browser provider dropdown
    - Add "Browser Provider" section to the existing SettingsPage component (src/components/SettingsPage.tsx or equivalent)
    - Render a dropdown/select with options: MoreLogin, AdsPower, Multilogin
    - Show current active provider with a green indicator
    - On change: call store.setBrowserProvider(value)
    - Show provider-specific connection info (MoreLogin: localhost:40000, AdsPower: local.adspower.com:50325, Multilogin: api.multilogin.com)
    - _Requirements: 6.2_

  - [x] 9.6 Update MMB AGENT SITES SettingsPage with browser provider dropdown
    - Replace the "Coming Soon" anti-detect browser section with a functional dropdown
    - Same UI pattern as main app: dropdown with MoreLogin/AdsPower/Multilogin options
    - On change: call store.setBrowserProvider(value)
    - Show active provider status indicator
    - _Requirements: 6.2_

  - [x] 9.7 Update ProfilesPage to show active browser provider
    - In both main app and MMB AGENT SITES ProfilesPage components
    - Display the active browser provider name in the header area (e.g., "Profiles (AdsPower)" or a badge)
    - Show alongside the profile count summary
    - _Requirements: 6.4_

- [x] 10. Checkpoint — Verify Phase 5
  - Verify frontend builds without TypeScript errors
  - Test provider switching in UI persists to localStorage and triggers re-fetch
  - Ensure all tests pass, ask the user if questions arise.

- [x] 11. PHASE 6: Testing

  - [x] 11.1 Create integration test script
    - Create `server/test-browsers.cjs`
    - Test flow per provider: list → create → start → verify cdpPort → stop → delete
    - Skip unconfigured providers with clear message (check env vars before testing)
    - 30-second timeout per operation
    - Always attempt cleanup (delete created profile) regardless of intermediate failures
    - Skip dependent operations if create fails (can't start/stop/delete without a profile)
    - Output summary table: provider | operation | pass/fail/skipped
    - Exit code 0 if all pass, 1 if any fail
    - Executable via: `node server/test-browsers.cjs`
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7_

  - [ ]* 11.2 Write property test: Response Structure Invariant (Property 1)
    - **Property 1: Response Structure Invariant**
    - **Validates: Requirements 1.2, 1.3**
    - Use fast-check to generate random method calls on all providers (mocked)
    - Assert: response always has code (number), message (string, ≤256 chars), data (object when code===0, null when code!==0)
    - Assert: profile objects have id (string), name (string), status (enum), debugPort (number|null), browserType (enum)

  - [ ]* 11.3 Write property test: CDP Port Range Invariant (Property 2)
    - **Property 2: CDP Port Range Invariant**
    - **Validates: Requirements 1.4**
    - For any successful startProfile response (code===0), assert data.cdpPort is integer between 1024 and 65535

  - [ ]* 11.4 Write property test: Factory Routing Correctness (Property 3)
    - **Property 3: Factory Routing Correctness**
    - **Validates: Requirements 1.6, 1.7, 7.1**
    - For any valid provider name, factory returns correct class instance
    - For invalid/empty name with no env var, factory returns MoreLoginProvider

  - [ ]* 11.5 Write property test: Proxy Mapping Correctness (Property 5)
    - **Property 5: Proxy Mapping Correctness**
    - **Validates: Requirements 10.1, 10.2, 10.4**
    - Generate random valid proxy configs (server, port, username, password, protocol)
    - Assert each provider maps to correct provider-specific field names

  - [ ]* 11.6 Write property test: Proxy Validation Guard (Property 6)
    - **Property 6: Proxy Validation Guard**
    - **Validates: Requirements 10.5**
    - Generate proxy objects with missing server or port
    - Assert createProfile returns code -5 without making HTTP request

  - [ ]* 11.7 Write property test: Configuration Validation (Property 10)
    - **Property 10: Configuration Validation**
    - **Validates: Requirements 5.3, 5.5, 5.6, 5.7**
    - Generate random invalid provider names, assert factory throws with accepted values listed
    - Generate scenarios with missing env vars, assert factory throws with variable name and provider name

- [x] 12. Final Checkpoint
  - Run `node server/test-browsers.cjs` to verify integration test works
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each phase is independently testable after completion
- Phase 2 (MoreLogin wrapper) maintains full backward compatibility — no existing behavior changes
- The profileRouter.cjs is shared between both sub-projects (mounted in both server/index.cjs files)
- All server code uses CommonJS (.cjs), all frontend code uses TypeScript
- Property tests use fast-check library and validate correctness properties from the design document
- Checkpoints ensure incremental validation between phases

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.3"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["1.4"] },
    { "id": 3, "tasks": ["1.5", "1.6"] },
    { "id": 4, "tasks": ["3.1"] },
    { "id": 5, "tasks": ["3.2"] },
    { "id": 6, "tasks": ["5.1"] },
    { "id": 7, "tasks": ["5.2"] },
    { "id": 8, "tasks": ["7.1"] },
    { "id": 9, "tasks": ["7.2"] },
    { "id": 10, "tasks": ["9.1", "9.2"] },
    { "id": 11, "tasks": ["9.3", "9.4"] },
    { "id": 12, "tasks": ["9.5", "9.6", "9.7"] },
    { "id": 13, "tasks": ["11.1"] },
    { "id": 14, "tasks": ["11.2", "11.3", "11.4", "11.5", "11.6", "11.7"] }
  ]
}
```
  

