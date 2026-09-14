/**
 * The connected canvas's live feed of host-observed changes.
 *
 * A stream can drop while the browser stays online; EventSource reconnects on
 * its own, but anything that changed during the gap was never sent. So every
 * successful open — the first one and each reconnection — tells the canvas
 * `reconnected`, and the canvas re-reads through its authoritative API. The
 * server keeps no replay log, so this read IS the reconciliation.
 *
 * One subscription per port: attaching again closes the previous stream, and
 * messages from a replaced stream or for a replaced port are dropped.
 *
 * Returns `{ close }`.
 */
export function attachHostEvents({ EventSourceImpl, url = "/api/dev/events", getPort, port, previous }) {
  previous?.close?.();
  const source = new EventSourceImpl(url);
  let closed = false;
  const forward = (type) => {
    if (closed) return;
    const current = getPort();
    if (current !== port) return;
    current.postMessage({ event: { type } });
  };
  source.onopen = () => forward("reconnected");
  source.onmessage = (message) => {
    let event;
    try {
      event = JSON.parse(message.data);
    } catch {
      return;
    }
    if (event && typeof event.type === "string") forward(event.type);
  };
  return {
    close() {
      closed = true;
      source.onopen = null;
      source.onmessage = null;
      source.close();
    }
  };
}
