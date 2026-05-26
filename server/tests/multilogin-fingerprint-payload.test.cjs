'use strict';

const { MultiloginProvider } = require('../providers/MultiloginProvider.cjs');

describe('MultiloginProvider.buildFingerprintPayload', () => {
  let provider;

  beforeEach(() => {
    process.env.MULTILOGIN_EMAIL = 'test@test.com';
    process.env.MULTILOGIN_PASSWORD = 'testpass';
    process.env.MULTILOGIN_FOLDER_ID = 'test-folder-id';
    provider = new MultiloginProvider();
  });

  afterEach(() => {
    delete process.env.MULTILOGIN_EMAIL;
    delete process.env.MULTILOGIN_PASSWORD;
    delete process.env.MULTILOGIN_FOLDER_ID;
  });

  test('timezone uses Multilogin X shape { zone }', () => {
    const payload = provider.buildFingerprintPayload({ timezone: 'America/Chicago' });
    expect(payload.timezone).toEqual({ zone: 'America/Chicago' });
  });

  test('language uses { list: [...] }', () => {
    const payload = provider.buildFingerprintPayload({ language: 'en-US' });
    expect(payload.language).toEqual({ list: ['en-US'] });
  });

  test('does not emit geolocation (proxy/IP drives geo)', () => {
    const payload = provider.buildFingerprintPayload({
      geolocation: { lat: 32.7767, lng: -96.797 },
    });
    expect(payload).not.toHaveProperty('geolocation');
  });

  test('does not emit webrtc (API needs public_ip)', () => {
    const payload = provider.buildFingerprintPayload({ webRTC: 'disabled' });
    expect(payload).not.toHaveProperty('webrtc');
  });

  test('canvas / webgl / audio noise when seeds present', () => {
    const payload = provider.buildFingerprintPayload({
      canvasNoise: { enabled: true, seed: 'abc12345' },
      webGLNoise: { enabled: true, seed: 'def67890' },
      audioContextNoise: { enabled: true, seed: 'ghi11223' },
    });
    expect(payload.canvas).toEqual({ mode: 'noise', seed: 'abc12345' });
    expect(payload.webgl).toEqual({ mode: 'noise', seed: 'def67890' });
    expect(payload.audio).toEqual({ mode: 'noise', seed: 'ghi11223' });
  });

  test('navigator uses snake_case keys', () => {
    const ua =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0';
    const payload = provider.buildFingerprintPayload({
      userAgent: ua,
      os: 'Windows',
      cpu: 8,
      ram: 16,
    });
    expect(payload.navigator).toMatchObject({
      user_agent: ua,
      hardware_concurrency: 8,
      platform: 'Win32',
      device_memory: 8,
    });
  });

  test('screen parses resolution into width/height/pixel_ratio', () => {
    const payload = provider.buildFingerprintPayload({
      resolution: '1920x1080',
      pixelRatio: 2,
    });
    expect(payload.screen).toEqual({
      width: 1920,
      height: 1080,
      pixel_ratio: 2,
    });
  });

  test('includes graphic, media_devices, localization for full antidetect', () => {
    const payload = provider.buildFingerprintPayload({
      language: 'en-US',
      webGLMeta: { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE NVIDIA RTX 3060' },
      mediaDevices: { audioInputs: 1, videoInputs: 1, audioOutputs: 2 },
      canvasNoise: { enabled: true, seed: 'abc12345' },
      webGLNoise: { enabled: true, seed: 'def67890' },
      audioContextNoise: { enabled: true, seed: 'ghi11223' },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0',
      os: 'Windows',
      cpu: 8,
      ram: 16,
      resolution: '1920x1080',
      timezone: 'America/Chicago',
      fonts: ['Arial', 'Verdana'],
    });
    expect(payload.graphic).toEqual({
      vendor: 'Google Inc. (NVIDIA)',
      renderer: 'ANGLE NVIDIA RTX 3060',
    });
    expect(payload.media_devices).toEqual({
      audio_inputs: 1,
      video_inputs: 1,
      audio_outputs: 2,
    });
    expect(payload.localization).toMatchObject({
      languages: 'en-US',
      locale: 'en-US',
    });
    expect(payload.canvas.seed).toBe('abc12345');
  });

  test('_buildAntidetectParameters sets mask flags for noise seeds', () => {
    const { flags, fingerprint } = provider._buildAntidetectParameters({
      os: 'Windows',
      fingerprint: {
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0',
        timezone: 'America/New_York',
        language: 'en-US',
        resolution: '1920x1080',
        cpu: 8,
        ram: 8,
        canvasNoise: { seed: 'seed1111' },
        webGLNoise: { seed: 'seed2222' },
        audioContextNoise: { seed: 'seed3333' },
        webGLMeta: { vendor: 'Google Inc.', renderer: 'ANGLE AMD' },
        mediaDevices: { audioInputs: 1, videoInputs: 1, audioOutputs: 2 },
        fonts: ['Arial'],
      },
    }, true);
    expect(flags.canvas_noise).toBe('mask');
    expect(flags.graphics_noise).toBe('mask');
    expect(flags.audio_masking).toBe('mask');
    expect(flags.webrtc_masking).toBe('mask');
    expect(flags.graphics_masking).toBe('custom');
    expect(fingerprint.canvas.seed).toBe('seed1111');
    expect(fingerprint.media_devices).toBeDefined();
  });

  test('returns {} when config is null/undefined', () => {
    expect(provider.buildFingerprintPayload(null)).toEqual({});
    expect(provider.buildFingerprintPayload(undefined)).toEqual({});
  });

  test('omits empty optional sections', () => {
    const payload = provider.buildFingerprintPayload({
      timezone: 'America/New_York',
      language: '',
      canvasNoise: null,
      webGLNoise: { enabled: true, seed: '' },
      audioContextNoise: { enabled: true, seed: 'seed1234' },
      userAgent: '',
      fonts: [],
    });
    expect(payload.timezone).toEqual({ zone: 'America/New_York' });
    expect(payload).not.toHaveProperty('language');
    expect(payload).not.toHaveProperty('canvas');
    expect(payload).not.toHaveProperty('webgl');
    expect(payload.audio).toEqual({ mode: 'noise', seed: 'seed1234' });
    expect(payload).not.toHaveProperty('navigator');
    expect(payload).not.toHaveProperty('fonts');
  });
});
