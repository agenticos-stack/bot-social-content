// A hand-rolled DOM, just large enough to smoke-load the Social
// Localization client's bundled client.js in plain node.
//
// Neither jsdom, happy-dom nor linkedom is a dependency anywhere in this
// workspace (checked with `pnpm why` before writing this — none resolve).
// Rather than add one for a single test file, this implements only the DOM
// surface `src/client/*` actually touches: element creation/attributes,
// classList, a real (synchronous) event dispatch so a checkbox's `change`
// handler runs the same way a browser's would, a document/documentElement
// with `lang`, and a canvas 2D context stub for the poster editor. It is
// deliberately not a general-purpose DOM — anything the client starts
// using that this file doesn't support should fail loudly (a missing
// method), not silently no-op.

type Listener = (event: any) => unknown;

export class NodeShim {
  nodeType: number;
  childNodes: NodeShim[] = [];
  parentNode: NodeShim | null = null;

  constructor(nodeType: number) {
    this.nodeType = nodeType;
  }

  get children(): ElementShim[] {
    return this.childNodes.filter((node): node is ElementShim => node.nodeType === 1);
  }

  appendChild<T extends NodeShim>(node: T): T {
    if (node instanceof DocumentFragmentShim) {
      const fragmentChildren = node.childNodes.slice();
      node.childNodes = [];
      for (const child of fragmentChildren) this.appendChild(child);
      return node;
    }
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }

  removeChild<T extends NodeShim>(node: T): T {
    const index = this.childNodes.indexOf(node);
    if (index >= 0) this.childNodes.splice(index, 1);
    node.parentNode = null;
    return node;
  }

  remove(): void {
    this.parentNode?.removeChild(this);
  }

  append(...nodes: Array<NodeShim | string>): void {
    for (const node of nodes) this.appendChild(typeof node === "string" ? new TextNodeShim(node) : node);
  }

  replaceChildren(...nodes: NodeShim[]): void {
    for (const child of this.childNodes.slice()) this.removeChild(child);
    for (const node of nodes) this.appendChild(node);
  }

  get textContent(): string {
    if (this.nodeType === 3) return (this as unknown as TextNodeShim).data;
    return this.childNodes.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    for (const child of this.childNodes.slice()) this.removeChild(child);
    if (value) this.appendChild(new TextNodeShim(value));
  }
}

export class TextNodeShim extends NodeShim {
  data: string;
  constructor(data: string) {
    super(3);
    this.data = data;
  }
}

export class DocumentFragmentShim extends NodeShim {
  constructor() {
    super(11);
  }
}

class ClassListShim {
  constructor(private readonly owner: ElementShim) {}
  private read(): Set<string> {
    return new Set(this.owner.className.split(/\s+/).filter(Boolean));
  }
  private write(next: Set<string>): void {
    this.owner.className = [...next].join(" ");
  }
  // Real DOMTokenList is iterable, and this gadget's `dom.js` spreads it to map
  // its own class names onto the shared SDK component classes. The API's copy of
  // this helper never needed it because the API's client has no such mapping.
  [Symbol.iterator](): IterableIterator<string> {
    return this.read()[Symbol.iterator]();
  }

  add(name: string): void {
    const next = this.read();
    next.add(name);
    this.write(next);
  }
  remove(name: string): void {
    const next = this.read();
    next.delete(name);
    this.write(next);
  }
  toggle(name: string, force?: boolean): boolean {
    const next = this.read();
    const shouldHave = force === undefined ? !next.has(name) : force;
    if (shouldHave) next.add(name);
    else next.delete(name);
    this.write(next);
    return shouldHave;
  }
  contains(name: string): boolean {
    return this.read().has(name);
  }
}

/** Fake 2D context: records nothing, refuses nothing — the poster editor only needs it to not throw. */
function createCanvasContext2D() {
  return {
    fillStyle: "",
    font: "",
    textAlign: "left",
    textBaseline: "alphabetic",
    globalAlpha: 1,
    clearRect() {},
    fillRect() {},
    fillText() {},
    save() {},
    restore() {},
    measureText(text: string) {
      return { width: text.length * 6 };
    }
  };
}

const REFLECTED_ATTRS: Record<string, keyof ElementShim> = {
  id: "id",
  value: "value",
  lang: "lang"
};

export class ElementShim extends NodeShim {
  tagName: string;
  private attrs = new Map<string, string>();
  private listeners = new Map<string, Listener[]>();
  className = "";
  id = "";
  value = "";
  lang = "";
  checked = false;
  disabled = false;
  hidden = false;
  open = false;
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};

  constructor(tagName: string) {
    super(1);
    this.tagName = tagName.toUpperCase();
  }

  get classList(): ClassListShim {
    return new ClassListShim(this);
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, String(value));
    if (name === "class") this.className = String(value);
    else if (name === "checked") this.checked = true;
    else if (name === "disabled") this.disabled = true;
    else if (name === "hidden") this.hidden = true;
    else if (name in REFLECTED_ATTRS) (this as any)[REFLECTED_ATTRS[name]] = String(value);
  }
  getAttribute(name: string): string | null {
    return this.attrs.has(name) ? this.attrs.get(name)! : null;
  }
  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }

  /**
   * A selector engine deliberately as small as the client's use: `.class`,
   * `[attr]`, bare tag names, comma-separated alternatives, and
   * space-separated descendant chains (`.sl-selection .sl-primary`). A
   * pseudo-class or combinator the client has not needed should fail loudly
   * by matching nothing, not pretend to work.
   */
  private matchesSimple(selector: string): boolean {
    if (selector.startsWith(".")) return this.classList.contains(selector.slice(1));
    if (selector.startsWith("[") && selector.endsWith("]")) return this.hasAttribute(selector.slice(1, -1));
    return this.tagName === selector.toUpperCase();
  }

  private matchesSelectorChain(selector: string): boolean {
    const parts = selector.split(/\s+/).filter(Boolean);
    if (!parts.length || !this.matchesSimple(parts[parts.length - 1])) return false;
    let ancestor: NodeShim | null = this.parentNode;
    for (let i = parts.length - 2; i >= 0; i--) {
      let found = false;
      let node = ancestor;
      while (node) {
        if (node.nodeType === 1 && (node as ElementShim).matchesSimple(parts[i])) {
          ancestor = node.parentNode;
          found = true;
          break;
        }
        node = node.parentNode;
      }
      if (!found) return false;
    }
    return true;
  }

  querySelector(selector: string): ElementShim | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): ElementShim[] {
    const alternatives = selector.split(",").map((part) => part.trim()).filter(Boolean);
    const found: ElementShim[] = [];
    const walk = (node: NodeShim): void => {
      for (const child of node.children) {
        if (alternatives.some((part) => child.matchesSelectorChain(part))) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }

  addEventListener(type: string, handler: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, handler: Listener): void {
    const list = this.listeners.get(type);
    if (!list) return;
    const index = list.indexOf(handler);
    if (index >= 0) list.splice(index, 1);
  }
  /** Synchronous dispatch, mirroring a real browser: listeners run in order, `currentTarget` is this element. Returns a promise resolving once every (possibly async) handler settles, for a test to await. */
  async dispatchEvent(event: Record<string, unknown>): Promise<void> {
    const full = { ...event, currentTarget: this, target: this };
    const handlers = this.listeners.get(String(event.type)) ?? [];
    await Promise.all(handlers.map((handler) => handler(full)));
  }

  focus(): void {}

  // <dialog>
  showModal(): void {
    this.open = true;
  }
  close(): void {
    this.open = false;
    void this.dispatchEvent({ type: "close" });
  }

  // <canvas>
  getContext(kind: string) {
    return kind === "2d" ? createCanvasContext2D() : null;
  }
  toBlob(callback: (blob: Blob) => void, mime = "image/png"): void {
    callback(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: mime }));
  }
}

export class DocumentShim {
  documentElement = new ElementShim("html");
  head = new ElementShim("head");
  body = new ElementShim("body");
  activeElement: ElementShim | null = null;

  createElement(tag: string): ElementShim {
    return new ElementShim(tag);
  }
  /** Icons are namespaced elements; this shim only needs attributes and children, so the namespace is discarded. */
  createElementNS(_namespace: string, tag: string): ElementShim {
    return new ElementShim(tag);
  }
  createTextNode(data: string): TextNodeShim {
    return new TextNodeShim(data);
  }
  createDocumentFragment(): DocumentFragmentShim {
    return new DocumentFragmentShim();
  }
  getElementById(id: string): ElementShim | null {
    return findById(this.body, id) ?? findById(this.head, id) ?? (this.documentElement.id === id ? this.documentElement : null);
  }
  querySelector(selector: string): ElementShim | null {
    return this.head.querySelector(selector) ?? this.body.querySelector(selector);
  }
  querySelectorAll(selector: string): ElementShim[] {
    return [...this.head.querySelectorAll(selector), ...this.body.querySelectorAll(selector)];
  }
}

function findById(root: NodeShim, id: string): ElementShim | null {
  for (const child of root.children) {
    if (child.id === id) return child;
    const nested = findById(child, id);
    if (nested) return nested;
  }
  return null;
}

/** Depth-first walk collecting every element `predicate` accepts — this shim has no querySelector, so tests use this instead. */
export function findAll(root: NodeShim, predicate: (element: ElementShim) => boolean): ElementShim[] {
  const found: ElementShim[] = [];
  for (const child of root.children) {
    if (predicate(child)) found.push(child);
    found.push(...findAll(child, predicate));
  }
  return found;
}

export function hasClass(element: ElementShim, name: string): boolean {
  return element.classList.contains(name);
}

/** Installs `document`, `RpcTarget`/`RpcStub` and a `<div id="gadget-root">` on globalThis — everything client.js's App() reads before its own async init runs. Call before dynamically importing the bundle. */
export function installMinimalDom(): { document: DocumentShim; gadgetRoot: ElementShim } {
  const document = new DocumentShim();
  const gadgetRoot = document.createElement("div");
  gadgetRoot.setAttribute("id", "gadget-root");
  document.body.appendChild(gadgetRoot);

  class RpcTargetShim {}
  class RpcStubShim {}

  Object.assign(globalThis as Record<string, unknown>, {
    document,
    window: globalThis,
    HTMLElement: ElementShim,
    Node: NodeShim,
    RpcTarget: RpcTargetShim,
    RpcStub: RpcStubShim
  });

  return { document, gadgetRoot };
}

/** Lets every microtask queued so far (chained `await`s inside App()'s async init) actually run before a test inspects the DOM. */
export async function flushAsyncWork(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}
