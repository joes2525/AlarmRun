// send-messages: sends queued emails that are due, through Resend.
// Marks each one sent (with Resend's id) or, after 3 failed attempts, failed.
// Secrets needed (Supabase → Edge Functions → Secrets): RESEND_API_KEY, optional EMAIL_FROM_ADDRESS
import { createClient } from "jsr:@supabase/supabase-js@2";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";
import { PDFDocument, StandardFonts } from "npm:pdf-lib@1.17.1";

const FROM_ADDRESS = Deno.env.get("EMAIL_FROM_ADDRESS") ?? "onboarding@resend.dev"; // test sender until our domain is verified
const MAX_ATTEMPTS = 3;
// blank RTA Entry notice (Form 9), filled in and attached to every entry-notice email
const FORM9_URL = Deno.env.get("FORM9_URL") ?? "https://joes2525.github.io/AlarmRun/forms/form9.pdf";
let form9: Uint8Array | null = null;
const sigs = new Map<string, Uint8Array | null>();   // company signature images, loaded once per run

// allow the office app (a different website address) to call this function
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// Fills the RTA Entry notice (Form 9) for one entry-notice email and returns the PDF bytes.

type Form9 = {
  tenants: string; address: string; suburb: string; postcode: string;
  company: string; phone: string; entering: string;
  issued: Date; visit: Date;            // notice issue time and visit date
  timeOfEntry?: string;                 // e.g. "8am to 5pm"
  signature?: Uint8Array | null;        // PNG/JPG; if none, the company name is written instead
};

const tz = "Australia/Brisbane";
const day = (d: Date) => d.toLocaleDateString("en-AU", { weekday: "long", timeZone: tz });
const dmy = (d: Date) => d.toLocaleDateString("en-AU", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: tz });

async function fillForm9(template: Uint8Array, f: Form9): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(template);
  const form = pdf.getForm();
  const set = (name: string, v: string) => { try { form.getTextField(name).setText(v); } catch { /* field missing in a newer form version */ } };
  const tick = (name: string) => { try { form.getCheckBox(name).check(); } catch { /* ignore */ } };

  set("Name/s of tenant/s", f.tenants);
  set("Address1", f.address);
  set("Address 2", `${f.suburb} QLD`);
  set("Postcode 1", f.postcode);
  tick("Other authorised person (secondary agent)");          // checking company acts for the agent/owner
  set("Full name or trading name", f.company);
  set("Phone number", f.phone);
  set("Full name or trading name 1", f.entering);
  set("Phone number 1", f.phone);
  set("Day 1", day(f.issued));
  set("Date (dd/mm/yyyy)1", dmy(f.issued));
  set("Method of issue 1", "Email");
  tick("Checkbox5");                                           // Fire Services Act 1990 (smoke alarms) – 48 hours
  tick("Checkbox6");                                           // Electrical Safety Act 2002 (safety switches) – 48 hours
  set("Day 2", day(f.visit));
  set("Date (dd/mm/yyyy) 2", dmy(f.visit));
  set("Time of entry", f.timeOfEntry ?? "8am to 5pm");
  set("Print name", f.company);
  set("Date of signature (dd/mm/yyyy)", dmy(f.issued));

  // signature goes in the box between "Print name" and "Date" (it isn't a form field)
  try {
    const r1 = form.getTextField("Print name").acroField.getWidgets()[0].getRectangle();
    const r2 = form.getTextField("Date of signature (dd/mm/yyyy)").acroField.getWidgets()[0].getRectangle();
    const page = pdf.getPages()[0];
    const box = { x: r1.x + r1.width + 12, y: r1.y + 1, w: r2.x - (r1.x + r1.width) - 24, h: r1.height - 2 };
    if (f.signature?.length) {
      const png = f.signature[0] === 0x89;
      const img = png ? await pdf.embedPng(f.signature) : await pdf.embedJpg(f.signature);
      const k = Math.min(box.w / img.width, box.h / img.height);
      page.drawImage(img, { x: box.x + (box.w - img.width * k) / 2, y: box.y + (box.h - img.height * k) / 2, width: img.width * k, height: img.height * k });
    } else {
      const font = await pdf.embedFont(StandardFonts.HelveticaOblique);
      page.drawText(f.company, { x: box.x + 4, y: box.y + box.h / 2 - 4, size: 10, font, maxWidth: box.w - 8 });
    }
  } catch { /* leave the box empty rather than fail the notice */ }

  for (const b of ["Reset form", "Print form"]) { try { form.removeField(form.getField(b)); } catch { /* ignore */ } }
  form.flatten();                                              // tenants can't edit it
  return await pdf.save();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });   // browser pre-check

  // Supabase provides its admin key to functions automatically (name differs between old and new key systems)
  const adminKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY");
  if (!adminKey) return reply({ error: "No Supabase admin key available to the function" }, 500);
  const db = createClient(Deno.env.get("SUPABASE_URL")!, adminKey);

  // only signed-in app users (or the scheduler using the admin key) may run this
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return reply({ error: "Not signed in" }, 401);
  if (token !== adminKey) {
    const { data: { user } } = await db.auth.getUser(token);
    if (!user) return reply({ error: "Not signed in" }, 401);
  }
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) return reply({ error: "RESEND_API_KEY secret is not set" }, 500);

  const { data: due, error } = await db.from("messages")
    .select("id, company_id, kind, for_date, to_name, to_address, subject, body, attempts, companies(name, sender_name, reply_to_email, phone, signature), tenancies(tenant_names), jobs(scheduled_start, inspectors(name), properties(address_line, suburb, postcode))")
    .eq("status", "queued").eq("channel", "email").lte("send_after", new Date().toISOString())
    .order("send_after").limit(50);
  if (error) return reply({ error: error.message }, 500);

  let sent = 0, failed = 0;
  for (const m of due ?? []) {
    const co = (m as any).companies ?? {};
    // entry notices get the filled-in Form 9 attached
    let attachments: { filename: string; content: string }[] | undefined;
    if ((m.kind ?? "").startsWith("entry_notice")) {
      try {
        form9 ??= new Uint8Array(await (await fetch(FORM9_URL)).arrayBuffer());
        const j = (m as any).jobs ?? {}, p = j.properties ?? {}, company = co.sender_name || co.name || "";
        if (co.signature && !sigs.has(co.signature)) {
          const { data: file } = await db.storage.from("photos").download(co.signature);
          sigs.set(co.signature, file ? new Uint8Array(await file.arrayBuffer()) : null);
        }
        const pdf = await fillForm9(form9, {
          tenants: (m as any).tenancies?.tenant_names || m.to_name || "Tenant",
          address: p.address_line ?? "", suburb: p.suburb ?? "", postcode: p.postcode ?? "",
          company, phone: co.phone ?? "",
          entering: j.inspectors?.name ? `${j.inspectors.name} (or other ${company} technician)` : `${company} technician`,
          signature: co.signature ? sigs.get(co.signature) : null,
          issued: new Date(), visit: new Date(j.scheduled_start ?? `${m.for_date}T00:00:00+10:00`),
        });
        attachments = [{ filename: `Entry notice - ${p.address_line ?? "property"}.pdf`, content: encodeBase64(pdf) }];
        // keep a copy of exactly what the tenant got (best effort – the email still goes if this fails)
        const path = `${m.company_id}/notices/${m.id}.pdf`;
        const { error: upErr } = await db.storage.from("photos").upload(path, pdf, { contentType: "application/pdf", upsert: true });
        if (!upErr) await db.from("messages").update({ attachment_path: path }).eq("id", m.id);
      } catch (e) {
        const attempts = (m.attempts ?? 0) + 1;     // don't send a notice without its form
        await db.from("messages").update({ attempts, error: "Form 9: " + (e as Error).message, status: attempts >= MAX_ATTEMPTS ? "failed" : "queued" }).eq("id", m.id);
        failed++; continue;
      }
    }
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: `${co.sender_name || co.name || "Smoke alarms"} <${FROM_ADDRESS}>`,
        to: String(m.to_address).split(/\s*,\s*/).filter(Boolean),   // entry notices can go to several tenants
        reply_to: co.reply_to_email || undefined,
        subject: m.subject,
        text: m.body,
        attachments,
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
