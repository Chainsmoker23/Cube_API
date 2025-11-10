import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Read credentials directly from process.env.
// This is now safe because the main index.ts file guarantees that dotenv has
// been configured before this module is ever imported.
const supabaseUrl = process.env.VITE_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceKey) {
  // This check serves as a final, critical safeguard. If the process reaches
  // this point, it means the startup logic in index.ts has failed, which
  // should not happen. Throwing here provides a clear, immediate error.
  throw new Error('[SupabaseClient] Supabase credentials not found in process.env. This indicates a critical application startup error.');
}

// Create and export the Supabase admin client as a singleton.
export const supabaseAdmin: SupabaseClient = createClient(supabaseUrl, serviceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

console.log('[SupabaseClient] Admin client configured successfully.');
