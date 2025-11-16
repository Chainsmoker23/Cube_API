import * as express from 'express';
import { supabaseAdmin } from '../supabaseClient';
import { authenticateUser } from '../userUtils';
import { getDodoClient } from '../dodo-payments';
import crypto from 'crypto';

// --- HELPER FUNCTIONS ---
const handleError = (res: express.Response, error: unknown, defaultMessage: string = 'An unexpected error occurred.') => {
    const errorMessage = error instanceof Error ? error.message : defaultMessage;
    console.error(`[User Controller Error] ${errorMessage}`);
    return res.status(500).json({ error: errorMessage });
};

// --- USER API KEY MANAGEMENT ---

export const handleGetApiKey = async (req: express.Request, res: express.Response) => {
    const user = await authenticateUser(req);
    if (!user) {
        return res.status(401).json({ error: 'Unauthorized.' });
    }
    try {
        const apiKey = user.app_metadata?.personal_api_key || null;
        res.json({ apiKey });
    } catch (e) {
        handleError(res, e, 'Failed to retrieve API key.');
    }
};

export const handleGenerateApiKey = async (req: express.Request, res: express.Response) => {
    const user = await authenticateUser(req);
    if (!user) {
        return res.status(401).json({ error: 'Unauthorized.' });
    }

    const plan = user.user_metadata?.plan || 'free';
    if (!['pro', 'business'].includes(plan)) {
        return res.status(403).json({ error: 'Forbidden: API key generation is a premium feature.' });
    }

    try {
        const newKey = `cg_sk_${crypto.randomBytes(20).toString('hex')}`;
        
        const { data, error } = await supabaseAdmin.auth.admin.updateUserById(
            user.id,
            { app_metadata: { ...user.app_metadata, personal_api_key: newKey } }
        );

        if (error || !data.user) {
            throw error || new Error('Failed to update user with new key.');
        }

        res.status(201).json({ apiKey: newKey });
    } catch (e) {
        handleError(res, e, 'Failed to generate API key.');
    }
};

export const handleRevokeApiKey = async (req: express.Request, res: express.Response) => {
    const user = await authenticateUser(req);
    if (!user) {
        return res.status(401).json({ error: 'Unauthorized.' });
    }

    try {
        const { error } = await supabaseAdmin.auth.admin.updateUserById(
            user.id,
            { app_metadata: { ...user.app_metadata, personal_api_key: null } }
        );
        
        if (error) throw error;

        res.status(204).send(); // No content
    } catch (e) {
        handleError(res, e, 'Failed to revoke API key.');
    }
};


// --- USER PLAN & BILLING MANAGEMENT ---

export const handleGetActivePlans = async (req: express.Request, res: express.Response) => {
    const user = await authenticateUser(req);
    if (!user) {
        return res.status(401).json({ error: 'Unauthorized.' });
    }
    try {
        const { data: plans, error } = await supabaseAdmin
            .from('subscriptions')
            .select('id, plan_name')
            .eq('user_id', user.id)
            .eq('status', 'active');
        
        if (error) throw error;
        
        res.json({ plans });

    } catch (e) {
        handleError(res, e, 'Failed to retrieve active plans.');
    }
};

export const handleSwitchPlan = async (req: express.Request, res: express.Response) => {
    const user = await authenticateUser(req);
    if (!user) {
        return res.status(401).json({ error: 'Unauthorized.' });
    }
    
    const { subscriptionId } = req.body;
    if (!subscriptionId) {
        return res.status(400).json({ error: 'Subscription ID is required.' });
    }

    try {
        // Security Check: Verify the user actually owns this active subscription
        const { data: subscription, error: subError } = await supabaseAdmin
            .from('subscriptions')
            .select('plan_name')
            .eq('id', subscriptionId)
            .eq('user_id', user.id)
            .eq('status', 'active')
            .single();
            
        if (subError || !subscription) {
            return res.status(403).json({ error: 'Forbidden: You do not have permission to switch to this plan.' });
        }
        
        const newPlanName = subscription.plan_name;

        // Update the user's metadata to reflect the new primary plan
        const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(
            user.id,
            { user_metadata: { ...user.user_metadata, plan: newPlanName } }
        );

        if (updateError) throw updateError;
        
        console.log(`[User Controller] User ${user.id} switched active plan display to '${newPlanName}'.`);
        res.status(200).json({ message: 'Plan switched successfully.' });

    } catch(e) {
        handleError(res, e, 'Failed to switch plan.');
    }
};

export const handleCancelSubscription = async (req: express.Request, res: express.Response) => {
    const user = await authenticateUser(req);
    if (!user) {
        return res.status(401).json({ error: 'Unauthorized.' });
    }
    
    const { subscriptionId } = req.body;
    if (!subscriptionId) {
        return res.status(400).json({ error: 'Subscription ID is required.' });
    }

    try {
        const { data: subscription, error: subError } = await supabaseAdmin
            .from('subscriptions')
            .select('dodo_subscription_id, status')
            .eq('id', subscriptionId)
            .eq('user_id', user.id)
            .single();

        if (subError || !subscription) {
            return res.status(404).json({ error: 'Subscription not found or you do not have permission to modify it.' });
        }

        if (subscription.status !== 'active') {
             return res.status(400).json({ error: `Cannot cancel a subscription with status: ${subscription.status}.` });
        }
        
        if (!subscription.dodo_subscription_id) {
            // This could be a one-time payment plan that isn't cancellable.
            return res.status(400).json({ error: 'This plan is not a recurring subscription and cannot be cancelled.' });
        }
        
        const dodo = await getDodoClient();
        
        // Correct Method: Update the subscription to cancel at the end of the period.
        await dodo.subscriptions.update(subscription.dodo_subscription_id, {
            cancel_at_next_billing_date: true,
        });

        // The webhook (`subscription.cancelled`) will handle updating the final status in our DB.
        res.status(200).json({ message: 'Your subscription has been scheduled to cancel at the end of the current billing period.' });

    } catch(e) {
        handleError(res, e, 'Failed to cancel subscription.');
    }
};