import { createClient } from "@supabase/supabase-js";

let client = null;

// Created on first use so the site can build before keys are added.
export function getSupabase() {
  if (!client) {
    client = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    );
  }
  return client;
}
