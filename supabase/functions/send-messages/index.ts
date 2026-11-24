// send-messages: sends queued emails that are due, through Resend.
// Marks each one sent (with Resend's id) or, after 3 failed attempts, failed.
// Secrets needed (Supabase → Edge Functions → Secrets): RESEND_API_KEY, optional EMAIL_FROM_ADDRESS
import { createClient } from "jsr:@supabase/supabase-js@2";

const FROM_ADDRESS = Deno.env.get("EMAIL_FROM_ADDRESS") ?? "onboarding@resend.dev"; // test sender until our domain is verified
const MAX_ATTEMPTS = 3;

Deno.serve(async (req) => {
  // only signed-in users of the app (or the scheduler using the service key) may run this
  if (!req.headers.get("Authorization")) return new Response("Unauthorized", { status: 401 });

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) return Response.json({ error: "RESEND_API_KEY secret is not set" }, { status: 500 });

  const { data: due, error } = await db.from("messages")
    .select("id, company_id, to_name, to_address, subject, body, attempts, companies(name, sender_name, reply_to_email)")
    .eq("status", "queued").eq("channel", "email").lte("send_after", new Date().toISOString())
    .order("send_after").limit(50);
  if (error) return Response.json({ error: error.message }, { status: 500 });

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
  return Response.json({ checked: due?.length ?? 0, sent, failed });
});
