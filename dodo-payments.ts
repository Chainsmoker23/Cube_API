import crypto from 'crypto';

const DODO_WEBHOOK_SECRET = process.env.DODO_WEBHOOK_SECRET!;

// Store session data in memory for the mock flow
export const mockSessions = new Map<string, any>();

// Helper function to generate the HTML for the realistic payment form
const getPaymentPageHTML = (sessionId: string, sessionData: any) => {
    const planName = sessionData.planName.charAt(0).toUpperCase() + sessionData.planName.slice(1);
    const price = sessionData.line_items[0]?.price === 'dodo_price_hobby' ? '$3.00' :
                  sessionData.line_items[0]?.price === 'dodo_price_pro' ? '$10.00' : '$50.00';
    const interval = sessionData.line_items[0]?.price === 'dodo_price_hobby' ? 'one-time payment' : '/ month';

    return `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Dodo Payments</title>
            <script src="https://cdn.tailwindcss.com"></script>
        </head>
        <body class="bg-gray-100 flex items-center justify-center min-h-screen">
            <div class="w-full max-w-md bg-white rounded-2xl shadow-xl p-8">
                <div class="text-center mb-8">
                    <h1 class="text-3xl font-bold text-gray-800">Dodo Payments</h1>
                    <p class="text-gray-500">A surprisingly realistic checkout experience</p>
                </div>
                
                <div class="bg-gray-50 rounded-lg p-4 mb-6 border border-gray-200">
                    <div class="flex justify-between items-center">
                        <div>
                            <p class="font-semibold text-gray-800">${planName} Plan</p>
                            <p class="text-sm text-gray-500">Billed ${interval}</p>
                        </div>
                        <p class="text-2xl font-bold text-gray-900">${price}</p>
                    </div>
                </div>

                <form action="/api/confirm-payment" method="POST">
                    <input type="hidden" name="sessionId" value="${sessionId}">
                    <div class="space-y-4">
                        <div>
                            <label for="email" class="text-sm font-medium text-gray-700">Email</label>
                            <input type="email" id="email" value="test-user@example.com" class="mt-1 block w-full px-3 py-2 bg-white border border-gray-300 rounded-md shadow-sm placeholder-gray-400 focus:outline-none focus:ring-pink-500 focus:border-pink-500 sm:text-sm" readonly>
                        </div>
                        <div>
                            <label for="card-holder" class="text-sm font-medium text-gray-700">Cardholder Name</label>
                            <input type="text" id="card-holder" value="Divesh Sarkar" placeholder="Full Name" class="mt-1 block w-full px-3 py-2 bg-white border border-gray-300 rounded-md shadow-sm placeholder-gray-400 focus:outline-none focus:ring-pink-500 focus:border-pink-500 sm:text-sm">
                        </div>
                        <div>
                            <label for="card-number" class="text-sm font-medium text-gray-700">Card Details</p>
                            <div class="mt-1 relative rounded-md shadow-sm">
                                <input type="text" id="card-number" placeholder="0000 0000 0000 0000" class="block w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-pink-500 focus:border-pink-500 sm:text-sm" value="4242 4242 4242 4242">
                                <div class="absolute inset-y-0 right-0 flex items-center">
                                    <input type="text" placeholder="MM / YY" class="w-20 text-center border-0 border-l border-gray-300 bg-transparent focus:ring-0 sm:text-sm" value="12 / 27">
                                    <input type="text" placeholder="CVC" class="w-16 text-center border-0 border-l border-gray-300 bg-transparent rounded-r-md focus:ring-0 sm:text-sm" value="123">
                                </div>
                            </div>
                        </div>
                    </div>
                    <button type="submit" class="w-full mt-6 bg-pink-600 text-white font-semibold py-3 px-4 rounded-lg shadow-md hover:bg-pink-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-pink-500 transition-colors">
                        Pay ${price}
                    </button>
                    <p class="text-xs text-gray-400 text-center mt-4">This is a mock payment. No real transaction will occur.</p>
                </form>
            </div>
        </body>
        </html>
    `;
};


// --- Mock implementation of the fictional Dodo Payments SDK ---
export class DodoPayments {
    private apiKey: string;
    constructor(apiKey: string) {
        if (!apiKey) {
            throw new Error("[Dodo Payments Mock] API Key is required.");
        }
        this.apiKey = apiKey;
        console.log('[Dodo Payments Mock] SDK Initialized.');
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
            }) => {
                console.log('[Dodo Payments Mock] Creating checkout session with params:', params);
                const sessionId = `cs_mock_${Math.random().toString(36).substring(2, 15)}`;

                const planName = params.line_items[0]?.price
                  .replace('dodo_price_', '')
                  .replace('biz', 'business') || 'Unknown Plan';

                // Store details for the mock payment page and webhook
                mockSessions.set(sessionId, {
                    success_url: params.success_url,
                    cancel_url: params.cancel_url,
                    customer: params.customer,
                    line_items: params.line_items,
                    planName: planName,
                });
                
                // Return a URL to our new mock payment page
                const paymentPageUrl = `http://localhost:3001/api/mock-payment?sessionId=${sessionId}`;
                
                return Promise.resolve({ id: sessionId, url: paymentPageUrl });
            }
        }
    };
    
    // Public method to expose the page generation
    public getPaymentPage(sessionId: string, sessionData: any): string {
      return getPaymentPageHTML(sessionId, sessionData);
    }

    async simulateWebhook(sessionId: string, customerId: string, lineItems: any[]) {
        console.log(`[Dodo Payments Mock] Simulating webhook for session: ${sessionId}`);
        
        const payload = JSON.stringify({
            type: 'checkout.session.completed',
            data: {
                object: {
                    id: sessionId,
                    customer: customerId,
                    line_items: { data: lineItems }
                }
            }
        });

        // Create a signature to send with the webhook for verification
        const signature = crypto
            .createHmac('sha256', DODO_WEBHOOK_SECRET)
            .update(payload)
            .digest('hex');

        try {
            await fetch('http://localhost:3001/api/dodo-webhook', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'dodo-signature': signature, // Send the signature
                },
                body: payload,
            });
        } catch (error) {
            console.error('[Dodo Payments Mock] Failed to send simulated webhook:', error);
        }
    }
}