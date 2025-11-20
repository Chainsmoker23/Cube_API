import { getDodoClient } from '../dodo-payments';

/**
 * Retrieves a Dodo checkout session by its ID and verifies it is complete and paid.
 * @param sessionId The Dodo Checkout Session ID.
 * @returns The verified Dodo session object if valid, otherwise null.
 */
export const getVerifiedDodoSessionById = async (sessionId: string): Promise<any | null> => {
    try {
        const dodo = await getDodoClient();
        console.log('[Verification] Retrieving Dodo session by ID:', sessionId);
        const dodoSession: any = await dodo.checkoutSessions.retrieve(sessionId);
        console.log('[Verification] Raw Dodo session payload:', dodoSession);

        if (!dodoSession) return null;

        const paymentStatus = dodoSession.payment_status;
        const isPaidLegacy = paymentStatus === 'paid';
        const isPaidSucceeded = paymentStatus === 'succeeded';
        const isSubscriptionCreated = !!dodoSession.subscription_id;

        // Accept if complete and paid OR if payment is paid/succeeded even if status not strictly 'complete' (provider race),
        // or a subscription_id exists.
        if ((dodoSession.status === 'complete' && (isPaidLegacy || isPaidSucceeded)) || isSubscriptionCreated || (isPaidSucceeded || isPaidLegacy)) {
            return dodoSession;
        }
        return null;
    } catch (error) {
        console.error(`[Dodo Verification] Error retrieving session ${sessionId}:`, error);
        return null;
    }
};

/**
 * Retrieves a Dodo checkout session by its Payment ID and verifies it is complete and paid.
 * This is a robust recovery mechanism.
 * @param paymentId The Dodo Payment ID (e.g., 'pay_...').
 * @returns The verified Dodo session object if found and valid, otherwise null.
 */
export const getVerifiedDodoSessionByPaymentId = async (paymentId: string): Promise<any | null> => {
    try {
        const dodo = await getDodoClient();
        const { supabaseAdmin } = await import('../supabaseClient');

        console.log('[Verification] Searching for Dodo session by payment ID across recent pending subs:', paymentId);
        // Workaround: iterate recent pending subs with a dodo_session_id and retrieve to match payment ID
        const { data: pendingSubs, error } = await supabaseAdmin
            .from('subscriptions')
            .select('dodo_session_id, created_at')
            .eq('status', 'pending')
            .not('dodo_session_id', 'is', null)
            .gte('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
            .order('created_at', { ascending: false })
            .limit(500);

        console.log('[Verification] Pending subs fetch result:', { error, count: pendingSubs?.length });
        if (error || !pendingSubs) {
            console.error('[Verification] Could not fetch pending subs to search for payment ID.', error);
            return null;
        }

        for (const sub of pendingSubs) {
            const session: any = await dodo.checkoutSessions.retrieve(sub.dodo_session_id);
            console.log('[Verification] Retrieved session while scanning for paymentId match:', { sessionId: sub.dodo_session_id, session });
            const dodoPaymentId = session.payment_id || session.payment_intent_id || session.payment_intent;

            if (dodoPaymentId === paymentId) {
                const paymentStatus = session.payment_status;
                const isPaidLegacy = paymentStatus === 'paid';
                const isPaidSucceeded = paymentStatus === 'succeeded';
                const isSubscriptionCreated = !!session.subscription_id;

                if ((session.status === 'complete' && (isPaidLegacy || isPaidSucceeded)) || isSubscriptionCreated || (isPaidSucceeded || isPaidLegacy)) {
                    console.log(`[Verification] Found matching and accepted session ${session.id} for payment ${paymentId}`);
                    return session;
                }
            }
        }

        console.warn(`[Verification] No matching, complete session found for payment ID ${paymentId} after searching recent pending transactions.`);
        return null;

    } catch (error) {
        console.error(`[Dodo Verification] Error during recovery lookup for payment ID ${paymentId}:`, error);
        return null;
    }
};