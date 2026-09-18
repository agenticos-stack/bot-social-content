// Audit b7de9dd R4: the host stream reconciles on every (re)open, once per port.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attachHostEvents } from '@agenticos-dev/bot-devkit/host-events';

function fakeEventSource() {
  const instances = [];
  class FakeEventSource {
    constructor(url) { this.url = url; this.closed = false; instances.push(this); }
    close() { this.closed = true; }
  }
  return { FakeEventSource, instances };
}

function fakePort() {
  const posted = [];
  return { posted, postMessage: (message) => posted.push(message) };
}

test('each successful open, including a reconnection, asks the canvas to reconcile', () => {
  const { FakeEventSource, instances } = fakeEventSource();
  const port = fakePort();
  attachHostEvents({ EventSourceImpl: FakeEventSource, getPort: () => port, port });
  const [source] = instances;
  source.onopen();
  source.onmessage({ data: JSON.stringify({ type: 'generated_image' }) });
  // Stream dropped while the browser stayed online; EventSource reopens.
  source.onopen();
  assert.deepEqual(port.posted.map((m) => m.event.type), ['reconnected', 'generated_image', 'reconnected']);
});

test('attaching again closes the previous stream, and the replaced stream is silent', () => {
  const { FakeEventSource, instances } = fakeEventSource();
  const port = fakePort();
  const first = attachHostEvents({ EventSourceImpl: FakeEventSource, getPort: () => port, port });
  attachHostEvents({ EventSourceImpl: FakeEventSource, getPort: () => port, port, previous: first });
  assert.equal(instances.length, 2);
  assert.equal(instances[0].closed, true);
  assert.equal(instances[0].onopen, null);
  assert.equal(instances[0].onmessage, null);
  instances[1].onopen();
  assert.deepEqual(port.posted.map((m) => m.event.type), ['reconnected']);
});

test('events for a replaced port are dropped', () => {
  const { FakeEventSource, instances } = fakeEventSource();
  const oldPort = fakePort();
  const newPort = fakePort();
  let current = oldPort;
  attachHostEvents({ EventSourceImpl: FakeEventSource, getPort: () => current, port: oldPort });
  current = newPort;
  instances[0].onopen();
  instances[0].onmessage({ data: JSON.stringify({ type: 'revision' }) });
  assert.equal(oldPort.posted.length, 0);
  assert.equal(newPort.posted.length, 0);
});

test('malformed messages are ignored and a closed subscription posts nothing', () => {
  const { FakeEventSource, instances } = fakeEventSource();
  const port = fakePort();
  const handle = attachHostEvents({ EventSourceImpl: FakeEventSource, getPort: () => port, port });
  instances[0].onmessage({ data: '{bad' });
  instances[0].onmessage({ data: JSON.stringify({ nope: true }) });
  const { onopen } = instances[0];
  handle.close();
  onopen?.();
  assert.equal(port.posted.length, 0);
  assert.equal(instances[0].closed, true);
});
