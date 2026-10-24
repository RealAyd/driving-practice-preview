import { readFileSync } from 'node:fs';
export function loadConfig(env = process.env) {
    const devFakes = env['DP_DEV_FAKES'] === '1';
    if (devFakes && env['NODE_ENV'] === 'production')
        throw new Error('DP_DEV_FAKES cannot be used with NODE_ENV=production');
    const need = (name) => {
        const v = env[name];
        if (!v && !devFakes)
            throw new Error(`Missing ${name}`);
        return v || null;
    };
    const stripeSecretKey = need('STRIPE_SECRET_KEY');
    const sessionSecret = env['SESSION_SECRET'] ?? (devFakes ? 'dev-only-secret-dev-only-secret-dev-only' : '');
    if (sessionSecret.length < 32)
        throw new Error('SESSION_SECRET must be at least 32 characters');
    const packsFile = env['PACKS_FILE'] ?? new URL('../packs.json', import.meta.url).pathname;
    return {
        port: Number(env['PORT'] ?? 8787),
        appBaseUrl: (env['APP_BASE_URL'] ?? 'http://localhost:4173').replace(/\/$/, ''),
        sessionSecret,
        mongoUri: need('MONGODB_URI'),
        stripeSecretKey,
        stripeWebhookSecret: need('STRIPE_WEBHOOK_SECRET'),
        stripeMode: stripeSecretKey?.includes('_live_') ? 'live' : 'test',
        resendApiKey: need('RESEND_API_KEY'),
        emailFrom: env['EMAIL_FROM'] ?? 'Driving Practice <support@drivingpractice.live>',
        emailReplyTo: env['EMAIL_REPLY_TO'] ?? 'support.drivingpractice@gmail.com',
        googleClientId: env['GOOGLE_CLIENT_ID'] || null,
        appleServicesId: env['APPLE_SERVICES_ID'] || null,
        supportInbox: env['SUPPORT_INBOX'] ?? env['EMAIL_REPLY_TO'] ?? 'support.drivingpractice@gmail.com',
        supportPushUrl: env['SUPPORT_PUSH_URL'] || null,
        supportReminderMinutes: Math.max(5, Number(env['SUPPORT_REMINDER_MINUTES'] ?? 30) || 30),
        adminEmails: (env['ADMIN_EMAILS'] ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
        // (Local fakes: each pack gets a placeholder link so a pretend checkout can name it.)
        packs: JSON.parse(readFileSync(packsFile, 'utf8')).packs
            .map(p => devFakes && !p.links.test ? { ...p, links: { ...p.links, test: `https://buy.stripe.com/test_dev_${p.id}` } } : p),
        devFakes
    };
}
