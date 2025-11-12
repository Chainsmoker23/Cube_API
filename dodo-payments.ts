import crypto from 'crypto';
import { getCachedConfig } from './controllers/adminController';

// Store session data in memory for the mock flow
export const mockSessions = new Map<string, any>();

// --- Mock implementation of the fictional Dodo Payments SDK ---
export class DodoPayments {
    private apiKey: string;
    constructor(apiKey: string) {
        if (!apiKey) {
            throw new Error("[Dodo Payments Mock] API Key is required.");
        }
        this.apiKey = apiKey;
        const maskedKey = apiKey.slice(0, 4) + '...';
        console.log(`[Dodo Payments Mock] SDK Initialized with key: ${maskedKey}`);
    }

    customers = {
        create: async (params: { email?: string; name?: string }) => {
            console.log('[Dodo Payments Mock] Creating customer with params:', params);
            const customerId = `cus_mock_${Math.random().toString(36).substring(2, 15)}`;
            return Promise.resolve({ id: customerId });
        }
    };

    checkout = {
        sessions: {
            create: async (params: {
                payment_method_types: string[];
                line_items: any[];
                mode: string;
                success_url: string;
                cancel_url: string;
                customer?: string;
                customer_email?: string;
                metadata?: Record<string, any>; // Add metadata support
            }) => {
                console.log('[Dodo Payments Mock] Creating checkout session with params:', params);
                const sessionId = `cs_mock_${Math.random().toString(36).substring(2, 15)}`;

                mockSessions.set(sessionId, {
                    success_url: params.success_url,
                    cancel_url: params.cancel_url,
                    customer: params.customer,
                    line_items: params.line_items,
                    mode: params.mode,
                    metadata: params.metadata,
                });
                
                return Promise.resolve({ id: sessionId, url: null });
            }
        }
    };

    async simulateWebhook(sessionId: string, customerId: string, lineItems: any[], mode: string, metadata: Record<string, any>) {
        console.log(`[Dodo Payments Mock] Simulating webhook for session: ${sessionId}`);
        
        const config = await getCachedConfig();
        const dodoWebhookSecret = config.dodo_webhook_secret;

        if (!dodoWebhookSecret) {
            const errorMessage = '[Dodo Payments Mock] CRITICAL: Webhook secret not found. Cannot simulate webhook.';
            console.error(errorMessage);
            throw new Error(errorMessage);
        }

        let eventType = '';
        let eventPayloadData: any;

        const basePayload = { customer: customerId, metadata };

        if (mode === 'payment') {
            eventType = 'payment.succeeded';
            eventPayloadData = { ...basePayload, id: `pay_mock_${sessionId}` };
        } else if (mode === 'subscription') {
            eventType = 'subscription.active';
            eventPayloadData = { ...basePayload, id: `sub_mock_${Math.random().toString(36).substring(2, 15)}` };
        } else {
            throw new Error(`[Dodo Payments Mock] Unknown mode for webhook simulation: ${mode}`);
        }

        const payload = JSON.stringify({
            type: eventType,
            data: { object: eventPayloadData }
        });

        const signature = crypto
            .createHmac('sha256', dodoWebhookSecret)
            .update(payload)
            .digest('hex');

        try {
            console.log(`[Dodo Payments Mock] Sending simulated '${eventType}' event to webhook endpoint...`);
            const response = await fetch('http://localhost:3001/api/dodo-webhook', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'dodo-signature': signature,
                },
                body: payload,
            });

            if (!response.ok) {
                const errorBody = await response.text();
                throw new Error(`Simulated webhook failed with status ${response.status}: ${errorBody}`);
            }

            console.log('[Dodo Payments Mock] Simulated webhook sent and processed successfully.');
        } catch (error) {
            console.error('[Dodo Payments Mock] Failed to send/process simulated webhook:', error);
            throw error;
        }
    }
}