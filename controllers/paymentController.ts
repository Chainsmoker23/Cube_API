import * as express from 'express';
import crypto from 'crypto';
import { User } from '@supabase/supabase-js';
import { supabaseAdmin } from '../supabaseClient';
import { DodoPayments, mockSessions } from '../dodo-payments';
import { authenticateUser } from '../userUtils';
import { getCachedConfig } from './adminController';


// --- CONTROLLER FUNCTIONS ---

export const confirmMockPayment = async (req: express.Request, res: express.Response) => {
    const { sessionId } = req.body;
    if (typeof sessionId !== 'string' || !mockSessions.has(sessionId)) {
        return res.status(404).json({ error: 'Session not found or has expired.' });
    }
    const session = mockSessions.get(sessionId);

    try {
        const config = await getCachedConfig();
        
        if (!config.dodo_secret_key) {
            console.error('[Payment Controller] Dodo secret key is not configured for mock payment confirmation.');
            return res.status(500).json({ error: 'Payment processing is not configured on the server.' });
        }
        console.log('[Payment Controller] Mock Confirmation: Dodo secret key found. Initializing mock SDK.');
        const dodo = new DodoPayments(config.dodo_secret_key);
        
        // This is now "fire-and-forget". The new PaymentStatusPage on the frontend
        // is responsible for polling until the update is confirmed. This makes the
        // redirect instant and provides a much better, more realistic user experience
        // that avoids "session expired" timeouts.
        dodo.simulateWebhook(sessionId, session.customer, session.line_items, session.mode, session.metadata).catch(err => {
            // Log failures in the background process for debugging.
            console.error(`[Payment Controller] CRITICAL: Background webhook simulation failed for session ${sessionId}:`, err);
        });

        mockSessions.delete(sessionId);
        
        res.json({ success: true, redirectUrl: session.success_url });

    } catch (error: any) {
        console.error(`[Payment Controller] Error during mock payment confirmation: ${error.message}`);
        return res.status(500).json({ error: error.message || "Failed to initiate payment simulation." });
    }
};

export const handleDodoWebhook = async (req: express.Request, res: express.Response) => {
    console.log('[Payment Controller] Received a request on /api/dodo-webhook.');
    const signature = req.headers['dodo-signature'];
    if (!signature || typeof signature !== 'string') {
        console.error('[Payment Controller] Webhook Error: Missing signature header.');
        return res.status(400).send('Webhook Error: Missing signature.');
    }

    const config = await getCachedConfig();
    const dodoWebhookSecret = config.dodo_webhook_secret;

    if (!dodoWebhookSecret) {
        console.error('[Payment Controller] Webhook Error: Webhook secret is not configured on the server.');
        return res.status(500).send('Webhook Error: Webhook secret is not configured on the server.');
    }
    console.log('[Payment Controller] Webhook secret found. Proceeding with signature verification.');

    try {
        const expectedSignature = crypto
            .createHmac('sha256', dodoWebhookSecret)
            .update(req.body)
            .digest('hex');
        if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
            console.error('[Payment Controller] Webhook Error: Invalid signature.');
            return res.status(400).send('Webhook Error: Invalid signature.');
        }
    } catch (err) {
        console.error('[Payment Controller] Webhook Error: Invalid signature format during verification.', err);
        return res.status(400).send('Webhook Error: Invalid signature format.');
    }

    console.log('[Payment Controller] Webhook signature verified successfully.');
    const event = JSON.parse(req.body.toString());
    const session = event.data.object;
    const dodoCustomerId = session.customer;
    const metadata = session.metadata || {};
    const planName = metadata.plan_name;
    const subscriptionId = metadata.subscription_id; // The ID of our internal `subscriptions` record

    if (!dodoCustomerId || !planName) {
        console.error(`[Webhook] CRITICAL: Webhook received without customer ID or plan name in metadata. Event: ${event.type}`);
        return res.status(400).send('Webhook Error: Missing customer ID or plan name.');
    }

    // --- Find user by Dodo Customer ID ---
    const { data: customerMapping, error: customerError } = await supabaseAdmin
        .from('customers')
        .select('id') // This is the user_id
        .eq('dodo_customer_id', dodoCustomerId)
        .single();
        
    if (customerError || !customerMapping) {
        console.error(`[Webhook] Could not find user for Dodo customer ID: ${dodoCustomerId}. Error:`, customerError);
        return res.status(404).send('Customer not found.');
    }
    const userId = customerMapping.id;

    const processSubscriptionUpdate = async (status: string, dodoSubId?: string) => {
        // If we have a subscriptionId from metadata, we UPDATE the pending record.
        // Otherwise (for older flows or one-time payments), we insert.
        if (subscriptionId) {
            const { error: subUpdateError } = await supabaseAdmin
                .from('subscriptions')
                .update({ status, dodo_subscription_id: dodoSubId })
                .eq('id', subscriptionId)
                .eq('user_id', userId); // Security check
            
            if (subUpdateError) {
                 console.error(`[Webhook] Failed to UPDATE subscription record ${subscriptionId} for user ${userId}. Error:`, subUpdateError);
                 return;
            }
        } else {
             const { error: subInsertError } = await supabaseAdmin
                .from('subscriptions')
                .insert({
                    user_id: userId,
                    dodo_subscription_id: dodoSubId,
                    plan_name: planName,
                    status: status,
                });
            if (subInsertError) {
                console.error(`[Webhook] Failed to INSERT subscription record for user ${userId}. Error:`, subInsertError);
                return;
            }
        }
        
        // Update the user's metadata for quick client-side access.
        const { data: { user }, error: userGetError } = await supabaseAdmin.auth.admin.getUserById(userId);
        if (userGetError || !user) {
             console.error(`[Webhook] Could not retrieve user ${userId} to update metadata. Error:`, userGetError);
             return;
        }

        const { data: subs, error: subsError } = await supabaseAdmin
            .from('subscriptions')
            .select('plan_name')
            .eq('user_id', userId)
            .eq('status', 'active');
        
        if (subsError) {
            console.error(`[Webhook] Failed to fetch active subs for user ${userId} during metadata update. Error:`, subsError);
            // Don't block, proceed with existing metadata as fallback
        }

        const activePlans = subs?.map(s => s.plan_name) || [];
        if (!activePlans.includes(planName)) {
            activePlans.push(planName);
        }

        const planPriority: { [key: string]: number } = { 'pro': 2, 'hobbyist': 1, 'free': 0 };
        
        // Determine the best active plan
        const bestPlan = activePlans.reduce((best, current) => {
            return (planPriority[current] || 0) > (planPriority[best] || 0) ? current : best;
        }, 'free');

        // Only update metadata if the new best plan is different from what's there
        if (user.user_metadata?.plan !== bestPlan) {
            const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(
                userId,
                { user_metadata: { ...(user.user_metadata || {}), plan: bestPlan } }
            );
            if (updateError) {
                console.error(`[Webhook] Failed to update user metadata for user ${userId}. Error:`, updateError);
            } else {
                 console.log(`[Webhook] User ${userId} metadata updated to highest active plan: '${bestPlan}'.`);
            }
        }
        
        console.log(`[Webhook] Successfully processed '${status}' for user ${userId} for plan '${planName}'.`);
    };


    switch (event.type) {
        case 'payment.succeeded':
        case 'subscription.active': {
            console.log(`[Payment Controller] Handling webhook event: ${event.type}`);
            const dodoSubscriptionId = event.type === 'subscription.active' ? session.id : null;
            await processSubscriptionUpdate('active', dodoSubscriptionId);
            break;
        }
        case 'subscription.cancelled':
        case 'subscription.expired': {
            console.log(`[Payment Controller] Handling webhook event: ${event.type}`);
            await processSubscriptionUpdate(event.type.split('.')[1]);
            break;
        }
        default:
            console.log(`[Dodo Webhook] Unhandled event type: ${event.type}`);
    }
    
    res.status(200).send({ received: true });
};

export const createCheckoutSession = async (req: express.Request, res: express.Response) => {
    const { productId, planName, mode } = req.body;
    const user = await authenticateUser(req);
    
    if (!user) {
        return res.status(401).send({ error: 'Unauthorized: Invalid token.' });
    }

    if (!productId || !planName || !mode) {
        return res.status(400).json({ error: 'Missing required parameters: productId, planName, and mode.' });
    }

    // --- Business Logic: Enforce plan hierarchy (Pro > Hobbyist > Free) ---
    const planPriority: { [key: string]: number } = { 'pro': 2, 'hobbyist': 1, 'free': 0 };
    const planToBuy = planName.toLowerCase();

    const { data: activeSubs, error: activeSubsError } = await supabaseAdmin
        .from('subscriptions')
        .select('plan_name')
        .eq('user_id', user.id)
        .eq('status', 'active');
    
    if (activeSubsError) {
        console.error(`[Payment Controller] DB error checking for active subs for user ${user.id}:`, activeSubsError);
        return res.status(500).json({ error: 'Could not verify your current subscriptions.' });
    }

    const bestCurrentPlan = (activeSubs || []).reduce((best, current) => {
        return (planPriority[current.plan_name] || 0) > (planPriority[best] || 0) ? current.plan_name : best;
    }, 'free');

    if ((planPriority[planToBuy] || 0) <= (planPriority[bestCurrentPlan] || 0)) {
        return res.status(409).json({ error: `You cannot purchase this plan as you already have a higher-tier plan active.` });
    }
    // --- End Business Logic ---


    let pendingSubId: string | null = null;
    if (mode === 'subscription') {
        const { data: existingSubscription, error: subCheckError } = await supabaseAdmin
            .from('subscriptions')
            .select('id, status')
            .eq('user_id', user.id)
            .eq('plan_name', planName.toLowerCase())
            .in('status', ['active', 'pending']);

        if (subCheckError) {
            console.error(`[Payment Controller] DB error checking for existing sub for user ${user.id}:`, subCheckError);
            return res.status(500).json({ error: 'Could not verify your current subscriptions.' });
        }

        if (existingSubscription && existingSubscription.length > 0) {
            const sub = existingSubscription[0];
            if (sub.status === 'pending') {
                 return res.status(409).json({ error: `A checkout for the '${planName}' plan is already in progress.` });
            }
            return res.status(409).json({ error: `You already have an active '${planName}' subscription.` });
        }
        
        const { data: newPendingSub, error: insertError } = await supabaseAdmin
            .from('subscriptions')
            .insert({ user_id: user.id, plan_name: planName.toLowerCase(), status: 'pending' })
            .select('id')
            .single();

        if (insertError || !newPendingSub) {
            console.error(`[Payment Controller] DB error creating pending sub for user ${user.id}:`, insertError);
            return res.status(500).json({ error: 'Could not initiate your subscription.' });
        }
        pendingSubId = newPendingSub.id;
    }

    try {
        const config = await getCachedConfig();
        const dodoSecretKey = config.dodo_secret_key;
        const siteUrl = config.site_url;

        if (!dodoSecretKey || !siteUrl) {
            return res.status(500).send({ error: 'Payment system is not configured correctly on the server.' });
        }
        console.log('[Payment Controller] Create Session: Dodo secret key and site URL found. Proceeding.');

        const dodo = new DodoPayments(dodoSecretKey);
        let dodoCustomerId = user.user_metadata.dodo_customer_id;

        if (!dodoCustomerId) {
            const { data: customerRecord } = await supabaseAdmin
                .from('customers')
                .select('dodo_customer_id')
                .eq('id', user.id)
                .single();
            
            if (customerRecord) {
                dodoCustomerId = customerRecord.dodo_customer_id;
            }
        }
        
        if (!dodoCustomerId) {
            const customer = await dodo.customers.create({ email: user.email, name: user.user_metadata.full_name });
            dodoCustomerId = customer.id;
            
            await supabaseAdmin.from('customers').insert({ id: user.id, dodo_customer_id: dodoCustomerId });
            await supabaseAdmin.auth.admin.updateUserById(user.id, { user_metadata: { ...user.user_metadata, dodo_customer_id: dodoCustomerId } });
        }

        const cleanSiteUrl = siteUrl.endsWith('/') ? siteUrl.slice(0, -1) : siteUrl;
        const successUrl = `${cleanSiteUrl}/#api?payment=success&plan=${planName.toLowerCase()}`;
        
        console.log(`[Payment Controller] Generated success_url for Dodo checkout: ${successUrl}`);

        const session = await dodo.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{ price: productId, quantity: 1 }],
            mode: mode,
            success_url: successUrl,
            cancel_url: `${cleanSiteUrl}/#api?payment=cancelled`,
            customer: dodoCustomerId,
            metadata: {
                plan_name: planName.toLowerCase(),
                subscription_id: pendingSubId,
            },
        });
        
        console.log(`[Payment Controller] Successfully created Dodo checkout session ${session.id} for user ${user.id}.`);
        res.send({ sessionId: session.id });
    } catch (error: any) {
        console.error(`[Payment Controller] Uncaught error in createCheckoutSession: ${error.message}`);
        res.status(500).send({ error: 'Internal server error.' });
    }
};