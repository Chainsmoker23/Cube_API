// --- CONFIGURATION ---
// This MUST be the first code to run to ensure all environment variables are loaded.
import dotenv from 'dotenv';


// Load environment variables from the root .env file by default.
// This is more robust as it relies on the standard behavior of running the script
// from the project's root directory.
const result = dotenv.config();

if (result.error) {
  console.error(`[Startup Error] Could not load .env file. Ensure it exists in the project root.`);
  throw result.error;
}
console.log('[Startup] .env file loaded successfully.');

// Validate that all required variables are present.
const requiredEnvVars = [
  'VITE_SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'DODO_SECRET_KEY',
  'SITE_URL',
  'DODO_WEBHOOK_SECRET',
  'VITE_API_KEY',
  'ADMIN_EMAIL',
  'ADMIN_PASSWORD',
  'JWT_SECRET',
];
const missingVars = requiredEnvVars.filter(v => !process.env[v]);
if (missingVars.length > 0) {
  console.error(`[Startup Error] The following required environment variables are missing: ${missingVars.join(', ')}`);
  console.error(`[Startup Error] Please ensure they are set in the .env file at the project root.`);
  process.exit(1);
}
console.log('[Startup] All required environment variables are present.');

// --- Dodo Payments Key Logging ---
// Log the presence of Dodo keys to help with debugging setup issues.
console.log(`[Startup] DODO_SECRET_KEY loaded: ${process.env.DODO_SECRET_KEY ? 'Yes' : 'No'}`);
console.log(`[Startup] DODO_WEBHOOK_SECRET loaded: ${process.env.DODO_WEBHOOK_SECRET ? 'Yes' : 'No'}`);
// --- END CONFIGURATION ---


// Now that config is guaranteed to be loaded, import the rest of the app.
import express from 'express';
import cors from 'cors';
import apiRoutes from './routes'; // Import the centralized routes

const app = express();
const port = 3001;

// --- Global Middleware ---

// Configure CORS to allow requests from your local frontend development server.
// In a production environment, you would also add your deployed frontend's URL.
const allowedOrigins = [
    'http://localhost:5173', // Default Vite dev server
    'http://localhost:5174', // Alternative Vite dev server
    'http://localhost:3000', // Common CRA dev server
];

const corsOptions: cors.CorsOptions = {
    origin: (origin, callback) => {
        // Allow requests with no origin (like mobile apps or curl requests)
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) === -1) {
            const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
            return callback(new Error(msg), false);
        }
        return callback(null, true);
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
};

// Apply CORS middleware to all incoming requests.
app.use(cors(corsOptions));

// The global express.json() middleware has been removed from here.
// It is now applied selectively to routes in `routes.ts` to allow
// the webhook route to receive the raw request body for signature verification.

// --- API Routes ---
// Mount all API routes under the /api prefix.
// This means routes defined in `routes.ts` as `/generate-diagram` will be accessible at `/api/generate-diagram`.
app.use('/api', apiRoutes);

// --- Server Startup ---
app.listen(port, () => {
    console.log(`[Backend] CubeGen AI server listening at http://localhost:${port}`);
});