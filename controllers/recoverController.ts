import * as express from 'express';
import { supabaseAdmin } from '../supabaseClient';
import { authenticateUser } from '../userUtils';
import { activatePlanAndUpdateUser } from '../paymentUtils';
import { getVerifiedDodoSessionById, getVerifiedDodoSessionByPaymentId } from './paymentVerification';

export const handleVerifyPaymentStatus = async (req: express.Request, res: express.Response) => {
    const user = await authenticateUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized.' });

    const { subscriptionId } = req.body;
    if (!subscriptionId) return res.status(400).json({ error: 'Subscription ID is required.' });

    try {
        const { data: subscription, error } = await supabaseAdmin.from('subscriptions').select('*').eq('id', subscriptionId).eq('user_id', user.id).single();
        console.log('[Verify] Loaded subscription for verification:', { subscription, error });
        if (error || !subscription) return res.status(404).json({ error: 'Subscription not found.' });
        if (subscription.status === 'active') return res.json({ success: true, message: 'Plan already active.' });
        if (subscription.status !== 'pending' || !subscription.dodo_session_id) return res.status(409).json({ error: 'Subscription is not in a verifiable state.' });

        console.log('[Verify] Verifying Dodo session by ID:', subscription.dodo_session_id);
        const dodoSession = await getVerifiedDodoSessionById(subscription.dodo_session_id);
        console.log('[Verify] Raw Dodo session verification result:', dodoSession);
        
        if (dodoSession) {
            console.log(`[Payment Verify] Dodo session ${subscription.dodo_session_id} is complete. Manually triggering activation.`);

            // Infer flow without relying on metadata (LIVE sessions may omit metadata)
            let referenceId: string | null = null;
            if (dodoSession.payment_id || dodoSession.payment_intent) {
                // One-time payment flow
                referenceId = dodoSession.payment_id || dodoSession.payment_intent;
            } else if (dodoSession.subscription_id) {
                // Recurring subscription flow
                referenceId = dodoSession.subscription_id;
            }

            if (!referenceId) {
                throw new Error('Verification failed: Could not determine a permanent reference (payment_id/payment_intent/subscription_id).');
            }
            
            console.log('[Verify] Prepared activation payload:', {
                selectedReferenceId: referenceId,
                plan_name: subscription.plan_name,
                dodo_session_id: subscription.dodo_session_id,
                existing_dodo_subscription_id: subscription.dodo_subscription_id,
            });
            const subToActivate = { ...subscription, dodo_subscription_id: referenceId };
            await activatePlanAndUpdateUser(user.id, subToActivate);
            res.json({ success: true, message: 'Payment verified and plan updated.' });

        } else {
            res.status(202).json({ success: false, message: 'Payment not yet confirmed.' });
        }

    } catch (err: any) {
        console.error('[Verify] Error while verifying payment status:', err);
        res.status(500).json({ error: `Verification failed: ${err.message}` });
    }
};

export const handleRecoverByPaymentId = async (req: express.Request, res: express.Response) => {
    const { paymentId } = req.body;
    if (!paymentId) return res.status(400).json({ error: 'Payment ID is required.' });

    try {
        console.log(`[Payment Recovery] Starting recovery for paymentId: ${paymentId}`);
        const dodoSession = await getVerifiedDodoSessionByPaymentId(paymentId);
        console.log('[Payment Recovery] Raw Dodo session from recovery lookup:', dodoSession);

        if (!dodoSession) {
            return res.status(202).json({ success: false, message: 'Payment provider has not yet marked this transaction as complete.' });
        }

        // LIVE sessions may not include metadata; locate our pending subscription by session id
        const sessionId = dodoSession.id;
        const { data: subscription, error } = await supabaseAdmin
            .from('subscriptions')
            .select('*')
            .eq('dodo_session_id', sessionId)
            .eq('status', 'pending')
            .single();
        console.log('[Payment Recovery] Loaded pending subscription by dodo_session_id:', { sessionId, subscription, error });
        if (error || !subscription) {
            throw new Error(`Could not find a pending internal subscription record for session '${sessionId}'.`);
        }

        // Choose permanent reference without relying on mode
        let referenceId: string | null = null;
        if (dodoSession.payment_id || dodoSession.payment_intent) {
            referenceId = dodoSession.payment_id || dodoSession.payment_intent; // one-time
        } else if (dodoSession.subscription_id) {
            referenceId = dodoSession.subscription_id; // subscription
        }
        if (!referenceId) {
            throw new Error('Recovery failed: Could not determine a permanent reference (payment_id/payment_intent/subscription_id).');
        }

        console.log('[Payment Recovery] Prepared activation payload:', {
            selectedReferenceId: referenceId,
            plan_name: subscription.plan_name,
            dodo_session_id: subscription.dodo_session_id,
            existing_dodo_subscription_id: subscription.dodo_subscription_id,
        });
        const subToActivate = { ...subscription, dodo_subscription_id: referenceId };
        
        await activatePlanAndUpdateUser(subscription.user_id, subToActivate);
        
        return res.json({ success: true, message: 'Payment recovered and plan updated.' });

    } catch (err: any) {
        console.error('[Payment Recovery] Error:', err);
        res.status(500).json({ error: `An unexpected error occurred during payment recovery: ${err.message}` });
    }
};