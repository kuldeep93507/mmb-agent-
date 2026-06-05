# Implementation Plan: Full Profile Creation

## Overview

Implement complete profile creation across all three antidetect browser providers (AdsPower, MoreLogin, Multilogin) with full fingerprint configuration, proxy-based geolocation alignment, cookie import, uniqueness validation, and a recreate feature. The implementation follows a pipeline architecture: proxy assignment → GeoIP resolution → fingerprint generation → uniqueness validation → provider payload mapping → API creation → cookie import. All new modules are server-side CommonJS (.cjs) files under `server/services/`.

## Tasks

- [x] 1. Define extended types and data pools
  - [x] 1.1 Create the ExtendedFingerprintConfig type and data constants file
    - Create `server/services/fingerprintData.cjs` with all predefined pools: user-agent pools (Windows, macOS, Android — at least 10 each), common resolutions per OS, WebGL vendor/renderer pairs per OS, font pool (200+ entries), speech voices pool (60+ entries), country-to-language mapping, and state-to-timezone mapping
    - Export the `ExtendedFingerprintConfig` JSDoc typedef for use across modules
    - _Requirements: 1.1, 1.2, 1.3, 8.3, 8.4, 8.5_

  - [x] 1.2 Extend the frontend FingerprintConfig type in `src/types/index.ts`
    - Add new fields to the existing `FingerprintConfig` interface: `webRTC` (union type), `canvasNoise`, `webGLNoise`, `audioContextNoise` (objects with enabled + seed), `fonts`, `mediaDevices`, `clientRects`, `speechVoices`, `webGLMeta`, `webGPU`
    - Maintain backward compatibility with existing fields
    - _Requirements: 1.1_

- [x] 2. Implement GeoIPResolver service
  - [x] 2.1 Create `server/services/GeoIPResolver.cjs`
    - Implement `resolve(proxyServer)` method that calls ip-api.com (or similar free GeoIP API) to get timezone, language, latitude, longitude, country, region, city
    - Implement 5-second timeout on HTTP request
    - Implement single retry after 2-second delay on rate-limit (HTTP 429) response
    - Implement fallback to defaults on failure: `{ timezone: 'America/New_York', language: 'en-US', latitude: 40.7128, longitude: -74.0060 }`
    - Log warning on fallback with failed IP and reason
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_

  - [ ]* 2.2 Write unit tests for GeoIPResolver
    - Create `server/tests/geoip-resolver.test.cjs`
    - Test successful resolution returns correct GeoData shape
    - Test 5-second timeout triggers fallback
    - Test rate-limit (429) triggers retry then fallback
    - Test invalid response triggers fallback with warning log
    - _Requirements: 2.5, 2.6_

- [x] 3. Implement FingerprintGenerator service
  - [x] 3.1 Create `server/services/FingerprintGenerator.cjs`
    - Implement `generate(os, geoData)` method that produces a complete ExtendedFingerprintConfig
    - Implement `generateNoiseSeed()` — 8-character alphanumeric (a-z, 0-9) unique seed
    - Implement `selectUserAgent(os)` — random selection from OS-appropriate pool (min 10 entries)
    - Implement `selectResolution(os)` — OS-appropriate resolution from predefined list
    - Implement `selectWebGLMeta(os)` — OS-appropriate vendor/renderer pair
    - Implement `deriveWebGPU(webGLMeta)` — maps vendor→vendor, renderer→adapter
    - Implement fonts selection (40-120 entries from pool), mediaDevices (1-4 audio in, 1-3 video in, 1-4 audio out), clientRects (random boolean), speechVoices (20-40 from pool)
    - Set timezone and language from geoData, geolocation from geoData lat/lng (4 decimal places)
    - Handle OS-specific fields: deviceModel/androidVersion for Android, macOsVersion for macOS
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2.2, 2.3, 2.4, 8.3, 8.4, 8.5_

  - [ ]* 3.2 Write property tests for FingerprintGenerator
    - Create `server/tests/fingerprint-generator.property.test.cjs`
    - **Property 1: Fingerprint completeness** — For any OS and valid proxy, all required fields are present and non-null
    - **Validates: Requirements 1.1**

  - [ ]* 3.3 Write property test for OS-specific correctness
    - **Property 2: OS-specific fingerprint correctness** — Windows UA contains "Windows", Android UA contains device model, macOS UA contains "Macintosh"
    - **Validates: Requirements 1.2, 1.3, 8.2, 8.3, 8.4, 8.5**

  - [ ]* 3.4 Write property test for noise seed format
    - **Property 3: Noise seed format and uniqueness** — All seeds are exactly 8 alphanumeric chars; distinct fingerprints have distinct seeds
    - **Validates: Requirements 1.4, 1.5, 1.6**

  - [ ]* 3.5 Write property test for WebRTC mode validity
    - **Property 4: WebRTC mode validity** — webRTC is always one of "disabled", "real", "forward"
    - **Validates: Requirements 1.7**

  - [ ]* 3.6 Write property test for WebGPU derivation
    - **Property 5: WebGPU derived from WebGL** — webGPU.vendor equals webGLMeta.vendor, webGPU.adapter equals webGLMeta.renderer
    - **Validates: Requirements 1.8**

  - [ ]* 3.7 Write property test for geolocation bounds
    - **Property 6: Geolocation bounds and precision** — lat in [-90, 90], lng in [-180, 180], max 4 decimal places
    - **Validates: Requirements 1.9, 2.4**

- [x] 4. Implement ProxyRotator service
  - [x] 4.1 Create `server/services/ProxyRotator.cjs`
    - Implement `assignProxy(life?)` — generates a new proxy with unique session ID not matching any active profile
    - Implement `releaseProxy(profileId)` — removes assignment, returns session ID to available pool
    - Implement `isProxyAvailable(sessionId)` — checks against active assignments
    - Implement `getActiveAssignments()` — returns Map of profileId → ProxyConfig
    - Use existing `generateProxyConfig` logic from `src/utils/generators.ts` adapted for server-side
    - Enforce uniqueness by session ID (all proxies share same server:port, differ by session)
    - _Requirements: 3.1, 3.2, 3.4, 3.5_

  - [ ]* 4.2 Write property tests for ProxyRotator
    - Create `server/tests/proxy-rotator.property.test.cjs`
    - **Property 9: Proxy session uniqueness across profiles** — No two active profiles share the same session ID
    - **Validates: Requirements 3.1, 3.3**

  - [ ]* 4.3 Write property test for proxy release
    - **Property 10: Proxy release on deletion** — After deletion, session ID becomes available for reassignment
    - **Validates: Requirements 3.4, 3.5**

- [x] 5. Implement UniquenessValidator service
  - [x] 5.1 Create `server/services/UniquenessValidator.cjs`
    - Implement `validateFingerprint(config, existingProfiles)` — checks combination of (userAgent, resolution, webGLMeta vendor+renderer, geolocation at 4 decimal places) against all active profiles
    - Implement `validateProxy(sessionId, existingProfiles)` — checks session ID uniqueness
    - Return `{ unique: boolean, conflictField?: string, conflictProfileId?: string }`
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 3.3_

  - [ ]* 5.2 Write property test for fingerprint uniqueness
    - **Property 8: Fingerprint combination uniqueness** — No two fingerprints share the same (userAgent, resolution, webGLMeta, geolocation) combination
    - **Validates: Requirements 1.10, 7.1, 7.4**

- [x] 6. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Implement provider payload mappers
  - [x] 7.1 Add `buildFingerprintPayload(config)` to `server/providers/AdsPowerProvider.cjs`
    - Map ExtendedFingerprintConfig to AdsPower fingerprint_config object: webrtc, ua, screen_resolution, language, timezone, canvas/canvas_seed, webgl_image/webgl_image_seed, audio/audio_seed, location (lat/lng), fonts, media_devices
    - Update `createProfile(options)` to include fingerprint_config in POST body when options.fingerprint is provided
    - Omit undefined/empty fields from payload
    - _Requirements: 4.1, 4.4, 4.6_

  - [x] 7.2 Add `buildFingerprintPayload(config)` to `server/providers/MoreLoginProvider.cjs`
    - Map ExtendedFingerprintConfig to MoreLogin flat fields: timezone, language, resolution, webrtcType (0/1/2), canvasType/canvasSeed, webglType/webglSeed, audioType/audioSeed, latitude, longitude, ua, fontList
    - Update `createProfile(options)` to include fingerprint fields in POST body when options.fingerprint is provided
    - Omit undefined/empty fields from payload
    - _Requirements: 4.2, 4.4, 4.6_

  - [x] 7.3 Add `buildFingerprintPayload(config)` to `server/providers/MultiloginProvider.cjs`
    - Map ExtendedFingerprintConfig to Multilogin nested fingerprint object: timezone.value, language.value, geolocation (lat/lng), webrtc.mode, canvas (mode+seed), webgl (mode+seed), audio (mode+seed), navigator.userAgent, screen.resolution, fonts.families
    - Update `createProfile(options)` to include fingerprint parameters in POST body when options.fingerprint is provided
    - Omit undefined/empty fields from payload
    - _Requirements: 4.3, 4.4, 4.6_

  - [ ]* 7.4 Write property tests for payload mappers
    - Create `server/tests/payload-mapper.property.test.cjs`
    - **Property 11: Provider payload mapping completeness** — For any valid config and any browserType, output contains all required mapped fields with lat in [-90,90] and lng in [-180,180]
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.4**

  - [ ]* 7.5 Write property test for undefined field omission
    - **Property 12: Undefined fields omitted from payload** — Fields that are undefined/empty in input are absent from output payload
    - **Validates: Requirements 4.6**

- [x] 8. Implement CookieImporter service
  - [x] 8.1 Create `server/services/CookieImporter.cjs`
    - Implement `importCookies(profileId, browserType, cookies)` method
    - Route to provider-specific cookie endpoints: AdsPower POST /api/v1/user/cookies, MoreLogin POST /api/env/cookie/import, Multilogin POST /profile/{id}/cookies
    - 10-second timeout on cookie import requests
    - On failure: log warning with profileId and error, return `{ success: false, cookiesImported: false, error }`
    - On success: return `{ success: true, cookiesImported: true }`
    - Skip import if cookies array is empty/null/undefined, return `{ success: true, cookiesImported: false }`
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7_

  - [ ]* 8.2 Write property test for cookie skip on empty input
    - **Property 13: Cookie skip on empty input** — Empty/null/undefined cookies array results in no API call and cookiesImported=false
    - **Validates: Requirements 5.6**

  - [ ]* 8.3 Write unit tests for CookieImporter
    - Create `server/tests/cookie-importer.test.cjs`
    - Test successful import for each provider
    - Test timeout handling (10s)
    - Test failure logging and graceful degradation
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.7_

- [x] 9. Implement ProfileCreator orchestrator
  - [x] 9.1 Create `server/services/ProfileCreator.cjs`
    - Implement `createProfile(options)` orchestrator method
    - Pipeline: validate inputs → assignProxy → resolveGeoIP → generateFingerprint → validateUniqueness (retry up to 3 times) → buildPayload → callProviderAPI → importCookies
    - Handle all error codes from design: -1 (provider error), -5 (invalid browserType), -6 (proxy exhausted), -7 (fingerprint uniqueness exhausted), -10 (timeout)
    - Return unified `CreateProfileResult` with id, name, os, browserType, proxy, fingerprint, cookiesImported
    - No partial state: if any step fails (except cookies), no local record persisted
    - 30-second timeout on provider API calls
    - _Requirements: 1.10, 2.5, 3.2, 4.5, 4.7, 7.2, 7.3, 8.1, 8.2, 8.6_

  - [ ]* 9.2 Write property test for proxy-geo alignment
    - Add to `server/tests/profile-creator.property.test.cjs`
    - **Property 7: Proxy-geo alignment** — For any proxy with known state, timezone matches state-to-timezone mapping and language matches country-to-language mapping
    - **Validates: Requirements 2.2, 2.3**

  - [ ]* 9.3 Write property test for browser type routing
    - **Property 17: Browser type routing correctness** — Creation request is sent to the correct provider based on browserType
    - **Validates: Requirements 8.1, 6.2**

- [x] 10. Implement RecreateHandler service
  - [x] 10.1 Create `server/services/RecreateHandler.cjs`
    - Implement `recreate(options)` method
    - Steps: validate status (reject "recreating"/"starting") → set status "recreating" → stop profile (30s timeout) → delete via provider → create fresh profile (new proxy session, new fingerprint) → return new profile data
    - Preserve original name, OS, browserType, group
    - Error handling: stop timeout → abort (status unchanged); deletion failed → abort (restore status); creation failed after deletion → set "error" status
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9_

  - [ ]* 10.2 Write property test for recreate state guard
    - Add to `server/tests/profile-creator.property.test.cjs`
    - **Property 14: Recreate state guard** — Profiles with status "recreating" or "starting" are rejected; only "running", "stopped", "error" are eligible
    - **Validates: Requirements 6.1, 6.9**

  - [ ]* 10.3 Write property test for recreate preserves identity
    - **Property 15: Recreate preserves identity fields** — New profile has same name, OS, browserType as original
    - **Validates: Requirements 6.4**

  - [ ]* 10.4 Write property test for recreate fresh identity
    - **Property 16: Recreate produces fresh identity** — New proxy session ID and noise seeds all differ from deleted profile
    - **Validates: Requirements 6.3**

  - [ ]* 10.5 Write unit tests for RecreateHandler error scenarios
    - Create `server/tests/recreate-handler.test.cjs`
    - Test stop timeout aborts recreate
    - Test deletion failure restores previous status
    - Test creation failure after deletion sets "error" status
    - _Requirements: 6.6, 6.7, 6.8_

- [x] 11. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 12. Wire API endpoints and integrate with frontend
  - [x] 12.1 Add API routes to `server/providers/profileRouter.cjs`
    - Add `POST /api/profiles/create-full` endpoint that accepts CreateFullProfileRequest body (name, os, browserType, proxyLife, cookies, groupId) and calls ProfileCreator.createProfile()
    - Add `POST /api/profiles/recreate` endpoint that accepts RecreateProfileRequest body (profileId, browserType, cookies) and calls RecreateHandler.recreate()
    - Validate request bodies, return appropriate HTTP status codes per error table in design
    - _Requirements: 4.5, 4.7, 8.1, 8.6_

  - [x] 12.2 Add frontend API methods in `src/services/backendApi.ts`
    - Add `createFullProfile(options)` method calling POST /api/profiles/create-full
    - Add `recreateProfile(profileId, browserType, cookies?)` method calling POST /api/profiles/recreate
    - Handle error responses and surface error messages to UI
    - _Requirements: 4.5, 6.1_

  - [ ]* 12.3 Write integration tests for API endpoints
    - Create `server/tests/profile-creation-integration.test.cjs`
    - Test full creation pipeline with mocked provider APIs
    - Test recreate flow with mocked provider APIs
    - Test error responses (invalid browserType, proxy exhaustion, provider timeout)
    - _Requirements: 4.5, 4.7, 8.6_

- [x] 13. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties using fast-check (already installed)
- Unit tests validate specific scenarios and edge cases
- All server modules use CommonJS (.cjs) format to match existing project conventions
- The `ExtendedFingerprintConfig` extends the existing `FingerprintConfig` — backward compatibility is maintained
- Provider payload mappers are added to existing provider files, not new files
- The ProxyRotator uses session ID uniqueness (not server:port) since all proxies share the same SmartProxy endpoint

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["2.1", "3.1", "4.1"] },
    { "id": 2, "tasks": ["2.2", "3.2", "3.3", "3.4", "3.5", "3.6", "3.7", "4.2", "4.3", "5.1"] },
    { "id": 3, "tasks": ["5.2", "7.1", "7.2", "7.3"] },
    { "id": 4, "tasks": ["7.4", "7.5", "8.1"] },
    { "id": 5, "tasks": ["8.2", "8.3", "9.1"] },
    { "id": 6, "tasks": ["9.2", "9.3", "10.1"] },
    { "id": 7, "tasks": ["10.2", "10.3", "10.4", "10.5"] },
    { "id": 8, "tasks": ["12.1", "12.2"] },
    { "id": 9, "tasks": ["12.3"] }
  ]
}
```
