import * as express from 'express';
import { User } from '@supabase/supabase-js';
import { supabaseAdmin } from './supabaseClient';

export const FREE_GENERATION_LIMIT = 3;
export const HOBBYIST_GENERATION_LIMIT = 20;

/**
 * Authenticates a user based on the Authorization header.
 * @param req The Express request object.
 * @returns The authenticated Supabase User object or null.
 */
// FIX: Use consistent express namespace for Request type.
export const authenticateUser = async (req: express.Request): Promise<User | null> => {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return null;
    }
    const token = authHeader.split(' ')[1];
    try {
        const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
        if (error || !user) {
            return null;
        }
        return user;
    } catch (e) {
        console.error("Error during user authentication:", e);
        return null;
    }
};

/**
 * Checks if a user can generate content based on their plan and usage, without modifying their count.
 * This is now the source of truth for permissions.
 * @param user The authenticated Supabase User object.
 * @returns An object indicating if the generation is allowed and the user's current count.
 */
export const canUserGenerate = async (user: User): Promise<{ allowed: boolean; error?: string, generationBalance: number }> => {
    // 1. Check for an active subscription in the new `subscriptions` table. This is the highest priority.
    const { data: activeSubscription, error: subError } = await supabaseAdmin
        .from('subscriptions')
        .select('id, plan_name, period_ends_at')
        .eq('user_id', user.id)
        .eq('status', 'active')
        .maybeSingle();

    if (subError) {
        console.error(`[Permissions] Database error while checking subscriptions for user ${user.id}:`, subError);
        throw new Error('Could not verify user subscription status.');
    }

    // If an active subscription is 'pro', check if it's expired
    if (activeSubscription && activeSubscription.plan_name === 'pro') {
        // Check if period_ends_at has passed
        if (activeSubscription.period_ends_at) {
            const expiryDate = new Date(activeSubscription.period_ends_at);
            const now = new Date();

            if (now > expiryDate) {
                // Subscription has expired - update status to 'expired' and fall through to credit check
                console.log(`[Permissions] Pro subscription ${activeSubscription.id} for user ${user.id} has expired (period_ends_at: ${activeSubscription.period_ends_at}). Marking as expired.`);
                await supabaseAdmin
                    .from('subscriptions')
                    .update({ status: 'expired' })
                    .eq('id', activeSubscription.id);
                // Don't return - fall through to check free/hobbyist balance
            } else {
                // Still valid - has Pro access
                return { allowed: true, generationBalance: Infinity };
            }
        } else {
            // No period_ends_at set - grant access but log a warning
            console.warn(`[Permissions] Pro subscription ${activeSubscription.id} has no period_ends_at set. Granting access anyway.`);
            return { allowed: true, generationBalance: Infinity };
        }
    }

    // 2. If not a pro sub, fall back to checking free/hobbyist generation balance.
    // This requires fetching the latest user data to prevent stale metadata issues.
    const { data: { user: freshUser }, error: fetchError } = await supabaseAdmin.auth.admin.getUserById(user.id);
    if (fetchError || !freshUser) {
        console.error(`[Permissions] Failed to re-fetch user ${user.id} before checking limits:`, fetchError);
        throw new Error('Could not verify user generation status.');
    }

    const plan = freshUser.user_metadata?.plan || 'free';

    // Handle the case of a new free user who doesn't have a balance yet.
    const generationBalance = freshUser.user_metadata?.generation_balance ?? (plan === 'free' ? FREE_GENERATION_LIMIT : 0);

    if (generationBalance <= 0) {
        return { allowed: false, error: 'GENERATION_LIMIT_EXCEEDED', generationBalance };
    }

    return { allowed: true, generationBalance };
};


/**
 * Decrements the generation balance for a non-premium user.
 * @param user The authenticated Supabase User object.
 * @returns The new generation balance.
 */
export const consumeGenerationCredit = async (user: User): Promise<number | null> => {
    // Re-check for an active subscription before decrementing.
    const { data: activeSubscription } = await supabaseAdmin
        .from('subscriptions')
        .select('id, plan_name')
        .eq('user_id', user.id)
        .eq('status', 'active')
        .maybeSingle();

    if (activeSubscription && activeSubscription.plan_name === 'pro') {
        return null; // Pro users don't consume credits.
    }

    // Re-fetch the user directly from the database to ensure we have the latest metadata.
    const { data: { user: freshUser }, error: fetchError } = await supabaseAdmin.auth.admin.getUserById(user.id);

    if (fetchError || !freshUser) {
        console.error(`[Backend] Failed to re-fetch user ${user.id} before consuming credit:`, fetchError);
        throw new Error('Could not verify user generation status before consuming credit.');
    }

    const plan = freshUser.user_metadata?.plan || 'free';
    const currentBalance = freshUser.user_metadata?.generation_balance ?? (plan === 'free' ? FREE_GENERATION_LIMIT : 0);
    const newBalance = Math.max(0, currentBalance - 1);

    const { error } = await supabaseAdmin.auth.admin.updateUserById(freshUser.id, {
        user_metadata: { ...freshUser.user_metadata, generation_balance: newBalance }
    });

    if (error) {
        console.error(`[Backend] Failed to update generation balance for user ${freshUser.id}:`, error);
        throw new Error('Failed to update user generation balance.');
    }

    console.log(`[Backend] User ${freshUser.id} generation balance updated to ${newBalance}.`);
    return newBalance;
};
