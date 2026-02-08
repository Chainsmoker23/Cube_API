import * as express from 'express';
import { supabaseAdmin } from '../supabaseClient';
import { getDodoClient } from '../dodo-payments';
import { authenticateUser } from '../userUtils';
import { getCachedConfig } from './adminController';
import crypto from 'crypto';
import { activatePlanAndUpdateUser } from '../paymentUtils';


// --- HELPER: Centralized Webhook Processing Logic ---
const processWebhookEvent = async (event: any) => {
    console.log(`[Webhook Processor] Processing event type: ${event.type}`);
    const dodoObject = event.data.object;

    switch (event.type) {
        case 'payment.succeeded':
            const metadata = dodoObject.metadata || {};
            const { user_id: userId, subscription_id: ourPendingSubId, plan_name: planName } = metadata;

            if (!userId || !ourPendingSubId) {
                console.error(`[Webhook] 'payment.succeeded' is missing required metadata: userId or our subscription_id.`);
                return { success: false, message: 'Webhook Error: Missing required metadata.' };
            }

            // Fetch our internal subscription record
            const { data: pendingSub, error: subFetchError } = await supabaseAdmin
                .from('subscriptions')
                .select('*')
                .eq('id', ourPendingSubId)
                .single();

            if (subFetchError || !pendingSub) {
                console.error(`[Webhook] Could not find pending subscription record ${ourPendingSubId}.`);
                return { success: false, message: 'Internal subscription record not found.' };
            }

            // Distinguish between one-time and subscription payments
            if (planName === 'hobbyist') {
                // Canonicalize reference id for one-time payments
                const referenceId = dodoObject.payment_id || dodoObject.payment_intent || dodoObject.id;
                const subToActivate = { ...pendingSub, dodo_subscription_id: referenceId };
                console.log('[Webhook] Prepared activation for one-time payment:', {
                    userId,
                    ourPendingSubId,
                    planName,
                    referenceId,
                    dodo_session_id: pendingSub?.dodo_session_id,
                    existing_dodo_subscription_id: pendingSub?.dodo_subscription_id,
                });
                await activatePlanAndUpdateUser(userId, subToActivate);
                console.log(`[Webhook] Successfully processed ONE-TIME payment for hobbyist plan for user ${userId}.`);

            } else if (planName === 'pro') {
                // Accept both subscription and subscription_id fields
                const dodoSubscriptionId = dodoObject.subscription || dodoObject.subscription_id;
                if (!dodoSubscriptionId) {
                    console.error(`[Webhook] CRITICAL: 'payment.succeeded' for 'pro' plan missing subscription identifier in payload. Dodo Object:`, dodoObject);
                    return { success: false, message: 'Pro plan activation failed: missing subscription ID from payment provider.' };
                }

                const subToActivate = { ...pendingSub, dodo_subscription_id: dodoSubscriptionId };
                console.log('[Webhook] Prepared activation for subscription payment:', {
                    userId,
                    ourPendingSubId,
                    planName,
                    dodoSubscriptionId,
                    dodo_session_id: pendingSub?.dodo_session_id,
                    existing_dodo_subscription_id: pendingSub?.dodo_subscription_id,
                });
                await activatePlanAndUpdateUser(userId, subToActivate);
                console.log(`[Webhook] Successfully processed initial SUBSCRIPTION payment for pro plan for user ${userId}.`);
            } else {
                console.warn(`[Webhook] 'payment.succeeded' event had an unhandled plan_name in metadata: '${planName}'`);
            }
            break;

        case 'subscription.cancelled':
            const { data: cancelledSub, error: cancelError } = await supabaseAdmin.from('subscriptions').update({ status: 'cancelled' }).eq('dodo_subscription_id', dodoObject.id).select('user_id').single();
            if (cancelError) {
                console.error(`[Webhook] DB Error cancelling subscription ${dodoObject.id}:`, cancelError);
                return; // Stop processing if we can't update our DB record
            }

            if (cancelledSub) {
                const { data: otherActiveSubs } = await supabaseAdmin.from('subscriptions').select('plan_name').eq('user_id', cancelledSub.user_id).eq('status', 'active');

                // If there are no other active subscriptions, downgrade the user to free.
                if (!otherActiveSubs || otherActiveSubs.length === 0) {
                    const { data: { user: oldUser } } = await supabaseAdmin.auth.admin.getUserById(cancelledSub.user_id);
                    const newMetadata = { ...oldUser?.user_metadata, plan: 'free', generation_balance: 0 }; // Reset balance
                    await supabaseAdmin.auth.admin.updateUserById(cancelledSub.user_id, { user_metadata: newMetadata });
                    console.log(`[Webhook] User ${cancelledSub.user_id} reverted to 'free' plan with 0 credits after subscription cancellation.`);
                } else {
                    console.log(`[Webhook] User ${cancelledSub.user_id} has other active plans, not downgrading to free.`);
                }
            }
            break;

        case 'payment.failed':
            await supabaseAdmin.from('subscriptions').update({ status: 'past_due' }).eq('dodo_subscription_id', dodoObject.subscription);
            console.log(`[Webhook] Payment failed for subscription ${dodoObject.subscription}, marked as past_due.`);
            break;

        case 'subscription.expired':
            // Subscription has reached the end of its term and expired
            const { data: expiredSub, error: expireError } = await supabaseAdmin
                .from('subscriptions')
                .update({ status: 'expired' })
                .eq('dodo_subscription_id', dodoObject.id)
                .select('user_id')
                .single();

            if (expireError) {
                console.error(`[Webhook] DB Error expiring subscription ${dodoObject.id}:`, expireError);
                return;
            }

            console.log(`[Webhook] Subscription ${dodoObject.id} expired.`);

            // Downgrade user if no other active subs
            if (expiredSub) {
                const { data: otherActiveSubs } = await supabaseAdmin
                    .from('subscriptions')
                    .select('plan_name')
                    .eq('user_id', expiredSub.user_id)
                    .eq('status', 'active');

                if (!otherActiveSubs || otherActiveSubs.length === 0) {
                    const { data: { user: oldUser } } = await supabaseAdmin.auth.admin.getUserById(expiredSub.user_id);
                    const newMetadata = { ...oldUser?.user_metadata, plan: 'free', generation_balance: 0 };
                    await supabaseAdmin.auth.admin.updateUserById(expiredSub.user_id, { user_metadata: newMetadata });
                    console.log(`[Webhook] User ${expiredSub.user_id} reverted to 'free' plan after subscription expired.`);
                }
            }
            break;

        case 'subscription.on_hold':
            // Subscription put on hold due to failed renewal payment
            const { data: onHoldSub, error: holdError } = await supabaseAdmin
                .from('subscriptions')
                .update({ status: 'past_due' })
                .eq('dodo_subscription_id', dodoObject.id)
                .select('user_id')
                .single();

            if (holdError) {
                console.error(`[Webhook] DB Error setting subscription ${dodoObject.id} on hold:`, holdError);
                return;
            }
            console.log(`[Webhook] Subscription ${dodoObject.id} put on_hold, marked as past_due.`);
            break;

        case 'subscription.renewed':
            // Subscription has been renewed - extend period_ends_at and ensure status is active
            const newPeriodEnd = new Date();
            newPeriodEnd.setDate(newPeriodEnd.getDate() + 30); // Extend by 30 days

            const { data: renewedSub, error: renewError } = await supabaseAdmin
                .from('subscriptions')
                .update({
                    status: 'active',
                    period_ends_at: newPeriodEnd.toISOString()
                })
                .eq('dodo_subscription_id', dodoObject.id)
                .select('user_id, plan_name')
                .single();

            if (renewError) {
                console.error(`[Webhook] DB Error renewing subscription ${dodoObject.id}:`, renewError);
                return;
            }

            // Ensure user metadata reflects active plan
            if (renewedSub) {
                const { data: { user: renewedUser } } = await supabaseAdmin.auth.admin.getUserById(renewedSub.user_id);
                const newMetadata = { ...renewedUser?.user_metadata, plan: renewedSub.plan_name };
                await supabaseAdmin.auth.admin.updateUserById(renewedSub.user_id, { user_metadata: newMetadata });
                console.log(`[Webhook] Subscription ${dodoObject.id} renewed. User ${renewedSub.user_id} extended to ${newPeriodEnd.toISOString()}.`);
            }
            break;

        default:
            console.log(`[Webhook Processor] Unhandled event type: ${event.type}`);
    }
    return { success: true };
};


// --- CONTROLLERS ---

export const handleDodoWebhook = async (req: express.Request, res: express.Response) => {
    const signature = req.headers['dodo-signature'] as string;
    if (!signature) {
        return res.status(400).send('Webhook Error: Missing signature.');
    }

    try {
        const { dodo_webhook_secret } = await getCachedConfig();
        if (!dodo_webhook_secret) throw new Error('Server not configured for payments.');

        const hmac = crypto.createHmac('sha256', dodo_webhook_secret);
        hmac.update(req.body);
        const computedSignature = hmac.digest('hex');

        if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(computedSignature))) {
            return res.status(400).send('Webhook Error: Signature verification failed.');
        }

        await processWebhookEvent(JSON.parse(req.body.toString()));
        res.status(200).json({ received: true });

    } catch (err: any) {
        console.error('[Payment Controller] Webhook processing error:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }
};

export const createCheckoutSession = async (req: express.Request, res: express.Response) => {
    const user = await authenticateUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized.' });

    const { plan: planId } = req.body;
    if (!planId) return res.status(400).json({ error: 'Missing parameter: plan is required.' });

    try {
        const config = await getCachedConfig();
        const planName = planId === 'one_time' ? 'hobbyist' : 'pro';

        // CRITICAL FIX: Differentiate between one-time payments and recurring subscriptions.
        // This ensures Dodo treats each product type correctly.
        const mode = planId === 'one_time' ? 'payment' : 'subscription';

        const productId = planId === 'one_time' ? config.dodo_hobbyist_product_id : config.dodo_pro_product_id;

        if (!productId) throw new Error(`${planName} product ID is not configured on the server.`);

        // Create a pending record in our database to track this checkout attempt.
        const { data: newSubscription, error: insertError } = await supabaseAdmin.from('subscriptions').insert({ user_id: user.id, plan_name: planName, status: 'pending' }).select('id').single();
        if (insertError) {
            console.error(`[Checkout] CRITICAL: Failed to insert pending subscription for user ${user.id}`, insertError);
            throw insertError;
        }
        console.log(`[Checkout] Created pending subscription record ${newSubscription.id} for user ${user.id}.`);

        const { data: customerData } = await supabaseAdmin.from('customers').select('dodo_customer_id').eq('id', user.id).single();
        const dodo = await getDodoClient();
        const cleanSiteUrl = (config.site_url || '').replace(/\/$/, '');

        // After any successful payment, redirect the user to the main app page where they can use their new benefits.
        const returnUrlHash = 'app';

        const sessionPayload: any = {
            mode,
            product_cart: [{ product_id: productId, quantity: 1 }],
            return_url: `${cleanSiteUrl}/#${returnUrlHash}?payment=success&plan=${planName}&sub_id=${newSubscription.id}`,
            cancel_url: `${cleanSiteUrl}/#api?payment=cancelled`,
            billing_address_collection: 'required',
            metadata: { user_id: user.id, plan_name: planName, subscription_id: newSubscription.id, mode },
            customer: customerData?.dodo_customer_id || { email: user.email, name: user.user_metadata?.full_name || user.email?.split('@')[0] },
        };

        const session = await dodo.checkoutSessions.create(sessionPayload);
        await supabaseAdmin.from('subscriptions').update({ dodo_session_id: session.session_id }).eq('id', newSubscription.id);

        if (!session.checkout_url) throw new Error('Payment provider did not return a valid checkout URL.');

        res.status(200).json({ success: true, checkout_url: session.checkout_url });

    } catch (error: any) {
        console.error(`[Payment Controller] Error in createCheckoutSession:`, error);
        res.status(500).json({ error: error.message || 'An internal server error occurred.' });
    }
};
