import * as express from 'express';
import * as jwt from 'jsonwebtoken';
import { supabaseAdmin } from '../supabaseClient';
import { User } from '@supabase/supabase-js';

const CONFIG_TABLE = '_app_config';

interface AppConfig {
    gemini_api_key: string | null;
    ai_provider_config: string | null;
    dodo_secret_key: string | null;
    dodo_webhook_secret: string | null;
    site_url: string | null;
    dodo_hobbyist_product_id: string | null;
    dodo_pro_product_id: string | null;
}

// In-memory cache for the config object to reduce DB lookups.
let cachedConfig: AppConfig | null = null;
let cacheLastUpdated = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Fetches all configuration keys from the database.
 * @returns An object with key-value pairs.
 */
const fetchConfigFromDatabase = async (): Promise<Partial<AppConfig>> => {
    const { data, error } = await supabaseAdmin
        .from(CONFIG_TABLE)
        .select('key, value');

    if (error) {
        console.error('Error fetching config from database:', error);
        // Don't throw, just return empty. The system should fall back to .env
        return {};
    }

    // Add a check for null data to prevent crashes if the table exists but is empty
    // or if the query unexpectedly returns null.
    if (!data) {
        return {};
    }

    return data.reduce((acc, { key, value }) => {
        acc[key as keyof AppConfig] = value;
        return acc;
    }, {} as Partial<AppConfig>);
};

/**
 * Gets the cached config, refreshing from the database if stale, and merges with env fallbacks.
 * Crucially, it overrides Dodo credentials with test variables if DODO_MODE is 'test'.
 * @returns The full application configuration.
 */
export const getCachedConfig = async (): Promise<AppConfig> => {
    const now = Date.now();
    const isTestMode = process.env.DODO_MODE === 'test';

    // If in test mode, we completely ignore database values for Dodo keys and ONLY use test .env variables.
    // This is the primary fix for the 401 error by preventing cached live keys from being used.
    if (isTestMode) {
        // Even if we have a cache, we must ensure it's using the test values.
        // It's safer to rebuild it if it's stale or apply overrides.
        if (!cachedConfig || (now - cacheLastUpdated > CACHE_TTL)) {
            console.log('[Config Cache] Dodo Test Mode ACTIVE. Refreshing cache and applying TEST overrides.');
            const dbConfig = await fetchConfigFromDatabase();
            cachedConfig = {
                ai_provider_config: dbConfig.ai_provider_config || '{}',
                gemini_api_key: dbConfig.gemini_api_key || process.env.VITE_API_KEY || null,
                site_url: dbConfig.site_url || process.env.SITE_URL || null,
                // --- DODO TEST OVERRIDES ---
                dodo_secret_key: process.env.DODO_SECRET_KEY_TEST || null,
                dodo_webhook_secret: process.env.DODO_WEBHOOK_SECRET_TEST || null,
                dodo_hobbyist_product_id: process.env.VITE_DODO_HOBBYIST_PRODUCT_ID_TEST || null,
                dodo_pro_product_id: process.env.VITE_DODO_PRO_PRODUCT_ID_TEST || null,
            };
            cacheLastUpdated = now;
        } else {
            // Apply overrides to the existing cache to ensure it's in a test state.
            cachedConfig.dodo_secret_key = process.env.DODO_SECRET_KEY_TEST || null;
            cachedConfig.dodo_webhook_secret = process.env.DODO_WEBHOOK_SECRET_TEST || null;
            cachedConfig.dodo_hobbyist_product_id = process.env.VITE_DODO_HOBBYIST_PRODUCT_ID_TEST || null;
            cachedConfig.dodo_pro_product_id = process.env.VITE_DODO_PRO_PRODUCT_ID_TEST || null;
        }
        return cachedConfig;
    }

    // --- Original Live Mode Logic ---
    if (!cachedConfig || (now - cacheLastUpdated > CACHE_TTL)) {
        console.log('[Config Cache] Cache stale or empty, refreshing from database for LIVE mode...');
        const dbConfig = await fetchConfigFromDatabase();
        
        cachedConfig = {
            ai_provider_config: dbConfig.ai_provider_config || '{}',
            gemini_api_key: dbConfig.gemini_api_key || process.env.VITE_API_KEY || null,
            dodo_secret_key: dbConfig.dodo_secret_key || process.env.DODO_SECRET_KEY || null,
            dodo_webhook_secret: dbConfig.dodo_webhook_secret || process.env.DODO_WEBHOOK_SECRET || null,
            site_url: dbConfig.site_url || process.env.SITE_URL || null,
            dodo_hobbyist_product_id: dbConfig.dodo_hobbyist_product_id || process.env.VITE_DODO_HOBBYIST_PRODUCT_ID || null,
            dodo_pro_product_id: dbConfig.dodo_pro_product_id || process.env.VITE_DODO_PRO_PRODUCT_ID || null,
        };
        cacheLastUpdated = now;
    }
    return cachedConfig;
};


/**
 * Clears the in-memory cache for the config.
 */
export const clearConfigCache = () => {
    console.log('[Config Cache] Clearing cache.');
    cachedConfig = null;
    cacheLastUpdated = 0;
};

// --- CONTROLLER FUNCTIONS ---

export const handleAdminLogin = (req: express.Request, res: express.Response) => {
    const { email, password } = req.body;
    const adminEmail = process.env.ADMIN_EMAIL;
    const adminPassword = process.env.ADMIN_PASSWORD;
    const jwtSecret = process.env.JWT_SECRET;

    if (!adminEmail || !adminPassword || !jwtSecret) {
        return res.status(500).json({ error: "Admin authentication is not configured on the server." });
    }

    if (email === adminEmail && password === adminPassword) {
        // Credentials are correct, issue a JWT
        const token = jwt.sign({ role: 'admin' }, jwtSecret, { expiresIn: '8h' });
        return res.json({ token });
    } else {
        // Invalid credentials
        return res.status(401).json({ error: "Invalid email or password." });
    }
};

export const handleAdminLogout = (req: express.Request, res: express.Response) => {
    // On the server, logout is a stateless action. We can just confirm it.
    // The client will be responsible for clearing the token.
    res.status(200).json({ message: "Logout successful." });
};


/**
 * Controller to get the current configuration for the admin panel.
 */
export const getAdminConfig = async (req: express.Request, res: express.Response) => {
    try {
        const config = await getCachedConfig();
        // Return the actual values to the admin panel for editing
        res.json(config);
    } catch (error) {
        console.error('Error in getAdminConfig controller:', error);
        res.status(500).json({ error: 'Failed to retrieve application configuration.' });
    }
};

/**
 * Controller to update the configuration in the database.
 */
export const updateAdminConfig = async (req: express.Request, res: express.Response) => {
    const { config } = req.body;
    if (!config || typeof config !== 'object') {
        return res.status(400).json({ error: 'A valid configuration object must be provided.' });
    }

    try {
        const recordsToUpsert = Object.entries(config)
            .filter(([_, value]) => typeof value === 'string') // Ensure only string values are saved
            .map(([key, value]) => ({ key, value }));

        if (recordsToUpsert.length === 0) {
            return res.status(400).json({ error: 'No valid configuration values to update.' });
        }

        const { error } = await supabaseAdmin
            .from(CONFIG_TABLE)
            .upsert(recordsToUpsert, { onConflict: 'key' });

        if (error) {
            throw error;
        }

        // Invalidate and update the cache immediately
        clearConfigCache();
        await getCachedConfig();

        res.status(200).json({ message: 'Configuration updated successfully.' });
    } catch (error: any) {
        console.error('Error updating configuration in database:', error);
        // Pass the specific database error back to the client for better debugging.
        const detail = error.details || error.message || 'An unknown database error occurred.';
        res.status(500).json({ error: `Failed to update the configuration. Database error: ${detail}` });
    }
};

/**
 * Controller to get a list of users and their payment history for the admin panel.
 */
export const getAdminUsers = async (req: express.Request, res: express.Response) => {
    const { email } = req.query;

    try {
        // 1. Fetch all users from Supabase Auth
        const { data: { users }, error: usersError } = await supabaseAdmin.auth.admin.listUsers();
        if (usersError) throw usersError;

        // 2. Filter users by email if a search term is provided
        const filteredUsers = email
            ? users.filter((u: User) => u.email?.toLowerCase().includes((email as string).toLowerCase()))
            : users;

        // 3. Get all subscriptions from our public table
        const { data: subscriptions, error: subsError } = await supabaseAdmin
            .from('subscriptions')
            .select('*');
        if (subsError) throw subsError;

        // 4. Map subscriptions to users for efficient lookup
        const subscriptionsByUserId = (subscriptions || []).reduce((acc, sub) => {
            if (!acc[sub.user_id]) {
                acc[sub.user_id] = [];
            }
            acc[sub.user_id].push(sub);
            return acc;
        }, {} as Record<string, any[]>);

        // 5. Combine the data into a single response payload with improved logic
        const responsePayload = filteredUsers.map(user => {
            const userSubscriptions = subscriptionsByUserId[user.id] || [];
            userSubscriptions.sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

            // Find the latest active subscription to determine the "true" current plan
            const activeSub = userSubscriptions.find((sub: any) => sub.status === 'active');
            
            // The displayed plan prioritizes an active subscription, then falls back to metadata.
            const displayPlan = activeSub?.plan_name || user.user_metadata?.plan || 'free';
            
            // The status should reflect the most recent activity, even if it's not active (e.g., 'pending').
            const displayStatus = userSubscriptions[0]?.status || 'n/a';

            return {
                id: user.id,
                email: user.email,
                currentPlan: displayPlan,
                currentStatus: displayStatus,
                createdAt: user.created_at,
                subscriptions: userSubscriptions,
            };
        });
        
        // Sort the final payload by user creation date
        responsePayload.sort((a,b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

        res.json(responsePayload);

    } catch (error: any) {
        console.error('Error fetching admin user data:', error);
        res.status(500).json({ error: 'Failed to retrieve user data.' });
    }
};

export const handleAdminUpdateUserPlan = async (req: express.Request, res: express.Response) => {
    const { userId } = req.params;
    const { newPlan } = req.body;

    if (!userId || !newPlan) {
        return res.status(400).json({ error: 'User ID and new plan are required.' });
    }

    if (!['free', 'hobbyist', 'pro'].includes(newPlan)) {
        return res.status(400).json({ error: 'Invalid plan specified.' });
    }

    try {
        const { data: { user }, error: getUserError } = await supabaseAdmin.auth.admin.getUserById(userId);
        if (getUserError || !user) throw getUserError || new Error('User not found.');

        const newMetadata: any = { ...user.user_metadata, plan: newPlan };
        if (newPlan === 'hobbyist' || newPlan === 'free') {
            newMetadata.generation_count = 0;
        }
        
        // Step 1: Update user metadata to grant immediate permissions
        const { error: updateUserError } = await supabaseAdmin.auth.admin.updateUserById(userId, { user_metadata: newMetadata });
        if (updateUserError) throw updateUserError;

        // Step 2: Synchronize the subscriptions table to reflect the override for consistency
        if (newPlan === 'pro' || newPlan === 'hobbyist') {
            const { data: pendingSub } = await supabaseAdmin
                .from('subscriptions')
                .select('id')
                .eq('user_id', userId)
                .eq('plan_name', newPlan)
                .eq('status', 'pending')
                .order('created_at', { ascending: false })
                .limit(1)
                .single();

            if (pendingSub) {
                await supabaseAdmin.from('subscriptions').update({ status: 'active', dodo_subscription_id: `admin_override_${new Date().toISOString()}` }).eq('id', pendingSub.id);
                console.log(`[Admin] Activated pending sub ${pendingSub.id} for user ${userId}.`);
            } else {
                await supabaseAdmin.from('subscriptions').insert({ user_id: userId, plan_name: newPlan, status: 'active', dodo_subscription_id: `admin_override_${new Date().toISOString()}` });
                console.log(`[Admin] Created override subscription for user ${userId} with plan '${newPlan}'.`);
            }
        } else if (newPlan === 'free') {
            await supabaseAdmin.from('subscriptions').update({ status: 'cancelled' }).eq('user_id', userId).eq('status', 'active');
            console.log(`[Admin] Cancelled all active subscriptions for user ${userId}.`);
        }

        console.log(`[Admin] User ${userId} plan manually updated to '${newPlan}'.`);
        res.status(200).json({ 
            message: `User plan successfully updated to ${newPlan}.`,
            requiresRefresh: true  // Signal to frontend that user session needs refresh
        });

    } catch (error: any) {
        console.error(`[Admin] Error updating user plan for ${userId}:`, error);
        res.status(500).json({ error: `Failed to update user plan: ${error.message}` });
    }
};

