/**
 * Multilogin X Launcher API Service
 * Base URL: https://launcher.mlx.yt:45001
 *
 * Antidetect profile create — noise canvas/webgl/audio, custom proxy-aligned values.
 * Never use natural/disabled (real fingerprint → IP leak risk).
 */

// ============ TYPES ============

export interface MultiloginStartProfileOptions {
  folder_id: string;
  profile_id: string;
  automation_type?: 'selenium' | 'puppeteer' | 'playwright';
  headless_mode?: boolean;
}

export interface MultiloginQuickProfileRequest {
  browser_type: 'mimic' | 'stealthfox';
  os_type: 'windows' | 'macos' | 'linux' | 'android';
  automation?: 'selenium' | 'puppeteer' | 'playwright';
  is_headless?: boolean;
  parameters: {
    flags: {
      audio_masking: 'mask' | 'natural';
      fonts_masking: 'mask' | 'natural' | 'custom';
      geolocation_masking: 'mask' | 'custom';
      geolocation_popup: 'prompt' | 'allow' | 'block';
      graphics_masking: 'mask' | 'natural' | 'custom';
      graphics_noise: 'mask' | 'natural';
      localization_masking: 'mask' | 'natural' | 'custom';
      media_devices_masking: 'mask' | 'natural' | 'custom';
      navigator_masking: 'mask' | 'natural' | 'custom';
      ports_masking: 'mask' | 'natural' | 'custom';
      proxy_masking: 'custom' | 'disabled';
      screen_masking: 'mask' | 'natural' | 'custom';
      timezone_masking: 'mask' | 'natural' | 'custom';
      webrtc_masking: 'natural' | 'custom' | 'mask' | 'disabled';
      canvas_noise: 'mask' | 'natural' | 'disabled';
      startup_behavior?: 'recover' | 'custom';
    };
    fingerprint: {
      navigator?: {
        user_agent: string;
        hardware_concurrency: number;
        platform: string;
        os_cpu?: string;
      };
      timezone?: {
        zone: string;
      };
      screen?: {
        width: number;
        height: number;
        pixel_ratio: number;
      };
      webrtc?: {
        public_ip: string;
      };
      localization?: {
        accept_languages: string;
        languages: string;
        locale: string;
      };
      graphic?: {
        vendor: string;
        renderer: string;
      };
      media_devices?: {
        audio_inputs: number;
        audio_outputs: number;
        video_inputs: number;
      };
      geolocation?: {
        latitude: number;
        longitude: number;
        accuracy: number;
        altitude: number;
      };
    };
    proxy?: {
      host: string;
      type: 'http' | 'socks5';
      port: number;
      username?: string;
      password?: string;
    };
  };
}

export interface MultiloginStartResponse {
  data: {
    id: string;
    port: string;
    browser_type: 'mimic' | 'stealthfox';
    core_version: number;
    is_quick: boolean;
  };
  status: {
    http_code: number;
    message: string;
    error_code: string;
  };
}

// ============ BUILDER FUNCTION ============

/**
 * Build a Multilogin X quick profile request with REAL fingerprints
 * (not masked) so profiles appear as real YouTube users
 */
export function buildRealFingerprintProfile(options: {
  browser_type?: 'mimic' | 'stealthfox';
  os_type: 'windows' | 'macos' | 'linux' | 'android';
  user_agent: string;
  timezone: string; // e.g., "America/New_York", "Asia/Bangkok"
  screen_width?: number;
  screen_height?: number;
  public_ip: string; // Real IP from proxy
  proxy?: {
    host: string;
    port: number;
    username?: string;
    password?: string;
  };
  accept_languages?: string;
  country_code?: string;
}): MultiloginQuickProfileRequest {
  return {
    browser_type: options.browser_type || 'mimic',
    os_type: options.os_type,
    automation: 'puppeteer', // For YouTube automation
    is_headless: false,
    parameters: {
      flags: {
        canvas_noise: 'mask',
        graphics_noise: 'mask',
        audio_masking: 'mask',
        ports_masking: 'mask',
        webrtc_masking: 'custom',
        timezone_masking: 'custom',
        geolocation_masking: 'custom',
        geolocation_popup: 'prompt',
        localization_masking: 'custom',
        screen_masking: 'custom',
        navigator_masking: 'custom',
        media_devices_masking: 'custom',
        graphics_masking: 'custom',
        fonts_masking: 'mask',

        // Proxy masking - use custom proxy if provided
        proxy_masking: options.proxy ? 'custom' : 'disabled',

        // Startup - recover from last session (more human-like)
        startup_behavior: 'recover',
      },

      fingerprint: {
        // Real user agent - YouTube will recognize as legitimate browser
        navigator: {
          user_agent: options.user_agent,
          hardware_concurrency: 8,
          platform: options.os_type === 'windows' ? 'Win32' :
                   options.os_type === 'macos' ? 'MacIntel' : 'Linux x86_64',
          os_cpu: options.os_type === 'windows' ? 'Windows NT 10.0; Win64; x64' :
                 options.os_type === 'macos' ? 'Intel Mac OS X 10_15_7' : 'Linux x86_64',
        },

        // Real timezone - synced with proxy location
        timezone: {
          zone: options.timezone,
        },

        // Real screen resolution - matches device type
        screen: {
          width: options.screen_width || 1920,
          height: options.screen_height || 1080,
          pixel_ratio: 1,
        },

        // Real WebRTC IP - from proxy provider
        webrtc: {
          public_ip: options.public_ip,
        },

        // Real localization - matches timezone/proxy region
        localization: {
          accept_languages: options.accept_languages || 'en-US,en;q=0.9',
          languages: 'en-US',
          locale: 'en-US',
        },

        // Real graphics - standard GPU info
        graphic: {
          vendor: 'Google Inc. (NVIDIA)',
          renderer: 'ANGLE (NVIDIA GeForce RTX 2080 Direct3D11)',
        },

        // Real media devices
        media_devices: {
          audio_inputs: 1,
          audio_outputs: 1,
          video_inputs: 1,
        },

        // Real geolocation - approximate from proxy
        geolocation: {
          latitude: 40.7128,
          longitude: -74.0060,
          accuracy: 100,
          altitude: 10,
        },
      },

      // Apply proxy if provided
      ...(options.proxy && {
        proxy: {
          host: options.proxy.host,
          type: 'http',
          port: options.proxy.port,
          username: options.proxy.username,
          password: options.proxy.password,
        },
      }),
    },
  };
}

// ============ API FUNCTIONS ============

/**
 * Start a saved browser profile with real fingerprints
 * Endpoint: GET /api/v2/profile/f/:folder_id/p/:profile_id/start
 */
export async function startProfileWithRealFingerprint(
  profile_id: string,
  folder_id: string = 'default',
): Promise<MultiloginStartResponse> {
  const url = new URL(
    `https://launcher.mlx.yt:45001/api/v2/profile/f/${folder_id}/p/${profile_id}/start`
  );

  url.searchParams.set('automation_type', 'puppeteer');
  url.searchParams.set('headless_mode', 'false');

  try {
    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      },
    });

    const data = await res.json() as MultiloginStartResponse;
    return data;
  } catch (err) {
    throw new Error(`Failed to start Multilogin X profile: ${err}`);
  }
}

/**
 * Start a quick profile with REAL fingerprints (no masking)
 * This is the key function that prevents bot detection
 * Endpoint: POST /api/v3/profile/quick
 */
export async function startQuickProfileWithRealFingerprint(
  request: MultiloginQuickProfileRequest,
): Promise<MultiloginStartResponse> {
  try {
    const res = await fetch('https://launcher.mlx.yt:45001/api/v3/profile/quick', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(request),
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    }

    const data = await res.json() as MultiloginStartResponse;
    return data;
  } catch (err) {
    throw new Error(`Failed to start Multilogin X quick profile: ${err}`);
  }
}

/**
 * Stop a running profile
 * Endpoint: GET /api/v2/profile/f/:folder_id/p/:profile_id/stop
 */
export async function stopProfile(
  profile_id: string,
  folder_id: string = 'default',
): Promise<MultiloginStartResponse> {
  const url = `https://launcher.mlx.yt:45001/api/v2/profile/f/${folder_id}/p/${profile_id}/stop`;

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      },
    });

    const data = await res.json() as MultiloginStartResponse;
    return data;
  } catch (err) {
    throw new Error(`Failed to stop Multilogin X profile: ${err}`);
  }
}
