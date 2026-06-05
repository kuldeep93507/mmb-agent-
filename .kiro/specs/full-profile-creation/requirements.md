# Requirements Document

## Introduction

Full profile creation support across all antidetect browsers (AdsPower, Multilogin, MoreLogin) with complete fingerprint configuration, proxy-based geolocation alignment, cookie import, and a recreate feature. Currently, profile creation only passes proxy settings but omits fingerprint configuration, causing mismatches between the proxy IP location and browser-reported identity (timezone, WebRTC, geolocation). This feature ensures every profile is created with a fully configured, unique fingerprint that matches its assigned proxy.

## Glossary

- **Profile_Creator**: The server-side service responsible for assembling and sending complete profile creation requests to antidetect browser APIs
- **Fingerprint_Generator**: The module that generates unique fingerprint configurations (user-agent, timezone, WebRTC, canvas noise, etc.) for each profile
- **Proxy_Rotator**: The module that assigns a unique, unused proxy to each profile from the available proxy pool
- **GeoIP_Resolver**: The module that determines timezone, language, and geolocation coordinates from a proxy IP address
- **Cookie_Importer**: The module that imports pre-configured cookies into a newly created profile via browser-specific APIs
- **Recreate_Handler**: The module that orchestrates deletion of an existing profile and creation of a replacement with fresh proxy, fingerprint, and cookies
- **Uniqueness_Validator**: The module that verifies no two active profiles share the same proxy or fingerprint combination
- **Provider_Adapter**: The abstraction layer (AdsPowerProvider, MoreLoginProvider, MultiloginProvider) that translates unified profile options into browser-specific API payloads
- **Fingerprint_Config**: A data object containing all browser identity parameters (user-agent, timezone, language, resolution, WebRTC mode, canvas noise, WebGL, AudioContext, geolocation, fonts, media devices, ClientRects, SpeechVoices, WebGPU)
- **Profile**: A browser instance configuration stored in an antidetect browser, identified by a unique ID

## Requirements

### Requirement 1: Complete Fingerprint Generation

**User Story:** As a user, I want every new profile to receive a unique, fully randomized fingerprint, so that each browser instance has a distinct identity that cannot be correlated with other profiles.

#### Acceptance Criteria

1. WHEN a profile creation is requested, THE Fingerprint_Generator SHALL produce a Fingerprint_Config containing all of the following fields: userAgent, timezone, language, resolution, webRTC mode, canvas noise seed, WebGL image noise seed, AudioContext noise seed, geolocation coordinates (latitude and longitude), fonts setting (list of font family names, between 40 and 120 entries selected from a predefined pool), media devices count (between 1 and 4 audio inputs, 1 and 3 video inputs, and 1 and 4 audio outputs), ClientRects noise flag (enabled or disabled), SpeechVoices setting (a subset of 20 to 40 voices selected from a predefined pool), WebGL metadata (vendor and renderer strings), and WebGPU configuration (vendor and adapter strings)
2. WHEN generating a userAgent, THE Fingerprint_Generator SHALL select a random user-agent string from a predefined pool of at least 10 entries that matches the specified operating system (Windows, macOS, or Android)
3. WHEN generating a screen resolution, THE Fingerprint_Generator SHALL select randomly from a predefined list of common resolutions (1920x1080, 1366x768, 1536x864, 1440x900, 1280x720, 2560x1440)
4. THE Fingerprint_Generator SHALL set canvas noise to enabled with a unique 8-character alphanumeric seed value for every generated Fingerprint_Config
5. THE Fingerprint_Generator SHALL set WebGL image noise to enabled with a unique 8-character alphanumeric seed value for every generated Fingerprint_Config
6. THE Fingerprint_Generator SHALL set AudioContext noise to enabled with a unique 8-character alphanumeric seed value for every generated Fingerprint_Config
7. WHEN generating WebRTC mode, THE Fingerprint_Generator SHALL select one of: disabled, real, or forward
8. WHEN generating WebGPU configuration, THE Fingerprint_Generator SHALL derive WebGPU vendor and adapter values by mapping the selected WebGL metadata vendor to the WebGPU vendor field and the selected WebGL renderer to the WebGPU adapter field
9. WHEN generating geolocation coordinates, THE Fingerprint_Generator SHALL produce a latitude value between -90.0 and 90.0 and a longitude value between -180.0 and 180.0, with precision to 4 decimal places, derived from the proxy's assigned geographic state
10. IF the Fingerprint_Generator produces a Fingerprint_Config with a userAgent, canvas noise seed, WebGL noise seed, or AudioContext noise seed identical to any existing profile in the system, THEN THE Fingerprint_Generator SHALL regenerate the duplicated field until it is unique

### Requirement 2: Proxy-Based Geolocation Alignment

**User Story:** As a user, I want the profile timezone, language, and geolocation to automatically match the assigned proxy IP location, so that websites cannot detect a mismatch between my IP and browser settings.

#### Acceptance Criteria

1. WHEN a proxy is assigned to a profile, THE GeoIP_Resolver SHALL determine the geographic location (country, region, city, latitude, longitude, IANA timezone) from the proxy server IP address within 5 seconds
2. WHEN the GeoIP_Resolver returns location data, THE Fingerprint_Generator SHALL set the timezone field to the IANA timezone string returned by the GeoIP_Resolver for the proxy location
3. WHEN the GeoIP_Resolver returns location data, THE Fingerprint_Generator SHALL set the language field to the BCP-47 language tag mapped from the proxy location's country code using a predefined country-to-language lookup table (e.g., US → en-US, DE → de-DE, FR → fr-FR, BR → pt-BR)
4. WHEN the GeoIP_Resolver returns location data, THE Fingerprint_Generator SHALL set the geolocation coordinates to the latitude and longitude values returned by the GeoIP_Resolver, preserving at least 4 decimal places of precision
5. IF the GeoIP_Resolver fails to resolve location from the proxy IP (due to HTTP error, response timeout exceeding 5 seconds, or invalid/missing fields in the response), THEN THE Profile_Creator SHALL use default values (timezone: America/New_York, language: en-US, latitude: 40.7128, longitude: -74.0060) and log a warning indicating the failed IP address and the failure reason
6. IF the GeoIP_Resolver encounters a rate-limit response during resolution, THEN THE GeoIP_Resolver SHALL retry the request once after a 2-second delay before falling back to default values

### Requirement 3: Unique Proxy Assignment

**User Story:** As a user, I want every profile to receive a different proxy, so that no two profiles share the same IP address and risk detection.

#### Acceptance Criteria

1. WHEN a new profile is created, THE Proxy_Rotator SHALL assign a proxy whose server and port combination is not currently assigned to any other profile with status "running", "stopped", "starting", "error", or "recreating"
2. IF no unused proxy is available in the pool, THEN THE Proxy_Rotator SHALL return an error indicating proxy pool exhaustion and prevent profile creation without modifying any existing profile assignments
3. WHEN the Uniqueness_Validator checks the assigned proxy, THE Uniqueness_Validator SHALL reject the assignment and block profile creation if the server and port combination matches any existing profile with status "running", "stopped", "starting", "error", or "recreating"
4. WHEN a profile is deleted, THE Proxy_Rotator SHALL release the profile's proxy server and port combination back to the available pool within 5 seconds
5. IF a proxy's expiresAt timestamp has passed and the proxy is not assigned to any active profile, THEN THE Proxy_Rotator SHALL mark that proxy as available for reassignment

### Requirement 4: Complete Profile Creation via Provider APIs

**User Story:** As a user, I want profile creation to pass ALL settings (proxy AND fingerprint) to the antidetect browser API, so that the browser opens with the correct identity from the start.

#### Acceptance Criteria

1. WHEN creating a profile on AdsPower, THE Provider_Adapter SHALL include the fingerprint_config object in the POST /api/v1/user/create request body containing: webrtc, timezone, language, screen resolution, canvas noise, WebGL noise, AudioContext noise, geolocation (latitude and longitude as decimal numbers in the range -90 to 90 and -180 to 180 respectively), user-agent, fonts, and media devices settings, where each field maps from the application's FingerprintConfig to the corresponding AdsPower API field name
2. WHEN creating a profile on MoreLogin, THE Provider_Adapter SHALL include fingerprint fields in the POST /api/env/create/quick request body containing: timezone, language, resolution, WebRTC mode, canvas noise, WebGL noise, AudioContext noise, geolocation (latitude and longitude as decimal numbers in the range -90 to 90 and -180 to 180 respectively), user-agent, and fonts settings, where each field maps from the application's FingerprintConfig to the corresponding MoreLogin API field name
3. WHEN creating a profile on Multilogin, THE Provider_Adapter SHALL include fingerprint parameters in the POST /profile/create request body containing: timezone, language, geolocation (latitude and longitude as decimal numbers in the range -90 to 90 and -180 to 180 respectively), WebRTC mode, canvas noise, WebGL noise, AudioContext noise, user-agent, screen resolution, and fonts settings, where each field maps from the application's FingerprintConfig to the corresponding Multilogin API field name
4. WHEN creating a profile on any provider, THE Provider_Adapter SHALL include the proxy configuration (server, port, username, password, protocol) in the creation request, where protocol is one of: http, https, or socks5
5. IF the provider API returns a non-success response code during profile creation, THEN THE Profile_Creator SHALL return the provider's error message to the caller and SHALL NOT persist any local profile record
6. IF any fingerprint field value in the FingerprintConfig is empty or undefined, THEN THE Provider_Adapter SHALL omit that field from the creation request body so the provider applies its own default
7. WHEN creating a profile on any provider, THE Provider_Adapter SHALL send the creation request within 10 seconds, and IF the provider does not respond within 30 seconds, THEN THE Provider_Adapter SHALL return a timeout error message to the caller

### Requirement 5: Cookie Import at Creation Time

**User Story:** As a user, I want high RPM/CPC cookies to be imported into each new profile at creation time, so that the browser starts with pre-warmed cookies for better ad performance.

#### Acceptance Criteria

1. WHEN a profile is successfully created and a non-empty cookies array is provided in the creation options, THE Cookie_Importer SHALL import the cookies into the new profile via the browser-specific cookie import API within 10 seconds
2. WHEN importing cookies on AdsPower, THE Cookie_Importer SHALL use the AdsPower cookie import endpoint with the profile user_id and cookie data in Netscape or JSON format
3. WHEN importing cookies on MoreLogin, THE Cookie_Importer SHALL use the MoreLogin cookie import endpoint with the profile envId and cookie data
4. WHEN importing cookies on Multilogin, THE Cookie_Importer SHALL use the Multilogin cookie import endpoint with the profile_id and cookie data
5. IF cookie import fails or times out, THEN THE Cookie_Importer SHALL log a warning containing the profile ID and error reason, set the cookiesImported field to false in the creation response, and allow the profile creation to complete successfully
6. IF no cookies array is provided or the cookies array is empty, THEN THE Cookie_Importer SHALL skip the import step and set the cookiesImported field to false in the creation response
7. WHEN cookie import succeeds, THE Cookie_Importer SHALL set the cookiesImported field to true in the creation response

### Requirement 6: Profile Recreate Feature

**User Story:** As a user, I want to click "Recreate" on a profile to delete it and create a brand new one with fresh proxy, fingerprint, and cookies, so that I can quickly replace a burned profile without manual steps.

#### Acceptance Criteria

1. WHEN the user triggers a recreate action on a profile, THE Recreate_Handler SHALL set the profile status to "recreating" and, if the profile is currently running, stop it within 30 seconds before proceeding
2. WHEN the profile is stopped, THE Recreate_Handler SHALL delete the old profile via the appropriate Provider_Adapter for the profile's browserType (AdsPower, MoreLogin, or Multilogin)
3. WHEN the old profile is deleted, THE Recreate_Handler SHALL create a new profile with a new proxy having a different session ID from the deleted profile's proxy, a newly generated fingerprint, and an empty cookie store
4. WHEN recreating a profile, THE Recreate_Handler SHALL preserve the original profile's name, OS, browserType, and group assignment (or generate a new auto-incremented name if the user has configured auto-naming in settings)
5. THE Recreate_Handler SHALL support recreate operations on all three providers: AdsPower, MoreLogin, and Multilogin
6. IF the stop operation does not complete within 30 seconds, THEN THE Recreate_Handler SHALL abort the recreate operation and return an error indicating the profile could not be stopped
7. IF deletion of the old profile fails, THEN THE Recreate_Handler SHALL abort the recreate operation, restore the profile status to its previous state, and return an error to the user
8. IF creation of the new profile fails after deletion, THEN THE Recreate_Handler SHALL return an error indicating the old profile was deleted but replacement creation failed, and set the profile status to "error"
9. IF the user triggers a recreate action on a profile that is already in "recreating" or "starting" status, THEN THE Recreate_Handler SHALL reject the request and return an error indicating the profile is busy

### Requirement 7: Fingerprint Uniqueness Across Profiles

**User Story:** As a user, I want every profile to have a unique fingerprint combination, so that no two profiles can be linked by browser fingerprinting services.

#### Acceptance Criteria

1. WHEN a Fingerprint_Config is generated, THE Uniqueness_Validator SHALL verify that the combination of userAgent, resolution, WebGL metadata, and geolocation coordinates (compared at 4 decimal places of precision) does not exactly match any other profile with status "running", "stopped", "starting", or "recreating" across all configured browser providers
2. IF a generated fingerprint matches an existing profile on any of the four comparison fields (userAgent, resolution, WebGL metadata, geolocation), THEN THE Fingerprint_Generator SHALL regenerate all four comparison fields by invoking a full fingerprint generation cycle and re-validate uniqueness, for a maximum of 3 attempts
3. IF uniqueness cannot be achieved after 3 regeneration attempts, THEN THE Fingerprint_Generator SHALL abort profile creation and return an error indicating fingerprint pool exhaustion
4. WHEN the Uniqueness_Validator confirms a fingerprint is unique, THE Fingerprint_Generator SHALL assign the validated Fingerprint_Config to the profile and allow profile creation to proceed

### Requirement 8: Browser Type and OS Selection

**User Story:** As a user, I want to select the browser type and operating system when creating a profile, so that I can match the profile to my target platform requirements.

#### Acceptance Criteria

1. WHEN creating a profile, THE Profile_Creator SHALL accept a browser type selection (AdsPower, MoreLogin, or Multilogin) and route the creation to the corresponding Provider_Adapter
2. WHEN creating a profile, THE Profile_Creator SHALL accept an OS selection (Windows, macOS, or Android) and pass it to the Fingerprint_Generator for user-agent and platform-specific configuration
3. WHEN Windows OS is selected, THE Fingerprint_Generator SHALL generate Windows-specific fingerprint values (Windows Chrome user-agent, desktop screen resolutions from the predefined list, Windows WebGL vendor/renderer pairs)
4. WHEN Android OS is selected, THE Fingerprint_Generator SHALL generate mobile-specific fingerprint values (mobile user-agent containing device model and Android version, mobile screen resolutions, device model string, Android version number)
5. WHEN macOS is selected, THE Fingerprint_Generator SHALL generate macOS-specific fingerprint values (Safari or Chrome macOS user-agent containing macOS version, macOS screen resolutions from 2560x1600, 2560x1440, or 1440x900, Apple or Intel WebGL vendor/renderer)
6. IF the selected browser type provider is not configured or unreachable, THEN THE Profile_Creator SHALL return an error indicating the provider is unavailable and SHALL NOT attempt creation on a different provider
