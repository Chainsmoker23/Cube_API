import * as express from 'express';
// FIX: Renamed imported controller functions to avoid potential conflicts and ensure correct module resolution.
import { 
    handleGenerateDiagram,
    handleGenerateNeuralNetwork, 
    handleExplainArchitecture
} from './controllers/generationController';
import { handleChatWithAssistant } from './controllers/chatController';
import { 
    createCheckoutSession, 
    handleDodoWebhook, 
    confirmMockPayment 
} from './controllers/paymentController';
import { 
    getAdminConfig, 
    updateAdminConfig, 
    handleAdminLogin,
    handleAdminLogout,
    getAdminUsers
} from './controllers/adminController';
import { 
    handleGetApiKey,
    handleGenerateApiKey,
    handleRevokeApiKey,
    handleGetActivePlans,
    handleSwitchPlan
} from './controllers/userController';
import { isAdmin } from './middleware/authMiddleware';


const router = express.Router();

// --- PAYMENT & WEBHOOK ROUTES ---

// Endpoint to handle the form submission from the mock payment page
router.post('/confirm-payment', express.json(), confirmMockPayment);

// Endpoint to handle incoming webhooks from Dodo Payments
// Note: express.raw is used here because the webhook signature verification needs the raw, unparsed body.
router.post('/dodo-webhook', express.raw({ type: 'application/json' }), handleDodoWebhook);

// Endpoint for the frontend to create a new checkout session
router.post('/create-checkout-session', express.json(), createCheckoutSession);


// --- GEMINI API PROXY ROUTES (for internal app use) ---

router.post('/generate-diagram', express.json(), handleGenerateDiagram);
router.post('/generate-neural-network', express.json(), handleGenerateNeuralNetwork);
router.post('/explain-architecture', express.json(), handleExplainArchitecture);
router.post('/chat', express.json(), handleChatWithAssistant);

// --- USER MANAGEMENT ROUTES ---
router.get('/user/api-key', handleGetApiKey);
router.post('/user/api-key', express.json(), handleGenerateApiKey);
router.delete('/user/api-key', handleRevokeApiKey);
router.get('/user/active-plans', handleGetActivePlans);
router.post('/user/switch-plan', express.json(), handleSwitchPlan);

// --- ADMIN ROUTES ---
router.post('/admin/login', express.json(), handleAdminLogin);
router.post('/admin/logout', express.json(), handleAdminLogout);
router.get('/admin/config', isAdmin, getAdminConfig);
router.post('/admin/config', express.json(), isAdmin, updateAdminConfig);
router.get('/admin/users', isAdmin, getAdminUsers);


export default router;