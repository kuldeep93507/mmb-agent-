'use strict';

const fs = require('fs');
const path = require('path');

const ORCH = fs.readFileSync(path.resolve(__dirname, '../orchestrator.cjs'), 'utf8');
const WORKER = fs.readFileSync(path.resolve(__dirname, '../worker.cjs'), 'utf8');
const SEARCH = fs.readFileSync(path.resolve(__dirname, '../searchEngine.cjs'), 'utf8');
const AGENT = fs.readFileSync(path.resolve(__dirname, '../agent.cjs'), 'utf8');

describe('Group 3 search/close/orchestrator safety guards', () => {
  test('orchestrator does not slice remainingVideos on status/progress start events', () => {
    const statusCase = ORCH.slice(ORCH.indexOf("case 'status':"), ORCH.indexOf("case 'log':"));
    expect(statusCase).toContain('remainingVideos is advanced only on `video_done`');
    expect(statusCase).not.toMatch(/remainingVideos\s*=\s*state\.remainingVideos\.slice/);
    expect(ORCH).toContain("case 'video_done':");
  });

  test('worker reports CDP port and stopWorker forwards it for reliable close', () => {
    expect(WORKER).toContain('sendCdpReady');
    expect(ORCH).toContain("case 'cdp_ready'");
    expect(ORCH).toContain('cdpPort: state.cdpPort');
    expect(WORKER).toContain('verifyProfileStopped');
  });

  test('search engine logs search path and supports mobile search UI before direct fallback', () => {
    expect(SEARCH).toContain('typeInMobileSearchBar');
    expect(SEARCH).toContain('[Search Path]');
    expect(SEARCH).toContain('direct-url-last-resort');
    expect(SEARCH).toContain('mobile-search-ui');
  });

  test('backlink click is forced same-tab and agent has conservative blank tab cleanup', () => {
    expect(SEARCH).toContain('target.setAttribute(\'target\', \'_self\')');
    expect(SEARCH).toContain('Click did not navigate same-tab');
    expect(AGENT).toContain('_cleanupExtraPages');
    expect(AGENT).toContain('about:blank');
  });
});
