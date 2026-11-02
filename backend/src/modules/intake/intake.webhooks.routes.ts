import express, { Router, type RequestHandler } from "express";
import { asyncRoute, routerErrorHandler } from "../../middleware/asyncRoute";
import { createServerSupabase } from "../../lib/supabase";
import { sendServiceFailure } from "../../lib/serviceResult";
import { receiveInboundEmail, receiveSlackEvent } from "./intake.service";
import { intakeId } from "./intake.validation";

/**
 * Where Slack and Postmark deliver messages for automated intake. Mounted
 * outside the signed-in /intake API and ahead of the global JSON parser:
 * these callers authenticate with a signature or a secret URL, not a session.
 */
export const intakeWebhooksRouter = Router();

// Slack signs the exact bytes it sent, so this body is read raw.
intakeWebhooksRouter.post(
  "/slack/:webhookId",
  express.raw({ type: "*/*", limit: "1mb" }),
  asyncRoute(async (req, res) => {
    if (!intakeId.safeParse(req.params.webhookId).success)
      return void res.status(404).json({ detail: "Not found." });
    const result = await receiveSlackEvent(
      createServerSupabase(),
      req.params.webhookId,
      Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
      {
        timestamp: req.get("x-slack-request-timestamp"),
        signature: req.get("x-slack-signature"),
      },
    );
    if (!result.ok) return void sendServiceFailure(res, result);
    if (result.data.challenge !== undefined)
      return void res.json({ challenge: result.data.challenge });
    res.json({ ok: true });
  }),
);

// The URL's token is the credential, so it is taken out of the URL that error
// logs record before anything else can fail.
const takeEmailToken: RequestHandler = (req, res, next) => {
  const token = String(req.params.token ?? "");
  res.locals.intakeEmailToken = token;
  if (token) req.originalUrl = req.originalUrl.split(token).join(":token");
  next();
};

// Postmark posts each email, attachments included, as one JSON document.
intakeWebhooksRouter.post(
  "/email/:token",
  takeEmailToken,
  express.json({ limit: "50mb" }),
  asyncRoute(async (req, res) => {
    const result = await receiveInboundEmail(
      createServerSupabase(),
      res.locals.intakeEmailToken,
      req.body,
    );
    if (!result.ok) return void sendServiceFailure(res, result);
    res.json(result.data);
  }),
);

intakeWebhooksRouter.use(routerErrorHandler("[intake-webhooks]"));
