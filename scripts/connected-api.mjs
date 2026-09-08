const routes = new Map([
  ['/api/auth/get-session', ['GET']],
  ['/api/auth/dev-sign-in', ['POST']],
  ['/api/auth/sign-out', ['POST']],
  ['/api/agenticos/v1/studio/shell', ['GET']],
  ['/api/dev/session', ['POST']],
  ['/api/dev/rpc', ['POST']],
  ['/api/agenticos/v2/workspaces', ['GET']]
]);
const tokenKeys = new Set(['token','access_token','accessToken']);
export function redactCredentials(value) {
  if (Array.isArray(value)) return value.map(redactCredentials);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key])=>!tokenKeys.has(key)).map(([key,value])=>[key,redactCredentials(value)]));
}

/** Local BFF only. Authentication remains the API's existing Better Auth flow. */
export function createConnectedApi({apiOrigin, frontendOrigin, development, fetcher = fetch}) {
  const api = new URL(apiOrigin);
  const frontend = new URL(frontendOrigin);
  if (api.origin !== apiOrigin || api.protocol !== 'http:' || !['127.0.0.1','localhost'].includes(api.hostname))
    throw new Error('Connected preview requires an explicit loopback HTTP API origin.');
  if (frontend.origin !== frontendOrigin || frontend.protocol !== 'http:' || !['social.localhost','127.0.0.1','localhost'].includes(frontend.hostname))
    throw new Error('Connected preview requires an explicit local frontend origin.');
  return async function handle(request) {
    const url = new URL(request.url);
    const fail = (status,error)=>Response.json({error:{message:error}},{status,headers:{'cache-control':'no-store'}});
    if (!routes.get(url.pathname)?.includes(request.method)) return fail(404,'Route unavailable in connected preview.');
    if (url.origin !== frontendOrigin || request.headers.get('sec-fetch-site') === 'cross-site') return fail(403,'Origin refused.');
    if (request.method !== 'GET' && request.headers.get('origin') !== frontendOrigin) return fail(403,'Origin refused.');
    const headers = new Headers({accept:'application/json'});
    for (const key of ['cookie','origin','content-type']) {
      const value=request.headers.get(key);if(value)headers.set(key,value);
    }
    let body;
    if (request.method !== 'GET') {
      if (!headers.get('content-type')?.startsWith('application/json')) return fail(415,'JSON required.');
      const reader=request.body?.getReader();const chunks=[];let size=0;
      if(reader)try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;
        if(size>16384){await reader.cancel();return fail(413,'Request too large.');}chunks.push(value);
      }}finally{reader.releaseLock();}
      body=Buffer.concat(chunks);
    }
    const starting = url.pathname === '/api/dev/session';
    if (starting || url.pathname === '/api/dev/rpc') {
      if (!development) return fail(503,'Local source runtime is not configured.');
      if(!starting)try{return await development.call(new Request(request.url,{method:'POST',headers:request.headers,body}));}
      catch {return fail(403,'Local development session is unavailable for this account.');}
      let input;
      try { input=JSON.parse(body.toString()); } catch { return fail(400,'Invalid JSON.'); }
      if (!input || Array.isArray(input) || typeof input !== 'object' || Object.keys(input).length) return fail(400,'Session identity is assigned by the local host.');
      try{return Response.json({data:await development.start(request)},{headers:{'cache-control':'no-store'}});}
      catch {return fail(409,'Could not start local runtime. Check your local session and the development server.');}
    }
    const path=url.pathname.startsWith('/api/agenticos/')?url.pathname.slice('/api/agenticos'.length):url.pathname;
    try {
      const upstream=await fetcher(apiOrigin+path+url.search,{method:request.method,headers,body,redirect:'manual',signal:AbortSignal.timeout(15000)});
      const safeHeaders = new Headers({'content-type':'application/json','cache-control':'no-store'});
      for(const cookie of upstream.headers.getSetCookie())safeHeaders.append('set-cookie',cookie);
      if(upstream.status===204)return new Response(null,{status:204,headers:safeHeaders});
      // Never forward bearer response headers, credential JSON fields or redirects.
      const payload=redactCredentials(await upstream.json());
      return Response.json(payload,{status:upstream.status,headers:safeHeaders});
    } catch { return fail(502,'The local API is unavailable.'); }
  };
}
