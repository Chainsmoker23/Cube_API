import DodoPayments from 'dodopayments';
import { getCachedConfig } from './controllers/adminController';

let dodoClientInstance: DodoPayments | null = null;
let lastUsedSecretKey: string | null = null;

/**
 * Asynchronously gets the initialized Dodo Payments client.
 * Re-initializes the client if the secret key has changed.
 */
export const getDodoClient = async (): Promise<DodoPayments> => {
    const config = await getCachedConfig();
    const secretKey = config.dodo_secret_key;

    if (!secretKey) {
        throw new Error('Dodo Payments secret key is not configured on the server.');
    }

    // Re-use existing client if the key is the same, preventing unnecessary re-initializations.
    if (dodoClientInstance && lastUsedSecretKey === secretKey) {
        return dodoClientInstance;
    }

    try {
        // Create a new client instance because the key is new or different.
        dodoClientInstance = new DodoPayments({ bearerToken: secretKey });
        lastUsedSecretKey = secretKey;
        const mode = process.env.DODO_MODE === 'test' ? 'TEST' : 'LIVE';
        console.log(`[Dodo Client] Dodo Payments client initialized/re-initialized in ${mode} mode.`);
        return dodoClientInstance;

    } catch (error) {
        console.error('[Dodo Client] Failed to initialize Dodo Payments client:', error);
        // Clear instance and key on failure to allow a clean retry on the next call.
        dodoClientInstance = null;
        lastUsedSecretKey = null;
        throw new Error('Could not initialize payment client.');
    }
};
