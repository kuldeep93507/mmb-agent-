'use strict';

const { MoreLoginProvider } = require('../providers/MoreLoginProvider.cjs');

describe('MoreLoginProvider.buildFingerprintPayload', () => {
  let provider;

  beforeAll(() => {
    if (!process.env.MORELOGIN_API_KEY) process.env.MORELOGIN_API_KEY = 'test_dummy_key_for_jest_only';
  });

  beforeEach(() => {
    provider = new MoreLoginProvider();
  });

  test('maps a complete ExtendedFingerprintConfig to MoreLogin flat fields', () => {
    const config = {
      timezone: 'America/Chicago',
      language: 'en-US',
      resolution: '1920x1080',
      webRTC: 'disabled',
      canvasNoise: { enabled: true, seed: 'abc12345' },
      webGLNoise: { enabled: true, seed: 'def67890' },
      audioContextNoise: { enabled: true, seed: 'ghi11223' },
      geolocation: { lat: 32.7767, lng: -96.7970 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0',
      fonts: ['Arial', 'Verdana', 'Courier New'],
    };

    const payload = provider.buildFingerprintPayload(config);

    expect(payload.timezone).toBe('America/Chicago');
    expect(payload.language).toBe('en-US');
    expect(payload.resolution).toBe('1920x1080');
    expect(payload.webrtcType).toBe(0); // disabled = 0
    expect(payload.canvasType).toBe(1);
    expect(payload.canvasSeed).toBe('abc12345');
    expect(payload.webglType).toBe(1);
    expect(payload.webglSeed).toBe('def67890');
    expect(payload.audioType).toBe(1);
    expect(payload.audioSeed).toBe('ghi11223');
    expect(payload.latitude).toBe(32.7767);
    expect(payload.longitude).toBe(-96.7970);
    expect(payload.ua).toBe('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0');
    expect(payload.fontList).toEqual(['Arial', 'Verdana', 'Courier New']);
  });

  test('maps webRTC "real" to webrtcType 1', () => {
    const config = { webRTC: 'real' };
    const payload = provider.buildFingerprintPayload(config);
    expect(payload.webrtcType).toBe(1);
  });

  test('maps webRTC "forward" to webrtcType 2', () => {
    const config = { webRTC: 'forward' };
    const payload = provider.buildFingerprintPayload(config);
    expect(payload.webrtcType).toBe(2);
  });

  test('omits undefined/empty fields from payload (Req 4.6)', () => {
    const config = {
      timezone: 'America/New_York',
      language: '',
      resolution: undefined,
      webRTC: undefined,
      canvasNoise: null,
      webGLNoise: { enabled: true, seed: '' },
      audioContextNoise: { enabled: true, seed: 'seed1234' },
      geolocation: null,
      userAgent: '',
      fonts: [],
    };

    const payload = provider.buildFingerprintPayload(config);

    expect(payload.timezone).toBe('America/New_York');
    expect(payload).not.toHaveProperty('language');
    expect(payload).not.toHaveProperty('resolution');
    expect(payload).not.toHaveProperty('webrtcType');
    expect(payload).not.toHaveProperty('canvasType');
    expect(payload).not.toHaveProperty('canvasSeed');
    expect(payload).not.toHaveProperty('webglType');
    expect(payload).not.toHaveProperty('webglSeed');
    expect(payload.audioType).toBe(1);
    expect(payload.audioSeed).toBe('seed1234');
    expect(payload).not.toHaveProperty('latitude');
    expect(payload).not.toHaveProperty('longitude');
    expect(payload).not.toHaveProperty('ua');
    expect(payload).not.toHaveProperty('fontList');
  });

  test('returns empty object when config is null', () => {
    const payload = provider.buildFingerprintPayload(null);
    expect(payload).toEqual({});
  });

  test('returns empty object when config is undefined', () => {
    const payload = provider.buildFingerprintPayload(undefined);
    expect(payload).toEqual({});
  });

  test('handles geolocation with lat=0 and lng=0 (valid coordinates)', () => {
    const config = {
      geolocation: { lat: 0, lng: 0 },
    };
    const payload = provider.buildFingerprintPayload(config);
    expect(payload.latitude).toBe(0);
    expect(payload.longitude).toBe(0);
  });

  test('handles negative geolocation values', () => {
    const config = {
      geolocation: { lat: -33.8688, lng: -151.2093 },
    };
    const payload = provider.buildFingerprintPayload(config);
    expect(payload.latitude).toBe(-33.8688);
    expect(payload.longitude).toBe(-151.2093);
  });
});
