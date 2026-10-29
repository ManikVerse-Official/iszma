// Accountant Bot — turns a settled ledger row into a durable, printable receipt.
//
// Lookup rules:
//   • Admins may look up any transaction by `transaction_id` or `payment_id`.
//   • A buyer may look up their own receipt by the `payment_id` they were given.
// Receipts are idempotent: re-requesting the same transaction returns the
// existing receipt instead of minting (or emailing) a second one.
//
// All rendering, storage and delivery live in `_shared/receipts.ts`, which is
// also called directly by `create-greeting` after a verified payment. Keeping one
// implementation is what stops the two paths from drifting and double-emailing.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { errorResponse, handleOptions, jsonResponse } from "../_shared/http.ts";
import { createAdminClient, getUserFromRequest, isAdminUser } from "../_shared/auth.ts";
import { clientIp } from "../_shared/entitlement.ts";
import { issueReceiptForTransaction } from "../_shared/receipts.ts";
import type { ReceiptLedgerRow } from "../_shared/receiptsCore.ts";

interface ReceiptRequest {
  payment_id?: string;
  transaction_id?: string;
}

serve(async (req: Request) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  try {
    const body = (await req.json().catch(() => ({}))) as ReceiptRequest;
    const paymentId = body.payment_id?.trim();
    const transactionId = body.transaction_id?.trim();

    if (!paymentId && !transactionId) {
      return errorResponse("Provide a payment_id or transaction_id", 400);
    }

    const supabase = createAdminClient();
    const user = await getUserFromRequest(req);
    const admin = await isAdminUser(user?.id);

    // Non-admins may only fetch a receipt for the payment they hold.
    if (!admin && !paymentId) {
      return errorResponse("A payment_id is required", 403);
    }

    let query = supabase.from("transactions").select("*").limit(1);
    query = paymentId
      ? query.eq("payment_id", paymentId)
      : query.eq("id", transactionId as string);

    const { data: rows, error: lookupError } = await query;
    if (lookupError) throw new Error(lookupError.message);

    const row = (rows?.[0] ?? null) as ReceiptLedgerRow | null;
    if (!row) return errorResponse("Transaction not found", 404);

    /*
     * One server-side issuer: reuse the stored receipt when it exists; otherwise
     * create it and email the buyer. Email failure is reported in `emailed`, not
     * as a failed receipt — the money already settled.
     */
    const issued = await issueReceiptForTransaction(supabase, row, { ip: clientIp(req) });

    if (!issued.receipt) {
      return errorResponse(issued.error ?? "Could not issue the receipt", 500);
    }

    return jsonResponse({
      success: true,
      receipt: issued.receipt,
      html: issued.html,
      emailed: issued.emailed,
      emailStatus: issued.emailStatus,
      ...(issued.error ? { emailError: issued.error } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("accountant-bot failed:", message);
    return errorResponse("Could not issue the receipt", 500);
  }
});
