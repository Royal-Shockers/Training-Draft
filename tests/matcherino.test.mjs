import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { normalizeMatcherino } from '../worker/brawl-proxy.js';
import { parseMatcherinoLink, setPlayers, viewMatcherino } from '../matcherino.js';

const roster = (id, name, tag) => ({ entrantId: id, score: id === 10 ? 2 : 0,
  entrant: { name, team: { members: [{ userId: id, displayName: name, inTeamFixture: true, participantInfo: { gameUsername: tag } }] } } });
const stats = { kills: 3, deaths: 0, damageDealt: 40000, healingDone: 1000,
  damageReceived: 9000, gadgetUsedCount: 2, superUsedCount: 4, averageLatency: 37 };
const reportTeam = (tag, statistics = stats) => ({ bans: [{ id: 16000000, name: 'SHELLY' }],
  players: [{ tag, brawler: { id: 16000061, name: 'GUS', image: 'https://cdn.matcherino.com/gus/' }, statistics }] });
const match = { id: 123, bracketId: 20, roundNum: 2, status: 'done', winner: 10,
  entrantA: roster(10, 'Blue <team>', '#AAA'), entrantB: roster(11, 'Red', '#BBB'),
  brawlStarsMatchLocationId: 15000306, reports: [1, 2].map(gameNumber => ({ setNumber: 1,
    gameNumber, scoreA: 1, scoreB: 0, winner: 10, properties: { duration: 120,
      location: { id: 15000306, name: 'Dueling Beetles', gameMode: 'HOT ZONE' },
      teams: gameNumber === 1 ? [reportTeam('#AAA'), reportTeam('#BBB')] : [reportTeam('#BBB'), reportTeam('#AAA')] } })) };
const bracket = { id: 20, bountyId: 99, published: true, matches: [{ id: 123 }], entrants: [] };

test('accepts only Matcherino tournament match links', () => {
  assert.deepEqual(parseMatcherinoLink('https://matcherino.com/supercell/tournaments/99/bracket/match-123?foo=1'), { tournament: '99', match: '123' });
  for (const value of ['https://matcherino.com.evil.com/supercell/tournaments/99/bracket/match-123',
    'http://matcherino.com/supercell/tournaments/99/bracket/match-123',
    'https://user:pass@matcherino.com/supercell/tournaments/99/bracket/match-123',
    'https://matcherino.com/supercell/tournaments/99/bracket', 'javascript:alert(1)']) {
    assert.throws(() => parseMatcherinoLink(value));
  }
});

test('aligns report teams by roster, totals set metrics, and retains game ping', () => {
  const data = normalizeMatcherino(match, bracket);
  assert.equal(data.sets[0].games[1].teams[0].players[0].tag, '#AAA');
  const row = setPlayers(data.sets[0], 0)[0];
  assert.equal(row.totals.kills, 6);
  assert.equal(row.totals.deaths, 0);
  assert.equal(row.totals.damageDealt, 80000);
  assert.deepEqual(row.ping, [{ game: 1, value: 37 }, { game: 2, value: 37 }]);
  assert.equal(data.sets[0].games[0].map.name, 'Dueling Beetles');
  assert.ok(!JSON.stringify(data).includes('participantInfo'));
});

test('duplicate submissions count once and missing metrics remain unknown', () => {
  const missing = structuredClone(match);
  delete missing.reports[1].properties.teams[1].players[0].statistics.damageDealt;
  missing.reports.unshift(match.reports[0]);
  const data = normalizeMatcherino(missing, bracket);
  assert.equal(data.sets[0].games.length, 2);
  assert.equal(setPlayers(data.sets[0], 0)[0].totals.damageDealt, null);
  assert.equal(setPlayers(data.sets[0], 0)[0].totals.deaths, 0);
});

test('score-only matches do not fabricate player stats; HTML is escaped', () => {
  const scoreOnly = structuredClone(match);
  scoreOnly.reports.forEach(r => { r.properties = {}; });
  const data = normalizeMatcherino(scoreOnly, bracket, [{ id: 15000306, name: 'Dueling Beetles' }]);
  assert.equal(setPlayers(data.sets[0], 0).length, 0);
  const html = viewMatcherino({ data, link: '' }, true);
  assert.match(html, /Detailed player stats not reported/);
  assert.match(html, /Blue &lt;team&gt;/);
  assert.match(html, /0 of 2 games include detailed/);
});

test('worker rejects invalid IDs and mismatched tournament; valid reads need no game API key', async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const pending = [];
  const ctx = { waitUntil(p) { pending.push(p); } };
  let calls = 0;
  globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
  globalThis.fetch = async (url, options) => {
    assert.equal(options.redirect, "manual", "Cloudflare supports manual or follow redirects");
    calls++;
    const path = new URL(url).pathname;
    assert.equal(new URL(url).hostname, 'api.matcherino.com');
    const body = path === '/__api/brackets/match' ? match : path === '/__api/brackets' ? [bracket] : [];
    return Response.json({ status: 200, body });
  };
  try {
    const invalid = await worker.fetch(new Request('https://worker/matcherino?tournament=oops&match=123'), {}, ctx);
    assert.equal(invalid.status, 400); assert.equal(calls, 0);
    const valid = await worker.fetch(new Request('https://worker/matcherino?tournament=99&match=123'), {}, ctx);
    assert.equal(valid.status, 200); assert.equal((await valid.json()).matchId, 123);
    const mismatched = await worker.fetch(new Request('https://worker/matcherino?tournament=98&match=123'), {}, ctx);
    assert.equal(mismatched.status, 404);
    await Promise.all(pending);
  } finally { globalThis.fetch = originalFetch; globalThis.caches = originalCaches; }
});
