import { supabaseAdmin } from './supabaseClient';
import { HOBBYIST_GENERATION_LIMIT } from './userUtils';


export const FREE_GENERATION_LIMIT = 10;
/**
 * Activates a subscription plan and updates the user's primary plan metadata
 * in a single, robust database transaction to prevent race conditions.
 * @param userId The ID of the user to update.
 * @param subscription The subscription object from our database to activate.
 */
export const activatePlanAndUpdateUser = async (userId: string, subscription: any) => {
    console.log('[Activation] Starting activation with parameters:', {
        userId,
        sub_id: subscription?.id,
        plan_name: subscription?.plan_name,
        status: subscription?.status,
        dodo_session_id: subscription?.dodo_session_id,
        dodo_subscription_id_incoming: subscription?.dodo_subscription_id,
    });

    // 0. Load the latest subscription row to enforce idempotency and detect conflicts.
    const { data: currentSub, error: loadErr } = await supabaseAdmin
        .from('subscriptions')
        .select('*')
        .eq('id', subscription.id)
        .single();

    if (loadErr || !currentSub) {
        console.error(`[Activation] Failed to load current subscription ${subscription.id}:`, loadErr);
        throw loadErr || new Error('Subscription not found');
    }

    // Idempotency: if already active with the same reference, no-op.
    if (currentSub.status === 'active' && currentSub.dodo_subscription_id && subscription.dodo_subscription_id && currentSub.dodo_subscription_id === subscription.dodo_subscription_id) {
        console.log('[Activation] No-op: subscription already active with same reference. Skipping user metadata update.');
        return;
    }

    // Conflict: already active but with DIFFERENT reference id -> do not modify credits again.
    if (currentSub.status === 'active' && currentSub.dodo_subscription_id && subscription.dodo_subscription_id && currentSub.dodo_subscription_id !== subscription.dodo_subscription_id) {
        console.error('[Activation] CONFLICT: subscription already active with a different reference id.', {
            existing_ref: currentSub.dodo_subscription_id,
            incoming_ref: subscription.dodo_subscription_id,
            sub_id: subscription.id,
            userId,
        });
        // We keep the DB as-is to avoid corruption. Surface error for investigation.
        throw new Error('Activation conflict: subscription already active with a different reference id');
    }

    // 1. Transition to active and record reference id only if not already active.
    const { error: updateSubError } = await supabaseAdmin
        .from('subscriptions')
        .update({ status: 'active', dodo_subscription_id: subscription.dodo_subscription_id || currentSub.dodo_subscription_id || null })
        .eq('id', subscription.id);
    
    if (updateSubError) {
        console.error(`[DB Update] Failed to activate subscription ${subscription.id}:`, updateSubError);
        throw updateSubError;
    }
    console.log(`[DB Update] Activated subscription ${subscription.id} for user ${userId}. Writing dodo_subscription_id:`, subscription.dodo_subscription_id || currentSub.dodo_subscription_id);

    // 2. Fetch the user's most recent metadata and other active plans in one go.
    const [
        { data: { user: currentUserData }, error: userError },
        { data: otherActiveSubs, error: subsError }
    ] = await Promise.all([
        supabaseAdmin.auth.admin.getUserById(userId),
        supabaseAdmin.from('subscriptions').select('plan_name').eq('user_id', userId).eq('status', 'active').neq('id', subscription.id)
    ]);

    console.log('[Activation] Retrieved current user and other active subs:', {
        userError,
        subsError,
        otherActiveSubs,
        currentUserMetadata: currentUserData?.user_metadata,
    });

    if (userError || subsError) {
        console.error(`[DB Update] Error fetching user data or other subs for user ${userId}:`, userError || subsError);
        // Don't throw, proceed with what we have but log the error. The primary sub is already active.
    }
    
    // 3. Determine the new primary plan based on all active subscriptions.
    const allActivePlans = [...(otherActiveSubs || []), { plan_name: subscription.plan_name }];
    let newPrimaryPlan = 'free';
    if (allActivePlans.some(p => p.plan_name === 'pro')) {
        newPrimaryPlan = 'pro';
    } else if (allActivePlans.some(p => p.plan_name === 'hobbyist')) {
        newPrimaryPlan = 'hobbyist';
    }

    // 4. Prepare new metadata based on the new logic.
    const newMetadata: any = { ...currentUserData?.user_metadata, plan: newPrimaryPlan };
    
    // Only grant hobbyist credits if we are activating from a non-active state (avoid duplicates on retries)
    const wasActive = currentSub.status === 'active';
    if (subscription.plan_name === 'hobbyist' && !wasActive) {
        const currentBalance = currentUserData?.user_metadata?.generation_balance ?? 0;
        newMetadata.generation_balance = currentBalance + HOBBYIST_GENERATION_LIMIT;
    } else if (subscription.plan_name === 'pro') {
        // For Pro, the balance is irrelevant. We can remove it for cleanliness.
        delete newMetadata.generation_balance;
    }

    console.log('[Activation] Updating user metadata with:', newMetadata);
    
    // 5. Update the user metadata.
    const { data: updateResp, error: updateUserError } = await supabaseAdmin.auth.admin.updateUserById(
        userId,
        { user_metadata: newMetadata }
    );

    if (updateUserError) {
        console.error(`[DB Update] Failed to update user metadata for ${userId}:`, updateUserError);
        throw updateUserError;
    }
    
    console.log(`[DB Update] Successfully updated user ${userId} metadata. Response:`, updateResp);
};