const [,, method, payloadJson] = process.argv;
const base = process.env.DSH_PORT ? `http://127.0.0.1:${process.env.DSH_PORT}` : 'http://127.0.0.1:59344';
const body = { type: 'client-request', rpcId: `zcode-${Date.now()}`, method, payload: payloadJson ? JSON.parse(payloadJson) : {} };
const r = await fetch(`${base}/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
console.log(JSON.stringify(await r.json(), null, 2));
