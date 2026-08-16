/**
 * CONFIG.JS
 * ---------
 * Fill these three values in after you create your Supabase project and Razorpay account.
 *
 * SUPABASE_URL and SUPABASE_ANON_KEY are safe to expose in frontend code.
 * The anon key can only do what your Row Level Security (RLS) policies allow —
 * see supabase/schema.sql for those rules. It is NOT a secret.
 *
 * RAZORPAY_KEY_ID is Razorpay's public "Key ID" (starts with rzp_test_ or rzp_live_).
 * It is also safe to expose — it only identifies your account for checkout.
 *
 * NEVER put your Supabase service_role key or your Razorpay Key Secret in this file
 * or anywhere in the frontend. Those live only in your Supabase Edge Function
 * environment variables (see README.md, section "Edge Function secrets").
 */

const SUPABASE_URL = "https://cevhjoaovykpamhzehtu.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_K698ky5u1zpcIt6MobaPyg_Qf0-2V68";
const RAZORPAY_KEY_ID = "rzp_test_YOUR_KEY_ID";
