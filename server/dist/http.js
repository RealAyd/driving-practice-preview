import { createHmac, timingSafeEqual } from 'node:crypto';
/** Signed-in cookie: account id and expiry, signed with SESSION_SECRET. HttpOnly; Secure when served over HTTPS. */
const COOKIE = 'dp_session', COOKIE_DAYS = 60;
const b64 = (s) => Buffer.from(s).toString('base64url');
function sign(secret, accountId, now = Date.now()) {
    const body = b64(JSON.stringify({ a: accountId, e: now + COOKIE_DAYS * 86400_000 }));
    return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}
export function readSession(secret, value, now = Date.now()) {
    if (!value)
        return null;
    const [body, mac] = value.split('.');
    if (!body || !mac)
        return null;
    const want = createHmac('sha256', secret).update(body).digest('base64url');
    if (mac.length !== want.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(want)))
        return null;
    try {
        const { a, e } = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        return typeof a === 'string' && e > now ? a : null;
    }
    catch {
        return null;
    }
}
const cookies = (req) => Object.fromEntries((req.headers.cookie ?? '').split(';').map(c => c.trim().split('=')).filter(p => p.length === 2).map(([k, v]) => [k, decodeURIComponent(v)]));
class HttpError extends Error {
    status;
    code;
    constructor(status, code) {
        super(code);
        this.status = status;
        this.code = code;
    }
}
async function body(req, limit) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
        size += c.length;
        if (size > limit)
            throw new HttpError(413, 'too-large');
        chunks.push(c);
    }
    return Buffer.concat(chunks);
}
async function json(req) {
    if (!(req.headers['content-type'] ?? '').startsWith('application/json'))
        throw new HttpError(415, 'json-only');
    try {
        const v = JSON.parse((await body(req, 16_384)).toString('utf8'));
        return v && typeof v === 'object' ? v : {};
    }
    catch (e) {
        if (e instanceof HttpError)
            throw e;
        throw new HttpError(400, 'bad-json');
    }
}
const str = (v, max = 500) => typeof v === 'string' && v.length <= max ? v : null;
/** The request handler: everything under /api, plus /healthz. */
export function handler(service, outbox) {
    const { config } = service;
    const secure = config.appBaseUrl.startsWith('https://');
    const origin = new URL(config.appBaseUrl).origin;
    const setSession = (res, accountId) => res.setHeader('Set-Cookie', `${COOKIE}=${accountId ? sign(config.sessionSecret, accountId) : ''}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}; Max-Age=${accountId ? COOKIE_DAYS * 86400 : 0}`);
    const send = (res, status, data) => {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(data));
    };
    const redirect = (res, to) => { res.writeHead(303, { Location: to, 'Cache-Control': 'no-store' }); res.end(); };
    const ipOf = (req) => String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress || '?';
    return async (req, res) => {
        const url = new URL(req.url ?? '/', config.appBaseUrl);
        const path = url.pathname, method = req.method ?? 'GET';
        res.setHeader('X-Content-Type-Options', 'nosniff');
        try {
            if (path === '/healthz')
                return send(res, 200, { ok: true });
            // Posts from other sites are refused (Stripe's webhook and Apple's return post are checked their own way).
            const crossSite = method === 'POST' && req.headers.origin && req.headers.origin !== origin && path !== '/api/stripe/webhook' && path !== '/api/auth/apple/callback';
            if (crossSite)
                throw new HttpError(403, 'cross-site');
            const accountId = readSession(config.sessionSecret, cookies(req)[COOKIE]);
            const signedIn = () => { if (!accountId)
                throw new HttpError(401, 'sign-in'); return accountId; };
            if (method === 'GET' && path === '/api/config')
                return send(res, 200, {
                    gate: true, googleClientId: config.googleClientId, appleServicesId: config.appleServicesId, packs: service.packs(), devCheckout: config.devFakes,
                    appleRedirect: `${config.appBaseUrl}/api/auth/apple/callback`
                });
            if (method === 'GET' && path === '/api/me') {
                const me = accountId ? await service.me(accountId) : null;
                if (accountId && !me)
                    setSession(res, null);
                return send(res, 200, me ? { signedIn: true, ...me } : { signedIn: false });
            }
            if (method === 'POST' && path === '/api/auth/email') {
                const b = await json(req);
                const r = await service.requestEmailCode(str(b['email'], 254) ?? '', ipOf(req), str(b['ref'], 20) ?? undefined);
                return send(res, r === 'sent' ? 200 : r === 'invalid' ? 400 : 429, { result: r });
            }
            if (method === 'POST' && path === '/api/auth/email/code') {
                const b = await json(req);
                const a = await service.verifyEmailCode(str(b['email'], 254) ?? '', str(b['code'], 12) ?? '');
                if (!a)
                    return send(res, 400, { error: 'wrong-or-expired' });
                setSession(res, a.id);
                return send(res, 200, { ok: true });
            }
            if (method === 'GET' && path === '/api/auth/email/verify') {
                const a = await service.verifyEmailToken(url.searchParams.get('token') ?? '');
                if (!a)
                    return redirect(res, `${config.appBaseUrl}/?signin=expired`);
                setSession(res, a.id);
                return redirect(res, `${config.appBaseUrl}/?signin=done`);
            }
            if (method === 'POST' && (path === '/api/auth/google' || path === '/api/auth/apple')) {
                const b = await json(req);
                const credential = str(b['credential'], 8192);
                if (!credential)
                    throw new HttpError(400, 'credential');
                const a = await service.signInWith(path.endsWith('google') ? 'google' : 'apple', credential, str(b['ref'], 20) ?? undefined).catch(() => null);
                if (!a)
                    return send(res, 401, { error: 'not-verified' });
                setSession(res, a.id);
                return send(res, 200, { ok: true });
            }
            // Apple's own page posts back here when the popup cannot be used (form post with id_token; `state` carries the referral).
            if (method === 'POST' && path === '/api/auth/apple/callback') {
                const form = new URLSearchParams((await body(req, 16_384)).toString('utf8'));
                const token = form.get('id_token');
                const a = token ? await service.signInWith('apple', token, form.get('state')?.replace(/^ref:/, '') || undefined).catch(() => null) : null;
                if (!a)
                    return redirect(res, `${config.appBaseUrl}/?signin=failed`);
                setSession(res, a.id);
                return redirect(res, `${config.appBaseUrl}/?signin=done`);
            }
            if (method === 'POST' && path === '/api/auth/logout') {
                setSession(res, null);
                return send(res, 200, { ok: true });
            }
            // The address to pay for a pack, made by the server for the signed-in account (never assembled by the browser).
            if (method === 'POST' && path === '/api/checkout') {
                const id = signedIn(), b = await json(req);
                const r = await service.checkoutUrl(id, str(b['pack'], 40) ?? '');
                return 'url' in r ? send(res, 200, r) : send(res, r.error === 'starter-bought' ? 409 : 400, r);
            }
            if (method === 'POST' && path === '/api/drives') {
                const id = signedIn(), b = await json(req);
                const r = await service.startDrive(id, str(b['kind'], 40) ?? 'drive', str(b['scenario'], 80) ?? '');
                return r.ok ? send(res, 200, { driveId: r.drive.id, balance: r.balance }) : send(res, 402, { error: r.reason });
            }
            const drive = /^\/api\/drives\/([\w-]{8,64})\/(loaded|failed|completed)$/.exec(path);
            if (method === 'POST' && drive) {
                const ok = await service.driveStatus(signedIn(), drive[1], drive[2]);
                return send(res, ok ? 200 : 404, { ok });
            }
            if (method === 'POST' && path === '/api/stripe/webhook') {
                const raw = await body(req, 1_000_000);
                const r = await service.stripeWebhook(raw, String(req.headers['stripe-signature'] ?? ''));
                return send(res, r === 'ok' ? 200 : 400, { received: r === 'ok' });
            }
            // ---- Local development and tests only ----
            if (config.devFakes && outbox) {
                if (method === 'GET' && path === '/api/dev/outbox')
                    return send(res, 200, outbox.sent.slice(-5));
                // A pretend Payment Link checkout for the signed-in account, delivered as Stripe would.
                if (method === 'POST' && path === '/api/dev/checkout') {
                    const id = signedIn(), b = await json(req);
                    const pack = config.packs.find(p => p.id === b['pack']);
                    if (!pack)
                        throw new HttpError(400, 'pack');
                    const n = Date.now(), amount = Number(b['amountPence'] ?? Math.round(Number(pack.price.replace(/[^\d.]/g, '')) * 100));
                    await service.handleStripeEvent({ id: `evt_dev_${n}`, type: 'checkout.session.completed', data: { object: {
                                id: `cs_dev_${n}`, payment_status: amount > 0 ? 'paid' : 'no_payment_required', client_reference_id: id, payment_link: pack.id,
                                amount_total: amount, currency: 'gbp', payment_intent: amount > 0 ? `pi_dev_${n}` : null, customer_details: { email: null }
                            } } });
                    return send(res, 200, { ok: true });
                }
                if (method === 'POST' && path === '/api/dev/signin') {
                    const b = await json(req);
                    const a = await service.signIn('email', { sub: String(b['email']), email: String(b['email']), emailVerified: true }, str(b['ref'], 20) ?? undefined);
                    setSession(res, a.id);
                    return send(res, 200, { ok: true });
                }
            }
            return send(res, 404, { error: 'not-found' });
        }
        catch (e) {
            if (e instanceof HttpError)
                return send(res, e.status, { error: e.code });
            console.error(`${method} ${path}:`, e instanceof Error ? e.message : e);
            return send(res, 500, { error: 'server' });
        }
    };
}
