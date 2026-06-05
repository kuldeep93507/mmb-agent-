# Requirements Document

## Introduction

This feature adds AdsPower and Multilogin antidetect browser support alongside the existing MoreLogin integration in MMB Agent. The system uses an abstract base class (provider pattern) so that all three browsers expose the same interface (profile create, start, stop, delete, list) and future browsers can be added with minimal effort. The existing MoreLogin code remains untouched and backward compatible. Both the main YouTube automation app and the MMB AGENT SITES sub-project benefit from this unified architecture.

## Glossary

- **Browser_Provider**: An abstract base class that defines the unified interface for antidetect browser operations (create, start, stop, delete, list profiles)
- **MoreLogin_Provider**: The concrete implementation of Browser_Provider for MoreLogin (existing code wrapped)
- **AdsPower_Provider**: The concrete implementation of Browser_Provider for AdsPower Local API
- **Multilogin_Provider**: The concrete implementation of Browser_Provider for Multilogin X API
- **Provider_Factory**: A factory module that instantiates the correct Browser_Provider based on configuration or user selection
- **Profile**: A browser environment with unique fingerprint, proxy, and session data managed by an antidetect browser
- **CDP_Port**: The Chrome DevTools Protocol debug port returned when a profile is started, used by Playwright to connect
- **Launcher**: The local agent/application that must be running for Multilogin (launcher.mlx.yt:45001) or AdsPower (localhost:50325) to accept API calls
- **Bearer_Token**: The JWT authentication token required by Multilogin X API (obtained via email/password sign-in, expires in 30 minutes)
- **API_Key**: The static authorization key used by MoreLogin and AdsPower for local API authentication
- **Frontend_Store**: The Zustand state store (useStore.ts) that manages profiles, jobs, and logs in the React UI

## Requirements

### Requirement 1: Abstract Browser Provider Interface

**User Story:** As a developer, I want a unified abstract interface for all antidetect browsers, so that I can add new browser support without modifying existing automation code.

#### Acceptance Criteria

1. THE Browser_Provider SHALL expose the following methods: createProfile(options), startProfile(profileId), stopProfile(profileId), deleteProfile(profileId), listProfiles(pageNo, pageSize), getProfileStatus(profileId)
2. WHEN a method is called on any Browser_Provider implementation, THE Browser_Provider SHALL return a standardized response object containing code (number, where 0 indicates success and non-zero indicates failure), message (string, maximum 256 characters), and data (object or null on failure)
3. THE Browser_Provider SHALL define a standardized profile object containing id (string), name (string), status (string, one of: "running", "stopped", "error", "unknown"), debugPort (number or null when not running), and browserType (string, one of: "morelogin", "adspower", "multilogin")
4. WHEN startProfile is called successfully, THE Browser_Provider SHALL return a response with code 0 containing the CDP_Port (number between 1024 and 65535) in the data object for Playwright connection
5. IF startProfile is called and the browser provider API returns an error or the profile cannot be launched, THEN THE Browser_Provider SHALL return a response with a non-zero code and a message indicating the failure reason
6. THE Provider_Factory SHALL instantiate the correct Browser_Provider based on the BROWSER_PROVIDER environment variable or runtime parameter (accepted values: "morelogin", "adspower", "multilogin")
7. IF the Provider_Factory receives an unsupported or empty provider value and no BROWSER_PROVIDER environment variable is set, THEN THE Provider_Factory SHALL default to the MoreLogin_Provider

### Requirement 2: AdsPower Provider Implementation

**User Story:** As a user, I want to use AdsPower antidetect browser with the same features as MoreLogin, so that I can choose my preferred antidetect tool.

#### Acceptance Criteria

1. WHEN createProfile is called on AdsPower_Provider, THE AdsPower_Provider SHALL send a POST request to the AdsPower Local API endpoint /api/v1/user/create with the profile configuration and return a standardized response containing the created profile id mapped from the AdsPower user_id field
2. WHEN startProfile is called on AdsPower_Provider, THE AdsPower_Provider SHALL send a GET request to /api/v1/browser/start with the profile user_id and return the CDP_Port from the response debug_port field within a maximum wait time of 30 seconds
3. WHEN stopProfile is called on AdsPower_Provider, THE AdsPower_Provider SHALL send a GET request to /api/v1/browser/stop with the profile user_id and return a standardized success response
4. WHEN deleteProfile is called on AdsPower_Provider, THE AdsPower_Provider SHALL send a POST request to /api/v1/user/delete with the profile user_ids array and return a standardized response indicating the deletion result
5. WHEN listProfiles is called on AdsPower_Provider, THE AdsPower_Provider SHALL send a GET request to /api/v1/user/list with page number (default: 1) and page_size (default: 100) parameters and return the standardized profile list with each profile's user_id mapped to id, name mapped to name, and browserType set to "adspower"
6. IF the AdsPower application is not running on the configured port (connection refused or request timeout exceeding 5 seconds), THEN THE AdsPower_Provider SHALL return a standardized error response with code indicating failure and a message indicating the AdsPower application must be started
7. THE AdsPower_Provider SHALL read the API base URL from the ADSPOWER_API_URL environment variable (default: http://local.adspower.com:50325)
8. IF the AdsPower API returns a non-zero code in its response, THEN THE AdsPower_Provider SHALL map the AdsPower error to a standardized error response preserving the original error message from the msg field
9. IF startProfile is called for a profile that is already running, THEN THE AdsPower_Provider SHALL return the existing CDP_Port from the active browser session without launching a new instance

### Requirement 3: Multilogin Provider Implementation

**User Story:** As a user, I want to use Multilogin X antidetect browser with the same features as MoreLogin, so that I can choose my preferred antidetect tool.

#### Acceptance Criteria

1. WHEN createProfile is called on Multilogin_Provider, THE Multilogin_Provider SHALL send a POST request to https://api.multilogin.com/profile/create with the Bearer_Token and profile configuration including at minimum the folder_id and browser_type fields, and return the created profile_id in the standardized response
2. WHEN startProfile is called on Multilogin_Provider, THE Multilogin_Provider SHALL send a GET request to https://launcher.mlx.yt:45001/api/v2/profile/f/{folder_id}/p/{profile_id}/start with automation_type=playwright and return the CDP_Port from the response port field within 30 seconds
3. WHEN stopProfile is called on Multilogin_Provider, THE Multilogin_Provider SHALL send a GET request to https://launcher.mlx.yt:45001/api/v1/profile/stop with the profile_id query parameter and return a success response within 15 seconds
4. WHEN deleteProfile is called on Multilogin_Provider, THE Multilogin_Provider SHALL send a POST request to https://api.multilogin.com/profile/remove with the profile_ids array containing 1 to 100 profile IDs
5. WHEN listProfiles is called on Multilogin_Provider, THE Multilogin_Provider SHALL send a POST request to https://api.multilogin.com/profile/search with offset and limit parameters (limit between 1 and 100, default 50) and return the standardized profile list
6. WHEN a Multilogin API request fails with a 401 authentication error indicating the Bearer_Token has expired, THE Multilogin_Provider SHALL refresh the token by calling POST https://api.multilogin.com/user/signin with stored credentials and retry the failed request exactly once
7. THE Multilogin_Provider SHALL authenticate on first use by calling POST https://api.multilogin.com/user/signin with email and password from environment variables MULTILOGIN_EMAIL and MULTILOGIN_PASSWORD, and store the returned Bearer_Token for subsequent requests
8. IF the Multilogin Launcher agent is not running (connection refused or timeout on launcher.mlx.yt:45001), THEN THE Multilogin_Provider SHALL return an error response with a message indicating the launcher must be connected
9. THE Multilogin_Provider SHALL read the folder_id from the MULTILOGIN_FOLDER_ID environment variable for profile organization
10. IF the token refresh attempt fails (signin returns non-200 status or connection error), THEN THE Multilogin_Provider SHALL return an error response indicating re-authentication is required with invalid credentials or service unavailable detail
11. IF the MULTILOGIN_FOLDER_ID environment variable is not set, THEN THE Multilogin_Provider SHALL return an error response at startup indicating the folder_id configuration is missing

### Requirement 4: MoreLogin Provider Wrapper (Backward Compatibility)

**User Story:** As an existing user, I want my current MoreLogin setup to continue working without changes, so that the new feature does not break my workflow.

#### Acceptance Criteria

1. THE MoreLogin_Provider SHALL delegate all API calls to the existing moreloginRequest function and moreloginApi.ts service without modifying their request payloads, endpoints, or response parsing logic
2. WHEN the BROWSER_PROVIDER environment variable is not set or is set to "morelogin", THE Provider_Factory SHALL default to MoreLogin_Provider
3. WHEN the MoreLogin_Provider receives a response from the existing MoreLogin API (containing code, msg, and data fields), THE MoreLogin_Provider SHALL map it to the standardized Browser_Provider response format by translating code to code, msg to message, and extracting id, envName, status, and debugPort into the standardized profile object
4. WHEN the system starts with no browser provider configuration, THE system SHALL execute the same MoreLogin API calls (start, stop, status, list, create, delete) with the same request parameters and return the same CDP_Port values as the current MoreLogin-only implementation
5. IF the MoreLogin application is not running on port 40000, THEN THE MoreLogin_Provider SHALL return an error response with a message indicating the MoreLogin application must be started
6. WHEN startProfile is called on MoreLogin_Provider, THE MoreLogin_Provider SHALL call the existing moreloginRequest function with endpoint /api/env/start and return the debugPort field from the MoreLogin response as the CDP_Port in the standardized response

### Requirement 5: Environment Configuration

**User Story:** As a user, I want to configure my browser provider credentials securely in the .env file, so that I can switch between providers without code changes.

#### Acceptance Criteria

1. THE system SHALL read the following AdsPower variables from the .env file at server startup: ADSPOWER_API_URL (default: "http://local.adspower.com:50325" if not set)
2. THE system SHALL read the following Multilogin variables from the .env file at server startup: MULTILOGIN_EMAIL, MULTILOGIN_PASSWORD, MULTILOGIN_FOLDER_ID
3. THE system SHALL read the BROWSER_PROVIDER variable from the .env file to determine the active provider, accepting only the values "morelogin", "adspower", or "multilogin" (default: "morelogin" if not set)
4. THE .env.example file SHALL document all new environment variables with placeholder values and inline comments describing each variable's purpose
5. IF a required environment variable for the selected provider is missing or empty, THEN THE Provider_Factory SHALL throw an error at server startup that includes the variable name and the provider it belongs to
6. IF the BROWSER_PROVIDER variable is set to a value other than "morelogin", "adspower", or "multilogin", THEN THE Provider_Factory SHALL throw an error at server startup indicating the invalid value and listing the accepted values
7. THE system SHALL treat an empty string value for any required environment variable the same as a missing variable

### Requirement 6: Frontend Browser Selection

**User Story:** As a user, I want to select my antidetect browser from the UI, so that I can switch providers without editing configuration files.

#### Acceptance Criteria

1. THE Frontend_Store SHALL include a browserProvider state field with values "morelogin", "adspower", or "multilogin", defaulting to "morelogin" when no persisted value exists
2. WHEN the user selects a browser provider from the Settings page dropdown, THE Frontend_Store SHALL update the browserProvider state and persist it to localStorage under the key "mmb_browser_provider"
3. WHEN fetchProfiles is called, THE Frontend_Store SHALL route the request to the backend API with the selected browser provider parameter
4. THE ProfilesPage component SHALL display the active browser provider name in the header area alongside the profile count summary
5. WHEN the browser provider is changed, THE Frontend_Store SHALL clear the current profiles list, set the loading state to true, and re-fetch profiles from the new provider
6. IF the re-fetch after a browser provider change fails, THEN THE Frontend_Store SHALL retain the empty profiles list, set loading to false, and log an error message indicating the provider name and failure reason
7. WHEN the application initializes, THE Frontend_Store SHALL read the persisted browserProvider value from localStorage and use it for the initial fetchProfiles call

### Requirement 7: Server-Side Provider Routing

**User Story:** As a developer, I want the backend server to route profile operations to the correct provider, so that the frontend can work with any browser seamlessly.

#### Acceptance Criteria

1. WHEN the backend receives a profile operation request with a provider parameter, THE server SHALL use the Provider_Factory to get the correct Browser_Provider instance and return the standardized response object (code, message, data) with HTTP status 200 for successful operations
2. THE server SHALL expose the following endpoints that accept a provider query parameter: POST /api/profiles/list, POST /api/profiles/create, POST /api/profiles/start, POST /api/profiles/stop, POST /api/profiles/delete
3. IF the provider parameter is omitted from a request and the BROWSER_PROVIDER environment variable is set, THEN THE server SHALL use the BROWSER_PROVIDER environment variable as the default provider
4. WHEN a profile is started successfully, THE server SHALL return the CDP_Port in the response data object for Playwright CDP connection
5. IF the provider parameter specifies a value other than "morelogin", "adspower", or "multilogin", THEN THE server SHALL return HTTP status 400 with an error response indicating the unsupported provider value
6. IF both the provider query parameter is omitted and the BROWSER_PROVIDER environment variable is not set, THEN THE server SHALL default to "morelogin" as the provider
7. IF the Provider_Factory or Browser_Provider returns an error during a profile operation, THEN THE server SHALL return HTTP status 502 with the error response from the provider including the original error message

### Requirement 8: Error Handling and Logging

**User Story:** As a user, I want clear error messages when browser operations fail, so that I can diagnose and fix issues quickly.

#### Acceptance Criteria

1. IF a network request to any browser provider API fails with a connection error or does not respond within 10 seconds, THEN THE Browser_Provider SHALL return a standardized error response containing code (-1), a message indicating the provider application is not running, and a null data field
2. IF a browser provider API returns an authentication error, THEN THE Browser_Provider SHALL return an error response containing code (-2), a message indicating invalid credentials, and a null data field
3. IF a browser provider API returns a rate limit error, THEN THE Browser_Provider SHALL wait and retry the request up to 3 times with exponential backoff starting at 1 second (1s, 2s, 4s delays between attempts)
4. IF all 3 retry attempts are exhausted after a rate limit error, THEN THE Browser_Provider SHALL return an error response containing code (-3), a message indicating the rate limit was exceeded and retries failed, and a null data field
5. WHEN any profile operation succeeds or fails, THE server SHALL log the operation to the server console with a timestamp, provider name, profile ID, operation type (create, start, stop, delete, list), and result status (success or error with message)
6. IF the Multilogin token refresh fails, THEN THE Multilogin_Provider SHALL return an error response containing code (-4), a message indicating re-authentication is required, and a null data field

### Requirement 9: Test Script

**User Story:** As a developer, I want a test script that validates the basic flow for all three browsers, so that I can verify the integration works correctly.

#### Acceptance Criteria

1. THE test script SHALL test the following flow for each configured provider in sequential order: list profiles, create a profile, start the profile, verify CDP_Port is returned, stop the profile, delete the profile, with a maximum timeout of 30 seconds per individual operation
2. WHEN a provider is not configured (missing required env vars: ADSPOWER_API_URL for AdsPower; MULTILOGIN_EMAIL, MULTILOGIN_PASSWORD, and MULTILOGIN_FOLDER_ID for Multilogin; MORELOGIN_API_KEY for MoreLogin), THE test script SHALL skip that provider with a message indicating which provider was skipped and why
3. THE test script SHALL output a summary table showing provider name, operation name, and pass/fail/skipped status for each provider and each operation
4. THE test script SHALL be executable via a single command: node server/test-browsers.cjs
5. IF any operation fails during the test, THE test script SHALL continue testing remaining operations for that provider where possible, skip dependent operations that cannot proceed (e.g., skip start/stop/delete if create failed), and report all failures in the summary
6. IF a profile was successfully created during the test, THEN THE test script SHALL attempt to delete that profile during cleanup regardless of whether intermediate operations passed or failed
7. WHEN the test script completes, THE test script SHALL exit with code 0 if all tested operations passed and exit with code 1 if any operation failed

### Requirement 10: Proxy Configuration Passthrough

**User Story:** As a user, I want my proxy settings to work with all browser providers, so that each profile uses the correct proxy regardless of which browser I choose.

#### Acceptance Criteria

1. WHEN createProfile is called with proxy configuration, THE AdsPower_Provider SHALL pass the proxy settings to the AdsPower API /api/v1/user/create endpoint with the proxy mapped to the user_proxy_config object containing proxy_soft (matching the protocol value), proxy_type (matching the protocol value), proxy_host (server), proxy_port (port), proxy_user (username), and proxy_password (password)
2. WHEN createProfile is called with proxy configuration, THE Multilogin_Provider SHALL pass the proxy settings to the Multilogin API in the parameters.proxy object format with fields: host (mapped from server), port, username, password, and type (mapped from protocol)
3. THE standardized createProfile parameters SHALL include an optional proxy object with fields: server (string, 1-253 characters), port (integer, 1-65535), username (string, 0-255 characters), password (string, 0-255 characters), protocol (enum: "http" or "socks5")
4. WHEN createProfile is called with proxy configuration, THE MoreLogin_Provider SHALL pass the proxy settings to the MoreLogin API with the proxy mapped to the existing proxyIp (server), proxyPort (port), username, password, and proxyType (mapped from protocol) fields
5. IF createProfile is called with a proxy object that has server or port missing, THEN THE Browser_Provider SHALL return an error response indicating which required proxy fields are absent without sending the request to the provider API
6. IF createProfile is called without a proxy object, THEN THE Browser_Provider SHALL create the profile with no proxy configured (direct connection)
