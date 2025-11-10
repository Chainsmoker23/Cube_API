import * as express from 'express';
// FIX: Renamed imported controller functions to avoid potential conflicts and ensure correct module resolution.
import { 
    handleGenerateDiagram,
    handleGenerateNeuralNetwork, 
    handleExplainArchitecture, 
    handleGetApiKey,
    handleGenerateApiKey,
    handleRevokeApiKey
} from './controllers/generationController';
import { handleChatWithAssistant } from './controllers/chatController';
import { 
    createCheckoutSession, 
    handleDodoWebhook, 
    serveMockPaymentPage, 
    confirmMockPayment 
} from './controllers/paymentController';


const router = express.Router();

// --- PAYMENT & WEBHOOK ROUTES ---

// Endpoint to serve the realistic mock payment page
router.get('/api/mock-payment', serveMockPaymentPage);

// Endpoint to handle the form submission from the mock payment page
router.post('/api/confirm-payment', express.urlencoded({ extended: false }), confirmMockPayment);

// Endpoint to handle incoming webhooks from Dodo Payments
router.post('/api/dodo-webhook', express.raw({ type: 'application/json' }), handleDodoWebhook);

// Endpoint for the frontend to create a new checkout session
router.post('/api/create-checkout-session', express.json(), createCheckoutSession);


// --- GEMINI API PROXY ROUTES (for internal app use) ---

router.post('/api/generate-diagram', express.json(), handleGenerateDiagram);
router.post('/api/generate-neural-network', express.json(), handleGenerateNeuralNetwork);
router.post('/api/explain-architecture', express.json(), handleExplainArchitecture);
router.post('/api/chat', express.json(), handleChatWithAssistant);

// --- USER API KEY MANAGEMENT ---
router.get('/api/user/api-key', handleGetApiKey);
router.post('/api/user/api-key', express.json(), handleGenerateApiKey);
router.delete('/api/user/api-key', handleRevokeApiKey);


export default router;