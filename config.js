// এখানে আপনার Supabase প্রজেক্টের URL আর anon/public key বসান
// Supabase Dashboard > Project Settings > API থেকে পাবেন

const SUPABASE_URL = "https://zogbbofzjpxapliofnby.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpvZ2Jib2Z6anB4YXBsaW9mbmJ5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkxMzI1NjYsImV4cCI6MjEwNDcwODU2Nn0.BkUfAXssHmdlwpIfO_3OVRw-QTrqUq2cLbsVygZtBd8";

const supabaseClient = window.supabase.createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
);
