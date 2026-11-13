/** Waits between attempts to reach the database (seconds), the last repeated: it is never given up on. */
const RETRY_SECONDS = [1, 2, 5, 10, 30];
/**
 * Keeps trying `connect` until it succeeds (the database restarting, or slow to come up), reporting each failure. The
 * server answers meanwhile rather than exiting, so the host sees an outage, not a crash loop.
 */
export async function retrying(connect, failed, wait = s => new Promise(r => setTimeout(r, s * 1000))) {
    for (let attempt = 1;; attempt++) {
        try {
            return await connect();
        }
        catch (e) {
            const s = RETRY_SECONDS[Math.min(attempt - 1, RETRY_SECONDS.length - 1)];
            failed(attempt, e, s);
            await wait(s);
        }
    }
}
/** The answer while the database is not yet reached: the health check says so; the API asks to be tried again soon. */
export function notReady(req, res) {
    const path = (req.url ?? '/').split('?')[0];
    const [status, body] = path === '/healthz' ? [200, { ok: true, ready: false }] : [503, { error: 'starting' }];
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(status === 503 ? { 'Retry-After': '5' } : {}) });
    res.end(JSON.stringify(body));
}
/** A database error's text, without the connection string it may carry (credentials). */
export const describe = (e) => (e instanceof Error ? e.message : String(e)).replace(/mongodb(\+srv)?:\/\/[^\s]*/g, 'mongodb://…');
