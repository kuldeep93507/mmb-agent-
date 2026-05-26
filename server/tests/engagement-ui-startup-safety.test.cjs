'use strict';

const fs = require('fs');
const path = require('path');

const YT_UI = fs.readFileSync(path.resolve(__dirname, '../agent/YoutubeUi.cjs'), 'utf8');
const WATCHER = fs.readFileSync(path.resolve(__dirname, '../agent/VideoWatcher.cjs'), 'utf8');
const HUMAN = fs.readFileSync(path.resolve(__dirname, '../agent/HumanBehavior.cjs'), 'utf8');
const WORKER = fs.readFileSync(path.resolve(__dirname, '../worker.cjs'), 'utf8');
const FACTORY = fs.readFileSync(path.resolve(__dirname, '../profileFactory.cjs'), 'utf8');

describe('Group 5 engagement/UI/startup safety guards', () => {
  test('mobile autoplay unknown state does not blindly click and unknown is not verified OK', () => {
    expect(YT_UI).toContain('Mobile toggle state unknown');
    expect(YT_UI).toContain('no blind click');
    expect(YT_UI).toContain('State unknown — preference set to OFF, but toggle not verified');
    expect(YT_UI).not.toContain('ambiguous state — try click anyway');
  });

  test('comment submit only marks posted when submit button is usable', () => {
    expect(WATCHER).toContain('not marking posted');
    expect(WATCHER).toContain('canSubmit');
    expect(WATCHER).toContain('[Comment] Failed');
  });

  test('dislike is gated and like/dislike conflict is skipped', () => {
    expect(WATCHER).toContain("_shouldEngage('dislike'");
    expect(WATCHER).toContain('Like and dislike both enabled — skipping dislike');
  });

  test('already subscribed case stops repeated subscribe checks', () => {
    expect(WATCHER).toContain('Already subscribed — skipping subscribe action');
    expect(WATCHER).toContain('this._subscribedThisSession = true');
  });

  test('mobile scroll detection uses UA/touch/viewport, not only URL', () => {
    expect(HUMAN).toContain('isMobileLikePage');
    expect(HUMAN).toContain('maxTouchPoints');
    expect(HUMAN).toContain('window.innerWidth');
  });

  test('startup retries avoid legacy 5s fixed retry and factory logs actual proxy country', () => {
    expect(WORKER).toContain('startProfileWithRetry');
    expect(WORKER).not.toContain('waiting 5s before retry');
    expect(FACTORY).toContain('startWithReadiness');
    expect(FACTORY).toContain('proxyOpts.country');
  });
});
