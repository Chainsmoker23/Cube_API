import * as express from 'express';
import { User } from '@supabase/supabase-js';
import { supabaseAdmin } from './supabaseClient';

export const FREE_GENERATION_LIMIT = 30;
export const HOBBYIST_GENERATION_LIMIT = 50;

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
export const canUserGenerate = async (user: User): Promise<{ allowed: boolean; error?: string, generationCount: number }> => {
    // 1. Check for an active subscription in the new `subscriptions` table. This is the highest priority.
    const { data: activeSubscription, error: subError } = await supabaseAdmin
        .from('subscriptions')
        .select('id, status')
        .eq('user_id', user.id)
        .eq('status', 'active')
        .maybeSingle();

    if (subError) {
        console.error(`[Permissions] Database error while checking subscriptions for user ${user.id}:`, subError);
        throw new Error('Could not verify user subscription status.');
    }
    
    // If an active subscription exists, they have unlimited generations.
    if (activeSubscription) {
        return { allowed: true, generationCount: user.user_metadata?.generation_count || 0 };
    }

    // 2. If no active subscription, fall back to checking free/hobbyist generation counts.
    // This requires fetching the latest user data to prevent stale metadata issues.
    const { data: { user: freshUser }, error: fetchError } = await supabaseAdmin.auth.admin.getUserById(user.id);
    if (fetchError || !freshUser) {
        console.error(`[Permissions] Failed to re-fetch user ${user.id} before checking limits:`, fetchError);
        throw new Error('Could not verify user generation status.');
    }

    const plan = freshUser.user_metadata?.plan || 'free';
    const generationCount = freshUser.user_metadata?.generation_count || 0;
    
    // "Pro" should have been caught by the subscription check, but as a safeguard:
    if (plan === 'pro') {
        console.warn(`[Permissions] User ${user.id} has plan '${plan}' but no active subscription record was found. Granting access as a safeguard.`);
        return { allowed: true, generationCount };
    }

    const limit = plan === 'hobbyist' ? HOBBYIST_GENERATION_LIMIT : FREE_GENERATION_LIMIT;

    if (generationCount >= limit) {
        return { allowed: false, error: 'GENERATION_LIMIT_EXCEEDED', generationCount };
    }
    
    return { allowed: true, generationCount };
};


/**
 * Increments the generation count for a non-premium user.
 * @param user The authenticated Supabase User object.
 * @returns The new generation count, or null if the user is premium.
 */
export const incrementGenerationCount = async (user: User): Promise<number | null> => {
    // Re-check for an active subscription before incrementing.
    const { data: activeSubscription } = await supabaseAdmin
        .from('subscriptions')
        .select('id')
        .eq('user_id', user.id)
        .eq('status', 'active')
        .maybeSingle();
        
    if (activeSubscription) {
        return null; // Premium users don't have their count incremented.
    }
    
    // Re-fetch the user directly from the database to ensure we have the latest metadata.
    const { data: { user: freshUser }, error: fetchError } = await supabaseAdmin.auth.admin.getUserById(user.id);

    if (fetchError || !freshUser) {
        console.error(`[Backend] Failed to re-fetch user ${user.id} before incrementing count:`, fetchError);
        throw new Error('Could not verify user generation status before incrementing.');
    }
    
    const generationCount = freshUser.user_metadata?.generation_count || 0;
    const newCount = generationCount + 1;
    
    const { error } = await supabaseAdmin.auth.admin.updateUserById(freshUser.id, {
        user_metadata: { ...freshUser.user_metadata, generation_count: newCount }
    });

    if (error) {
        console.error(`[Backend] Failed to update generation count for user ${freshUser.id}:`, error);
        throw new Error('Failed to update user generation count.');
    }

    console.log(`[Backend] User ${freshUser.id} generation count updated to ${newCount}.`);
    return newCount;
};