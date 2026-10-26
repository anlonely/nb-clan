import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseMemberLocation} from '../src/v2/router.js';

const source = readFileSync(new URL('../src/v2/main.jsx', import.meta.url), 'utf8');
function between(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, 'The navigation boundary must be updated when App is refactored');
  return source.slice(first, last);
}

// Exercise App's actual navigation callbacks against a browser-history model.
// No JSX/DOM rendering is needed: the guard's contract is to cancel an intent,
// retain its destination/options, then retry it after an explicit decision.
const callbacks = [between('  const canNavigate=', '  const [client]'),
  between('  const go=useCallback', '  const refreshSession='),
  between('    const pop=()=>', ";window.addEventListener('popstate',pop)") + ';',
  'return {go, pop};'].join('\n');

function navigationFixture({dirty = true} = {}) {
  const routes = ['/admin/bot/features?platform=discord', '/admin/platforms/discord#login', '/admin/platforms/discord#server-connection'];
  const entries = routes.map((url, index) => ({url, index})), traversals = [], intents = [], scrolls = [];
  let position = 2, renderedPath = routes[2], blocked = dirty, pendingIntent = null;
  const currentPath = {current: routes[2]}, navIndex = {current: 2}, restoringNavigation = {current: false}, approvedPop = {current: false};
  const window = new EventTarget();
  window.scrollTo = (...args) => scrolls.push(args);
  window.addEventListener('v2:before-navigate', event => {
    intents.push(event.detail);
    if (blocked) {event.preventDefault(); pendingIntent = event.detail;}
  });
  const history = {
    get state() {return {nbNavIndex: entries[position].index};},
    pushState(state, unused, url) {entries.splice(position + 1); entries.push({url, index: state.nbNavIndex}); position++;},
    replaceState(state, unused, url) {entries[position] = {url, index: state.nbNavIndex};},
    go(delta) {traversals.push(() => {
      const next = position + delta;
      if (next < 0 || next >= entries.length) return;
      position = next; app.pop();
    });}
  };
  const app = new Function('window', 'history', 'CustomEvent', 'parseMemberLocation', 'useCallback',
    'currentPath', 'navIndex', 'restoringNavigation', 'approvedPop', 'currentLocation', 'setPath', callbacks)(
    window, history, CustomEvent, parseMemberLocation, callback => callback, currentPath, navIndex,
    restoringNavigation, approvedPop, () => entries[position].url, value => {renderedPath = value;});
  return {app, intents, scrolls,
    back() {history.go(-1);},
    flush() {
      let count = 0;
      while (traversals.length) {assert.ok(count++ < 10, 'History restoration must settle'); traversals.shift()();}
    },
    cancel() {pendingIntent = null;},
    discardAndContinue() {
      assert.ok(pendingIntent, 'A cancelled intent is required before confirming');
      blocked = false;
      const intent = pendingIntent; pendingIntent = null;
      app.go(intent.to, intent.options);
    },
    snapshot() {return {entries: entries.map(entry => entry.url), position, renderedPath, navIndex: navIndex.current};}
  };
}

test('cancelling browser Back restores the current page without changing history or the rendered draft', () => {
  const fixture = navigationFixture(), original = fixture.snapshot();
  fixture.back(); fixture.flush();
  assert.equal(fixture.intents.length, 1);
  assert.equal(fixture.intents[0].to, original.entries[1]);
  assert.deepEqual(fixture.intents[0].options, {historyDelta: -1, scroll: false});
  fixture.cancel();
  assert.deepEqual(fixture.snapshot(), original);
  assert.deepEqual(fixture.scrolls, []);
});

test('discarding after Back resumes the original traversal and the next Back reaches the previous entry', () => {
  const fixture = navigationFixture(), original = fixture.snapshot();
  fixture.back(); fixture.flush(); fixture.discardAndContinue(); fixture.flush();
  assert.deepEqual(fixture.snapshot(), {entries: original.entries, position: 1, navIndex: 1, renderedPath: original.entries[1]});
  assert.equal(fixture.intents.length, 2, 'the approved pop must not trigger a third confirmation');
  fixture.back(); fixture.flush();
  assert.deepEqual(fixture.snapshot(), {entries: original.entries, position: 0, navIndex: 0, renderedPath: original.entries[0]});
  assert.deepEqual(fixture.scrolls, []);
});

test('link navigation preserves query/hash and replacement/scroll options after confirmation', () => {
  const fixture = navigationFixture();
  const replacement = '/admin/platforms/discord?source=bot#server-specialties';
  fixture.app.go(replacement, {replace: true, scroll: false});
  assert.deepEqual(fixture.intents[0].options, {replace: true, scroll: false, historyDelta: undefined});
  fixture.discardAndContinue();
  assert.equal(fixture.snapshot().entries.length, 3);
  assert.equal(fixture.snapshot().renderedPath, replacement);
  assert.equal(fixture.snapshot().navIndex, 2);
  assert.deepEqual(fixture.scrolls, []);
  const destination = '/admin/bot/open-signups?serverId=19&page=2';
  fixture.app.go(destination);
  assert.equal(fixture.snapshot().entries.length, 4);
  assert.equal(fixture.snapshot().renderedPath, destination);
  assert.equal(fixture.snapshot().navIndex, 3);
  assert.deepEqual(fixture.scrolls, [[0, 0]]);
});
