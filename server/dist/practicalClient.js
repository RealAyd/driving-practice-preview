import { NotLinkedError, PRACTICAL_ID } from './practical.js';
/** A Practical address this client will call: https, or http to this machine (tests). */
export function practicalBase(base) {
    const u = new URL(base);
    const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local))
        throw new Error('Practical must be reached over https');
    if (u.username || u.password || u.search || u.hash)
        throw new Error('Practical base address must be a plain origin and path');
    return u.toString().replace(/\/$/, '');
}
export class HttpPracticalApi {
    o;
    base;
    fetch;
    constructor(o) {
        this.o = o;
        this.base = practicalBase(o.base);
        this.fetch = o.fetch ?? fetch;
    }
    authorizeUrl(p) {
        const q = new URLSearchParams({ state: p.state, code_challenge: p.codeChallenge, code_challenge_method: 'S256', redirect_uri: this.o.redirectUri, client_id: this.o.clientId });
        return `${this.base}/api/integrations/simulator/authorize?${q}`;
    }
    async exchangeCode(code, verifier) {
        const r = await this.call('POST', '/api/integrations/simulator/link/exchange', this.o.premiumToken, { code, code_verifier: verifier, redirect_uri: this.o.redirectUri, client_id: this.o.clientId });
        if (typeof r?.practicalAccountId !== 'string' || !PRACTICAL_ID.test(r.practicalAccountId))
            throw new Error('Practical: malformed exchange answer');
        return { practicalAccountId: r.practicalAccountId };
    }
    entitlement(practicalAccountId) {
        return this.call('POST', '/api/integrations/simulator/entitlement', this.o.premiumToken, { practicalAccountId }, true);
    }
    async centreDemand() {
        if (!this.o.demandToken)
            throw new Error('Practical: no credential for test-centre requests');
        const r = await this.call('GET', '/api/integrations/simulator/centre-demand', this.o.demandToken);
        if (!Array.isArray(r))
            throw new Error('Practical: malformed test-centre answer');
        return r;
    }
    /** One request: JSON in and out, the credential in the header, a time limit; any failure throws (never grants). */
    async call(method, path, token, body, linked = false) {
        let res;
        try {
            res = await this.fetch(`${this.base}${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(this.o.timeoutMs ?? 5000),
                headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        }
        catch (e) {
            // (Only the kind of failure: never the address with anything in it, never the credential.)
            throw new Error(`Practical unreachable (${e instanceof Error && e.name === 'TimeoutError' ? 'timeout' : 'network'})`);
        }
        // (Asked about a linked account and told it is not linked: consent was withdrawn at Practical.)
        if (linked && res.status === 404 && await res.json().then((b) => b?.detail === 'Not linked', () => false))
            throw new NotLinkedError();
        if (!res.ok)
            throw new Error(`Practical answered ${res.status}`);
        if (!(res.headers.get('content-type') ?? '').includes('application/json'))
            throw new Error('Practical: not JSON');
        try {
            return await res.json();
        }
        catch {
            throw new Error('Practical: malformed JSON');
        }
    }
}
