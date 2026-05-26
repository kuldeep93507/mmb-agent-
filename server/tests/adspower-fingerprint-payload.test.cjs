'use strict';

const { AdsPowerProvider } = require('../providers/AdsPowerProvider.cjs');

describe('AdsPowerProvider.buildFingerprintPayload', () => {
  let provider;

  beforeEach(() => {
    provider = new AdsPowerProvider();
  });

  it('maps a complete ExtendedFingerprintConfig to AdsPower fingerprint_config', () => {
    const config = {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0',
      timezone: 'America/Chicago',
      language: 'en-US',
      resolution: '1920x1080',
      webRTC: 'disabled',
      canvasNoise: { enabled: true, seed: 'ab12cd34' },
      webGLNoise: { enabled: true, seed: 'ef56gh78' },
      audioContextNoise: { enabled: true, seed: 'ij90kl12' },
      geolocation: { lat: 32.7767, lng: -96.7970 },
      fonts: ['Arial', 'Verdana', 'Tahoma'],
      mediaDevices: { audioInputs: 2, videoInputs: 1, audioOutputs: 3 },
    };

    const payload = provider.buildFingerprintPayload(config);

    expect(payload.webrtc).toBe('disabled');
    expect(payload.ua).toBe(config.userAgent);
    // AdsPower Local API expects width_height with underscore separator
    expect(payload.screen_resolution).toBe('1920_1080');
    expect(payload.language).toEqual(['en-US']);
    expect(payload.timezone).toEqual({ timezone: 'America/Chicago' });
    expect(payload.canvas).toBe('1');
    expect(payload.canvas_seed).toBe('ab12cd34');
    expect(payload.webgl_image).toBe('1');
    expect(payload.webgl_image_seed).toBe('ef56gh78');
    expect(payload.audio).toBe('1');
    expect(payload.audio_seed).toBe('ij90kl12');
    expect(payload.location_switch).toBe(1);
    expect(payload.latitude).toBe('32.7767');
    expect(payload.longitude).toBe('-96.797');
    expect(payload.accuracy).toBe('1000');
    expect(payload.fonts).toEqual(['Arial', 'Verdana', 'Tahoma']);
    expect(payload.media_devices).toBe('1');
    expect(payload.media_devices_num).toEqual({
      audioinput: 2,
      videoinput: 1,
      audiooutput: 3,
    });
  });

  it('omits undefined fields from payload', () => {
    const config = {
      userAgent: 'Mozilla/5.0 Test',
      timezone: 'America/New_York',
      // language is undefined
      // resolution is undefined
      // Internal 'real' maps to AdsPower webrtc mode 'local'
      webRTC: 'real',
      canvasNoise: { enabled: true, seed: 'seed1234' },
      // webGLNoise is undefined
      // audioContextNoise is undefined
      // geolocation is undefined
      // fonts is undefined
      // mediaDevices is undefined
    };

    const payload = provider.buildFingerprintPayload(config);

    expect(payload.ua).toBe('Mozilla/5.0 Test');
    expect(payload.webrtc).toBe('local');
    expect(payload.timezone).toEqual({ timezone: 'America/New_York' });
    expect(payload.canvas).toBe('1');
    expect(payload.canvas_seed).toBe('seed1234');
    // These should NOT be present
    expect(payload.language).toBeUndefined();
    expect(payload.screen_resolution).toBeUndefined();
    expect(payload.webgl_image).toBeUndefined();
    expect(payload.webgl_image_seed).toBeUndefined();
    expect(payload.audio).toBeUndefined();
    expect(payload.audio_seed).toBeUndefined();
    expect(payload.location).toBeUndefined();
    expect(payload.fonts).toBeUndefined();
    expect(payload.media_devices).toBeUndefined();
  });

  it('omits empty string fields from payload', () => {
    const config = {
      userAgent: '',
      timezone: '',
      language: '',
      resolution: '',
      webRTC: '',
    };

    const payload = provider.buildFingerprintPayload(config);

    expect(payload.ua).toBeUndefined();
    expect(payload.timezone).toBeUndefined();
    expect(payload.language).toBeUndefined();
    expect(payload.screen_resolution).toBeUndefined();
    expect(payload.webrtc).toBeUndefined();
  });

  it('returns empty object for null/undefined config', () => {
    expect(provider.buildFingerprintPayload(null)).toEqual({});
    expect(provider.buildFingerprintPayload(undefined)).toEqual({});
    expect(provider.buildFingerprintPayload('not-an-object')).toEqual({});
  });

  it('maps disabled noise correctly (canvas=0)', () => {
    const config = {
      canvasNoise: { enabled: false, seed: 'noseed00' },
      webGLNoise: { enabled: false, seed: 'noseed01' },
      audioContextNoise: { enabled: false, seed: 'noseed02' },
    };

    const payload = provider.buildFingerprintPayload(config);

    expect(payload.canvas).toBe('0');
    expect(payload.canvas_seed).toBe('noseed00');
    expect(payload.webgl_image).toBe('0');
    expect(payload.webgl_image_seed).toBe('noseed01');
    expect(payload.audio).toBe('0');
    expect(payload.audio_seed).toBe('noseed02');
  });

  it('omits empty fonts array', () => {
    const config = {
      fonts: [],
    };

    const payload = provider.buildFingerprintPayload(config);
    expect(payload.fonts).toBeUndefined();
  });

  it('handles partial mediaDevices (only some fields defined)', () => {
    const config = {
      mediaDevices: { audioInputs: 2 },
    };

    const payload = provider.buildFingerprintPayload(config);
    expect(payload.media_devices).toBe('1');
    expect(payload.media_devices_num).toEqual({
      audioinput: 2,
      videoinput: 1,
      audiooutput: 1,
    });
  });
});
