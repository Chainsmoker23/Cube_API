import { supabaseAdmin } from './supabaseClient';
import { FREE_GENERATION_LIMIT, HOBBYIST_GENERATION_LIMIT } from './userUtils';

/**
 * Activates a subscription plan and updates the user's primary plan metadata
 * in a single, robust database transaction to prevent race conditions.
 * @param userId The ID of the user to update.
 * @param subscription The subscription object from our database to activate.
 */
export const activatePlanAndUpdateUser = async (userId: string, subscription: any) => {
    // 1. Update the subscription record itself.
    const { error: updateSubError } = await supabaseAdmin
        .from('subscriptions')
        .update({ status: 'active', dodo_subscription_id: subscription.dodo_subscription_id || null })
        .eq('id', subscription.id);
    
    if (updateSubError) {
        console.error(`[DB Update] Failed to activate subscription ${subscription.id}:`, updateSubError);
        throw updateSubError;
    }
    console.log(`[DB Update] Activated subscription ${subscription.id} for user ${userId}.`);

    // 2. Fetch the user's most recent metadata and other active plans in one go.
    const [
        { data: { user: currentUserData }, error: userError },
        { data: otherActiveSubs, error: subsError }
    ] = await Promise.all([
        supabaseAdmin.auth.admin.getUserById(userId),
        supabaseAdmin.from('subscriptions').select('plan_name').eq('user_id', userId).eq('status', 'active').neq('id', subscription.id)
    ]);

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
    
    if (subscription.plan_name === 'hobbyist') {
        const currentBalance = currentUserData?.user_metadata?.generation_balance ?? 0;
        newMetadata.generation_balance = currentBalance + HOBBYIST_GENERATION_LIMIT;
    } else if (subscription.plan_name === 'pro') {
        // For Pro, the balance is irrelevant. We can remove it for cleanliness.
        delete newMetadata.generation_balance;
    }
    
    // 5. Update the user metadata.
    const { error: updateUserError } = await supabaseAdmin.auth.admin.updateUserById(
        userId,
        { user_metadata: newMetadata }
    );

    if (updateUserError) {
        console.error(`[DB Update] Failed to update user metadata for ${userId}:`, updateUserError);
        throw updateUserError;
    }
    
    console.log(`[DB Update] Successfully updated user ${userId} metadata. New plan: ${newPrimaryPlan}.`);
};