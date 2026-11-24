// send-messages: sends queued emails that are due, through Resend.
// Marks each one sent (with Resend's id) or, after 3 failed attempts, failed.
// Secrets needed (Supabase → Edge Functions → Secrets): RESEND_API_KEY, optional EMAIL_FROM_ADDRESS
import { createClient } from "jsr:@supabase/supabase-js@2";

const FROM_ADDRESS = Deno.env.get("EMAIL_FROM_ADDRESS") ?? "onboarding@resend.dev"; // test sender until our domain is verified
const MAX_ATTEMPTS = 3;

// allow the office app (a different website address) to call this function
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });   // browser pre-check
  // only signed-in users of the app (or the scheduler using the service key) may run this
  if (!req.headers.get("Authorization")) return reply({ error: "Unauthorized" }, 401);

  // Supabase provides its admin key to functions automatically (name differs between old and new key systems)
  const adminKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY");
  if (!adminKey) return reply({ error: "No Supabase admin key available to the function" }, 500);
  const db = createClient(Deno.env.get("SUPABASE_URL")!, adminKey);
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) return reply({ error: "RESEND_API_KEY secret is not set" }, 500);

  const { data: due, error } = await db.from("messages")
    .select("id, company_id, to_name, to_address, subject, body, attempts, companies(name, sender_name, reply_to_email)")
    .eq("status", "queued").eq("channel", "email").lte("send_after", new Date().toISOString())
    .order("send_after").limit(50);
  if (error) return reply({ error: error.message }, 500);

  let sent = 0, failed = 0;
  for (const m of due ?? []) {
    const co = (m as any).companies ?? {};
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: `${co.sender_name || co.name || "Smoke alarms"} <${FROM_ADDRESS}>`,
        to: [m.to_address],
        reply_to: co.reply_to_email || undefined,
        subject: m.subject,
        text: m.body,
      }),
    });
    const out = await res.json().catch(() => ({}));
    if (res.ok && out.id) {
      await db.from("messages").update({ status: "sent", sent_at: new Date().toISOString(), provider_id: out.id, error: null }).eq("id", m.id);
      sent++;
    } else {
      const attempts = (m.attempts ?? 0) + 1;
      await db.from("messages").update({
        attempts, error: out.message || `Resend error ${res.status}`,
        status: attempts >= MAX_ATTEMPTS ? "failed" : "queued",
      }).eq("id", m.id);
      failed++;
    }
  }
  return reply({ checked: due?.length ?? 0, sent, failed });
});
