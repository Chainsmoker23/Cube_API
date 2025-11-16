import * as express from 'express';
import { supabaseAdmin } from '../supabaseClient';
import { User } from '@supabase/supabase-js';

// Extend the Express Request type to include our user property
declare global {
    namespace Express {
        interface Request {
            user?: User;
        }
    }
}

export const apiKeyAuth = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized: Missing or malformed API key. Expected "Bearer <YOUR_KEY>".' });
    }
    
    const apiKey = authHeader.split(' ')[1];

    try {
        // Find the user whose app_metadata contains the personal_api_key
        const { data: { users }, error: findError } = await supabaseAdmin.auth.admin.listUsers();
        if (findError) throw findError;

        const targetUser = users.find((u: User) => u.app_metadata?.personal_api_key === apiKey);

        if (!targetUser) {
            return res.status(401).json({ error: 'Unauthorized: Invalid API key.' });
        }

        const plan = targetUser.user_metadata?.plan || 'free';
        if (!['pro', 'business'].includes(plan)) {
            return res.status(403).json({ error: 'Forbidden: This API key is not associated with a Pro or Business plan.' });
        }

        // Attach user to the request object for use in controllers
        req.user = targetUser;
        next();

    } catch (e) {
        console.error("[API Key Auth] Unhandled exception in middleware:", e);
        return res.status(500).json({ error: "Internal server error during authentication." });
    }
};