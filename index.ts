// --- CONFIGURATION ---
// This MUST be the first code to run to ensure all environment variables are loaded.
import dotenv from 'dotenv';
import path from 'path';

// Load environment variables from the root .env file.
const envPath = path.resolve(__dirname, '../.env');
const result = dotenv.config({ path: envPath });

if (result.error) {
  console.error(`[Startup Error] Could not load .env file from path: ${envPath}`);
  throw result.error;
}

// Validate that all required variables are present.
const requiredEnvVars = [
  'VITE_SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'DODO_SECRET_KEY',
  'SITE_URL',
  'DODO_WEBHOOK_SECRET',
  'GEMINI_API_KEY', // UPDATED: Check for backend-specific key
];
const missingVars = requiredEnvVars.filter(v => !process.env[v]);
if (missingVars.length > 0) {
  console.error(`[Startup Error] The following required environment variables are missing: ${missingVars.join(', ')}`);
  console.error(`[Startup Error] Please ensure they are set in the .env file at the project root.`);
  process.exit(1);
}
// --- END CONFIGURATION ---


// Now that config is guaranteed to be loaded, import the rest of the app.
import express from 'express';
import cors from 'cors';
import apiRoutes from './routes'; // Import the centralized routes

const app = express();
const port = 3001;

// --- Global Middleware ---
app.use(cors());

// --- API Routes ---
// All API logic is now handled in the routes file.
app.use(apiRoutes);

// --- Server Startup ---
app.listen(port, () => {
    console.log(`[Backend] CubeGen AI server listening at http://localhost:${port}`);
});