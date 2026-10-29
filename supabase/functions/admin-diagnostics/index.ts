// admin-diagnostics — read-only, admin-only health checks.
//
// It exists because "the site is fine" was being inferred from a page reload.
// This function inspects the pieces a reload cannot show: whether each provider
// key is present, whether the database is readable with the service role, which
// emails failed and why, and whether settled orders are missing receipts.
//
// Security posture:
//   • POST only; CORS preflight is handled by the shared helper.
//   • The caller must present a valid Supabase JWT (401) AND be in `admin_users`
//     (403). The body cannot influence identity or permissions.
//   • Secret VALUES are never read into the response — only whether they exist.
//   • It performs no writes except an append-only audit entry recording the run.
//
// Deployment: supabase functions deploy admin-diagnostics
// No migration is required.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { errorResponse, handleOptions, jsonResponse } from "../_shared/http.ts";
import { createAdminClient, getUserFromRequest, isAdminUser } from "../_shared/auth.ts";
import { clientIp } from "../_shared/entitlement.ts";
import { isEmailConfigured } from "../_shared/email.ts";
import {
  emailFailureCheck,
  maskEmail,
  missingReceiptCheck,
  optionalConfigCheck,
  sortDiagnostics,
  summariseDiagnostics,
  type DiagnosticCheck,
} from "../_shared/diagnosticsCore.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const sinceIso = (days: number): string => new Date(Date.now() - days * DAY_MS).toISOString();

/** Reads a count without throwing; null means the query itself failed. */
const countRows = async (
  client: any,
  table: string,
  apply?: (query: any) => any,
): Promise<number | null> => {
  let query = client.from(table).select("*", { count: "exact", head: true });
  if (apply) query = apply(query);
  const { count, error } = await query;
  if (error) {
    console.error(`diagnostics count ${table} failed:`, error.message);
    return null;
  }
  return count ?? 0;
};

serve(async (req: Request) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  const ip = clientIp(req);

  try {
    const client = createAdminClient();

    /* 1. Verified session, then verified admin membership. */
    const user = await getUserFromRequest(req);
    if (!user) return errorResponse("A valid administrator session is required", 401);

    const admin = await isAdminUser(user.id);
    if (!admin) return errorResponse("Administrator access required", 403);

    const checks: DiagnosticCheck[] = [];

    /* 2. Database reachability with the service role. */
    const productCount = await countRows(client, "products");
    checks.push({
      id: "database.service_role",
      title: "Database access (service role)",
      status: productCount === null ? "fail" : "ok",
      recoverable: true,
      rootCause:
        productCount === null
          ? "The function could not read the products table with its service-role client."
          : "The service-role client can read the catalogue.",
      evidence:
        productCount === null
          ? "The products query returned an error (see function logs)."
          : `${productCount} product row(s) readable.`,
      nextStep:
        productCount === null
          ? "Check SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY on the function, then re-run diagnostics."
          : "No action needed.",
    });

    /* 3. Payment provider configuration. A missing key is an owner action:
     *    checkout will answer 503 PAYMENT_CONFIG, and nothing is charged. */
    const razorpay = Boolean(Deno.env.get("RAZORPAY_KEY_ID") && Deno.env.get("RAZORPAY_KEY_SECRET"));
    const paypal = Boolean(
      Deno.env.get("PAYPAL_CLIENT_ID") && Deno.env.get("PAYPAL_CLIENT_SECRET"),
    );
    const stripe = Boolean(Deno.env.get("STRIPE_SECRET_KEY"));

    checks.push(
      optionalConfigCheck(
        "payments.razorpay",
        "Razorpay (INR checkout)",
        razorpay,
        "INR checkout cannot start: create-payment-order answers 503 PAYMENT_CONFIG and nothing is charged.",
        "Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET, then retry checkout.",
      ),
      optionalConfigCheck(
        "payments.paypal",
        "PayPal (international)",
        paypal,
        "PayPal orders cannot be created for international buyers.",
        "Set PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PAYPAL_MODE.",
      ),
      optionalConfigCheck(
        "payments.stripe",
        "Stripe (international card)",
        stripe,
        "Hosted Stripe checkout is unavailable; card orders fall back to PayPal when it is configured.",
        "Set STRIPE_SECRET_KEY (and VITE_STRIPE_PUBLISHABLE_KEY for the browser).",
      ),
    );

    if (!razorpay && !paypal && !stripe) {
      checks.push({
        id: "payments.any",
        title: "Paid checkout availability",
        status: "fail",
        recoverable: true,
        rootCause: "No payment provider is configured, so every paid flow is disabled server-side.",
        evidence: "Razorpay, PayPal and Stripe are all unconfigured.",
        nextStep: "Configure at least one provider, then re-run diagnostics.",
      });
    }

    /* 4. Transactional email: key presence, recent failures, latest reason. */
    const failedEmailSince = sinceIso(7);
    const failedEmailCount = await countRows(client, "email_log", (query: any) =>
      query.eq("status", "failed").gte("created_at", failedEmailSince),
    );
    const { data: failedEmailRows } = await client
      .from("email_log")
      .select("template, to_email, error, created_at")
      .eq("status", "failed")
      .gte("created_at", failedEmailSince)
      .order("created_at", { ascending: false })
      .limit(5);

    const latestFailure = failedEmailRows?.[0];
    if (failedEmailCount === null) {
      /*
       * The query failed, so "0 failures" would be a fabricated pass. Report the
       * gap as unverified instead.
       */
      checks.push({
        id: "email.delivery",
        title: "Transactional email (Resend)",
        status: "unknown",
        recoverable: true,
        rootCause: "The email_log table could not be read, so delivery health is unverified.",
        evidence: "The email_log count query returned an error.",
        nextStep: "Check that email_log exists (migration 20261003) and that the service role can read it.",
      });
    } else {
      checks.push(
        emailFailureCheck({
          configured: isEmailConfigured(),
          failedCount: failedEmailCount,
          latestError: latestFailure
            ? `${latestFailure.template} to ${maskEmail(String(latestFailure.to_email ?? ""))}: ${
                latestFailure.error ?? "no reason recorded"
              }`
            : undefined,
        }),
      );
    }

    /* 5. Owner copies. Without this secret the buyer still gets their receipt,
     *    but no copy reaches the owner. */
    const ownerNotify = Boolean(
      Deno.env.get("ADMIN_NOTIFY_EMAIL") || Deno.env.get("ADMIN_EMAILS"),
    );
    checks.push(
      optionalConfigCheck(
        "email.owner_copy",
        "Owner copy of receipts",
        ownerNotify,
        "Buyers still receive their receipt, but no copy is sent to the store owner.",
        "Set ADMIN_NOTIFY_EMAIL (or ADMIN_EMAILS) on the project.",
      ),
    );

    /* 6. Receipt coverage for settled orders. */
    const { data: paidRows, error: paidError } = await client
      .from("transactions")
      .select("id, payment_id, status, created_at")
      .eq("status", "paid")
      .gte("created_at", sinceIso(30))
      .order("created_at", { ascending: false })
      .limit(200);

    if (paidError) {
      checks.push({
        id: "receipts.missing",
        title: "Receipts for settled orders",
        status: "unknown",
        recoverable: true,
        rootCause: "The settled orders could not be read, so receipt coverage cannot be checked.",
        evidence: paidError.message,
        nextStep: "Check the transactions table permissions / schema, then re-run diagnostics.",
      });
    } else {
      const ids = (paidRows ?? []).map((row: { id: string }) => row.id);
      let missing = 0;
      let sample = "";
      if (ids.length > 0) {
        const { data: receiptRows } = await client
          .from("receipts")
          .select("transaction_id")
          .in("transaction_id", ids);
        const covered = new Set((receiptRows ?? []).map((row: any) => String(row.transaction_id)));
        for (const row of paidRows ?? []) {
          if (!covered.has(String(row.id))) {
            missing += 1;
            if (!sample) sample = String(row.payment_id ?? "");
          }
        }
      }
      checks.push(missingReceiptCheck(missing, sample || undefined));
    }

    /* 7. Subscriptions that are still marked active after expiry. */
    const staleSubscriptions = await countRows(client, "studio_subscriptions", (query: any) =>
      query.eq("status", "active").lt("expires_at", new Date().toISOString()),
    );
    checks.push({
      id: "subscriptions.expired",
      title: "Expired subscriptions still active",
      status:
        staleSubscriptions === null ? "unknown" : staleSubscriptions > 0 ? "warn" : "ok",
      recoverable: true,
      rootCause:
        staleSubscriptions === null
          ? "The subscription table could not be read."
          : staleSubscriptions > 0
            ? `${staleSubscriptions} subscription(s) passed their expiry date but still carry status = active.`
            : "No subscription is active past its expiry date.",
      evidence:
        staleSubscriptions === null
          ? "Query failed; see the function logs."
          : `${staleSubscriptions} stale row(s).`,
      nextStep:
        staleSubscriptions && staleSubscriptions > 0
          ? "Run the subscription-maintenance function (it is idempotent) to expire them."
          : "No action needed.",
    });

    /* 8. Game Zone / Studio configuration rows. Missing rows make online play
     *    look broken while offline play still works. */
    const gameSettingsCount = await countRows(client, "game_settings");
    checks.push({
      id: "game.settings",
      title: "Game Zone settings row",
      status: gameSettingsCount === null ? "unknown" : gameSettingsCount > 0 ? "ok" : "warn",
      recoverable: true,
      rootCause:
        gameSettingsCount === null
          ? "game_settings could not be read."
          : gameSettingsCount > 0
            ? "The Game Zone setting is present."
            : "No game_settings row exists, so online modes report themselves as unavailable.",
      evidence:
        gameSettingsCount === null ? "Query failed." : `${gameSettingsCount} row(s).`,
      nextStep:
        gameSettingsCount && gameSettingsCount > 0
          ? "No action needed."
          : "Apply the Game Zone migration or insert the default row for pair3balls.",
    });

    const planCount = await countRows(client, "studio_plan_prices");
    checks.push({
      id: "studio.plans",
      title: "ReportCard Studio plans",
      status: planCount === null ? "unknown" : planCount > 0 ? "ok" : "warn",
      recoverable: true,
      rootCause:
        planCount === null
          ? "studio_plan_prices could not be read."
          : planCount > 0
            ? "The plan price table is populated."
            : "No plan prices exist; checkout cannot resolve an amount.",
      evidence: planCount === null ? "Query failed." : `${planCount} plan(s).`,
      nextStep:
        planCount && planCount > 0
          ? "No action needed."
          : "Apply migration 20261023 (studio_plan_prices) and seed the plans.",
    });

    /* 9. Recent failed/blocked admin operations. */
    const { data: auditFailures } = await client
      .from("admin_audit_log")
      .select("action, outcome, detail, created_at")
      .in("outcome", ["failure", "blocked", "denied"])
      .gte("created_at", failedEmailSince)
      .order("created_at", { ascending: false })
      .limit(5);

    checks.push({
      id: "admin.audit_failures",
      title: "Recent admin operation failures",
      status: (auditFailures?.length ?? 0) > 0 ? "warn" : "ok",
      recoverable: true,
      rootCause:
        (auditFailures?.length ?? 0) > 0
          ? `${auditFailures?.length} admin operation(s) failed, were blocked or were denied in the last 7 days.`
          : "No failed or denied admin operations in the last 7 days.",
      evidence:
        (auditFailures?.length ?? 0) > 0
          ? `${auditFailures?.[0]?.action}: ${auditFailures?.[0]?.detail ?? auditFailures?.[0]?.outcome}`
          : "0 recent failures.",
      nextStep:
        (auditFailures?.length ?? 0) > 0
          ? "Read the audit log; a repeated failure usually means a missing migration or permission."
          : "No action needed.",
    });

    /* 10. Site URL used in emailed links. The default works, but an explicit
     *     value avoids links pointing at the wrong host. */
    const siteUrl = Deno.env.get("PUBLIC_SITE_URL") ?? Deno.env.get("SITE_URL");
    checks.push(
      optionalConfigCheck(
        "site.url",
        "Public site URL",
        Boolean(siteUrl),
        "PUBLIC_SITE_URL is not set, so receipt/manage links fall back to https://ishmaverse.vercel.app.",
        "Set PUBLIC_SITE_URL to the live origin so emailed links always resolve.",
      ),
    );

    const ordered = sortDiagnostics(checks);
    const summary = summariseDiagnostics(ordered);
    const generatedAt = new Date().toISOString();

    /* 11. Append-only audit entry: who asked, and what it found. Best-effort —
     *     a missing audit table must not hide the diagnostics themselves. */
    try {
      await client.from("admin_audit_log").insert([
        {
          actor_id: user.id,
          actor_email: user.email ?? null,
          action: "diagnostics.run",
          outcome: "success",
          detail: `${summary.failures} failing, ${summary.warnings} warning(s), ${summary.unknown} unverified.`,
          ip: ip || null,
        },
      ]);
    } catch (auditError) {
      console.error(
        "diagnostics audit insert failed:",
        auditError instanceof Error ? auditError.message : String(auditError),
      );
    }

    return jsonResponse({ success: true, generatedAt, checks: ordered, summary });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("admin-diagnostics failed:", message);
    return errorResponse("Diagnostics could not be completed.", 500);
  }
});
