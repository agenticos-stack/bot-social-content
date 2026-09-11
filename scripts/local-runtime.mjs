import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

// Development-only wrapper. The packaged server and its storage stay unchanged.
export async function createSocialRuntime({ files, sdkSource, origins, stateDirectory, doors }) {
  if (!sdkSource) throw new Error('Local runtime requires BOT_SDK_SOURCE pointing to the SDK source checkout.');
  const { createLocalSession } = await import(pathToFileURL(resolve(sdkSource, 'packages/testkit/src/local-session.js')));
  const modules = Object.fromEntries(Object.entries(files).filter(([name]) => name.endsWith('.js') && name !== 'client.js'));
  modules['app-server.js'] = modules['server.js'];
  modules['server.js'] = `
    import { Gadget as App } from './app-server.js';
    import { normalizeConfig } from './config.js';
    export class Gadget extends App {
      async seedLocal() {
        return this.ctx.storage.transactionSync(() => {
        if (this.storage.getConfig()) return {seeded:0};
        this.storage.setConfig(normalizeConfig({ cadence: 'daily', fetchBudgetCredits: 0 }));
        this.storage.setSources([{binding:'LOCAL_SAMPLE',label:'Local sample (not connected)',provider:'instagram'}]);
        this.storage.setDestinations([{binding:'LOCAL_DRAFT',label:'Local draft only (not connected)',provider:'instagram'}]);
        for (const [index,text] of ['A brighter kind of daily','Start with morning light','Blend it your way'].entries()) {
          this.storage.upsertItem({id:'fixture-'+index,sourceBinding:'LOCAL_SAMPLE',sourceLabel:'Local sample',provider:'instagram',providerItemId:String(index),contentHash:'local-'+index,text,media:[],metrics:{},firstSeenAt:'2026-09-01T10:00:00.000Z',lastSeenAt:'2026-09-01T10:00:00.000Z'});
        }
        return {seeded:3};
        });
      }
    }`;
  /**
   * What the browser may call.
   *
   * The first list needs no door: browsing what has already been scanned,
   * selecting, batching, revising — and the two calls that
   * must work BEFORE any door exists. `saveSetup` derives connector bindings
   * only when it has doors to derive them from, and `refreshGrants` is the
   * discovery mechanism itself: refusing it without doors would make the
   * first grant unreachable. `readPublishState` polls a door only for rows
   * that were actually filed; `bound` rows answer from storage alone, and
   * `submitForReview` wraps every door call and refuses by value — an absent
   * publisher is `provider_unavailable`, not an admission failure.
   *
   * `getMedia` and `savePoster` belong to drafting, not to doors: a media
   * cache hit serves local bytes with no fetch at all (a miss refuses by
   * value — `media_missing`), and a poster PNG is rendered in the browser
   * and only stored. Gating either on doors left a no-door session unable
   * to read its own cache or save its own poster.
   *
   * The second list is admitted ONLY with doors, because each one's whole
   * purpose is a door call: scanning reads a source, monitoring arms a
   * schedule, source add/remove resolves through the connector. Admitting
   * them without doors would move a clear "this is unavailable" to a
   * confusing failure inside the gadget.
   *
   * Admission is not authority either way — the platform still decides whether
   * any door call proceeds, and `submitForReview` is gated there as it is for
   * an installed gadget.
   */
  const browsing = ['summary','listItems','getItem','markSeen','setSelection','clearSelection','listBatchSummaries','listBatches','getBatch','createBatch','saveRevision','saveRevisions','dismissGenerationAsk','saveSetup','refreshGrants','readPublishState','submitForReview','exportAs','exportJson','exportHtml','savePoster','getMedia'];
  const needsDoors = ['setConfig','setMonitoring','describedBindings','scanRuns','refresh','scan','addOpenSource','removeOpenSource','armSchedule','cancelSchedule'];
  const connectedDoors = doors ?? undefined;
  return createLocalSession({ modules, origins, stateDirectory, doors: connectedDoors, seed: [{method:'seedLocal',args:[]}],
    allowedMethods: connectedDoors ? [...browsing, ...needsDoors] : browsing });
}

/** `decodeBytes` is the testkit's decoder source; see connectedCanvasBridge for why it is passed in. */
export function browserBridge(token, decodeBytes) {
  return `
  ${decodeBytes}
  globalThis.RpcTarget = class {};
  async function localCall(method, args) {
    const response = await fetch('/local-rpc', {method:'POST',credentials:'omit',headers:{'content-type':'application/json','x-bot-local-session':${JSON.stringify(token)}},body:JSON.stringify({method,args})});
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error('Local runtime: '+(result.error || 'call failed')+'. Agent, provider, setup and publishing actions are unavailable.');
    return __botDecodeBytes(result.value);
  }
  globalThis.gadget = new Proxy({}, { get(_, method) {
    if (method === 'then') return undefined;
    if (method === 'subscribe') return async () => ({supported:false,reason:'Local runtime has no push subscription. Reload to read changes.'});
    return async (...args) => {
      const value = await localCall(method, args);
      if (['setSelection','clearSelection','listItems'].includes(method)) {
        // Chat context is independent of the visible search/filter. The local
        // seed is bounded to three rows; this is not a general paginated adapter.
        const listing = await localCall('listItems', [{filter:'all'}]);
        parent.postMessage({type:'social-preview-selection',records:listing.items.filter(item=>item.selected).map(item=>({id:item.id,label:item.text}))},location.origin);
      }
      return value;
    };
  }});`;
}
