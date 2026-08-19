'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { executableCandidates, normalizeUsage, sevenDaySeries, windowLabel } = require('../src/codex-usage');

test('normalizes all account quota buckets without exposing credentials', () => {
  const now = new Date('2026-08-18T08:00:00Z');
  const snapshot = normalizeUsage({
    planType: 'pro',
    rateLimitsByLimitId: {
      codex: { primary: { usedPercent: 34, windowDurationMins: 10080, resetsAt: 1787205216 } },
      spark: { limitName: 'Spark', primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: 1787200000 } }
    }
  }, { dailyUsageBuckets: [{ startDate: '2026-08-17', tokens: 1200 }] }, now);
  assert.equal(snapshot.status, 'ok');
  assert.equal(snapshot.planType, 'pro');
  assert.equal(snapshot.limits[0].remainingPercent, 66);
  assert.equal(snapshot.limits[0].label, 'Codex · 每周额度');
  assert.equal(snapshot.dailyUsage.at(-1).tokens, 0);
  assert.equal(JSON.stringify(snapshot).includes('auth'), false);
});

test('fills missing days with zero', () => {
  const days = sevenDaySeries([{ startDate: '2026-08-16', tokens: 99 }], new Date('2026-08-18T12:00:00Z'));
  assert.equal(days.length, 7);
  assert.deepEqual(days.at(-3), { date: '2026-08-16', tokens: 99 });
  assert.equal(days.at(-1).tokens, 0);
});

test('labels common quota windows and includes explicit binary first', () => {
  assert.equal(windowLabel(300), '5 小时额度');
  assert.equal(windowLabel(10080), '每周额度');
  assert.equal(executableCandidates({ CODEX_CLI_PATH: '/custom/codex', LOCALAPPDATA: 'C:\\Local' }, 'win32', 'C:\\User')[0], '/custom/codex');
});
