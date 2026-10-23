import Stripe from 'stripe';
import { createRemoteJWKSet, jwtVerify } from 'jose';
/** Email through Resend's API. */
export function resendMailer(config) {
    return { async send(m) {
            const res = await fetch('https://api.resend.com/emails', { method: 'POST',
                headers: { Authorization: `Bearer ${config.resendApiKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ from: config.emailFrom, to: [m.to], reply_to: config.emailReplyTo, subject: m.subject, text: m.text, html: m.html }) });
            // (The provider's message is kept for the log; the key never is.)
            if (!res.ok)
                throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 300)}`);
        } };
}
/** Google and Apple ID tokens, checked against their published keys (signature, issuer, audience, expiry). */
export function identityVerifier(config) {
    const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
    const appleKeys = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));
    const verified = (v) => v === true || v === 'true';
    return {
        async google(credential) {
            if (!config.googleClientId)
                throw new Error('Google sign-in is not set up');
            const { payload } = await jwtVerify(credential, googleKeys, { issuer: ['https://accounts.google.com', 'accounts.google.com'], audience: config.googleClientId });
            return { sub: String(payload.sub), email: typeof payload['email'] === 'string' ? payload['email'] : null, emailVerified: verified(payload['email_verified']) };
        },
        async apple(idToken) {
            if (!config.appleServicesId)
                throw new Error('Apple sign-in is not set up');
            const { payload } = await jwtVerify(idToken, appleKeys, { issuer: 'https://appleid.apple.com', audience: config.appleServicesId });
            return { sub: String(payload.sub), email: typeof payload['email'] === 'string' ? payload['email'] : null, emailVerified: verified(payload['email_verified']) };
        }
    };
}
export function stripeApi(config) {
    const stripe = new Stripe(config.stripeSecretKey);
    const links = new Map();
    return {
        constructEvent: (raw, signature) => stripe.webhooks.constructEvent(raw, signature, config.stripeWebhookSecret),
        async paymentLink(id) {
            const known = links.get(id);
            if (known)
                return known;
            const link = await stripe.paymentLinks.retrieve(id).catch(() => null);
            if (!link)
                return null;
            const v = { url: link.url, metadata: { ...link.metadata } };
            links.set(id, v);
            return v;
        }
    };
}
// ---- Local development and tests (DP_DEV_FAKES=1): nothing leaves the machine ----
export class OutboxMailer {
    sent = [];
    async send(m) { this.sent.push(m); }
}
/** Fake identities: the "token" is `sub|email`. */
export const fakeIdentities = {
    async google(t) { const [sub = '', email = ''] = t.split('|'); return { sub, email, emailVerified: true }; },
    async apple(t) { const [sub = '', email = ''] = t.split('|'); return { sub, email: email || null, emailVerified: true }; }
};
/** Fake Stripe: events are trusted JSON (signature "dev"); a payment link's id is its pack's id. */
export function fakeStripe(config) {
    return {
        constructEvent(raw, signature) {
            if (signature !== 'dev')
                throw new Error('bad signature');
            return JSON.parse(raw.toString('utf8'));
        },
        async paymentLink(id) {
            const pack = config.packs.find(p => p.id === id);
            return pack ? { url: pack.links[config.stripeMode], metadata: {} } : null;
        }
    };
}
