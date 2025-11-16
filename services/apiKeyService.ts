import { User } from '@supabase/supabase-js';
import { canUserGenerate } from '../userUtils';
import { getCachedConfig } from '../controllers/adminController';

interface ApiKeyOptions {
  checkLimits?: boolean;
}

/**
 * Determines the correct Gemini API key to use for a request based on user plan and provided keys.
 * This is the single source of truth for API key selection logic.
 * @param user The authenticated Supabase User object.
 * @param userProvidedKey An API key provided in the request body (e.g., from frontend localStorage).
 * @param options Configuration for the key retrieval, e.g., whether to check usage limits.
 * @returns The API key to be used for the Gemini request.
 * @throws An error if generation is not allowed or if no key can be found.
 */
export const getApiKeyForRequest = async (user: User, userProvidedKey?: string, options: ApiKeyOptions = { checkLimits: true }): Promise<string> => {
    // Priority 1: A key explicitly provided in the request body always takes precedence.
    // This is used for both Pro users with their own key and free users who've hit a quota and provide a temporary key.
    if (userProvidedKey) {
        return userProvidedKey;
    }

    const plan = user.user_metadata?.plan || 'free';

    // Priority 2: Pro/Business users who have NOT provided a key get seamless access to the shared app key.
    if (['pro', 'business'].includes(plan)) {
        const config = await getCachedConfig();
        const sharedKey = config.gemini_api_key;
        if (!sharedKey) {
            throw new Error('The application is not configured with a shared API key. Please contact support.');
        }
        return sharedKey;
    }

    // Priority 3: Free/Hobbyist users on the shared key, subject to a pre-check.
    if (options.checkLimits) {
        const { allowed, error: limitError, generationBalance } = await canUserGenerate(user);
        if (!allowed) {
            // Throw a custom error object that includes the current generation balance.
            // This allows the controller to send this data back to the frontend for UI synchronization.
            const error = new Error(limitError);
            (error as any).generationBalance = generationBalance;
            throw error;
        }
    }

    const config = await getCachedConfig();
    const sharedKey = config.gemini_api_key;
    if (!sharedKey) {
        throw new Error('The application is not configured with a shared API key. Please contact support.');
    }
    return sharedKey;
};
