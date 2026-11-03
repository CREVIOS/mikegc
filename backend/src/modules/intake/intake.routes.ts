import { Router, type Response } from "express";
import { requireAuth } from "../../middleware/auth";
import { asyncRoute, routerErrorHandler } from "../../middleware/asyncRoute";
import { createServerSupabase } from "../../lib/supabase";
import {
  sendServiceFailure,
  type ServiceResult,
} from "../../lib/serviceResult";
import {
  commandIntakeRequest,
  editIntakeRequest,
  getIntakeDashboard,
  getIntakeRequest,
  listIntakeDocuments,
  copyIntakeDocuments,
  generateIntakeEmailWebhook,
  getIntakeAutomation,
  listIntakeEvents,
  listIntakeMembers,
  listIntakeRequesters,
  listIntakeMessages,
  listIntakeRequests,
  resolveIntakeOrg,
  submitIntakeRequest,
  updateIntakeAutomation,
  type IntakeScope,
} from "./intake.service";
import {
  automationUpdateProblem,
  intakeAutomationUpdate,
  intakeCommands,
  intakeDashboardQuery,
  intakeDocumentCopy,
  intakeEdit,
  intakeId,
  intakeList,
  intakePage,
  intakeSubmit,
  intakeWorkspace,
  type IntakeCommandAction,
} from "./intake.validation";

export const intakeRouter = Router();
intakeRouter.use(requireAuth);
// A team organization's id, or "personal" for the caller's own workspace,
// which is resolved here so every handler works with an organization id.
intakeRouter.param("orgId", (req, res, next, value) => {
  if (!intakeWorkspace.safeParse(value).success)
    return void res.status(400).json({ detail: "Invalid organization ID." });
  resolveIntakeOrg(createServerSupabase(), res.locals.userId, value).then(
    (result) => {
      if (!result.ok) return void sendServiceFailure(res, result);
      res.locals.intakeOrgId = result.data;
      next();
    },
    next,
  );
});
intakeRouter.param("requestId", (req, res, next, value) => {
  if (!intakeId.safeParse(value).success)
    return void res.status(400).json({ detail: "Invalid request ID." });
  next();
});
/** The actor always comes from authentication, never from the request body. */
const scopeOf = (res: Response): IntakeScope => ({
  orgId: res.locals.intakeOrgId,
  actorId: res.locals.userId,
});
function send<T>(res: Response, result: ServiceResult<T>, status = 200) {
  if (!result.ok) return void sendServiceFailure(res, result);
  res.status(status).json(result.data);
}

intakeRouter.get(
  "/:orgId/members",
  asyncRoute(async (req, res) => {
    send(
      res,
      await listIntakeMembers(
        createServerSupabase(),
        scopeOf(res),
      ),
    );
  }),
);
intakeRouter.get(
  "/:orgId/requesters",
  asyncRoute(async (req, res) => {
    send(
      res,
      await listIntakeRequesters(createServerSupabase(), scopeOf(res)),
    );
  }),
);
intakeRouter.get(
  "/:orgId/dashboard",
  asyncRoute(async (req, res) => {
    const parsed = intakeDashboardQuery.safeParse(req.query);
    if (!parsed.success)
      return void res
        .status(400)
        .json({ detail: "Invalid timezone or period." });
    const { timezone, ...periods } = parsed.data;
    send(
      res,
      await getIntakeDashboard(
        createServerSupabase(),
        scopeOf(res),
        timezone,
        periods,
      ),
    );
  }),
);
// Automated intake's settings: owners and admins only, which the service checks.
intakeRouter.get(
  "/:orgId/automation",
  asyncRoute(async (req, res) => {
    send(res, await getIntakeAutomation(createServerSupabase(), scopeOf(res)));
  }),
);
intakeRouter.patch(
  "/:orgId/automation",
  asyncRoute(async (req, res) => {
    const parsed = intakeAutomationUpdate.safeParse(req.body);
    if (!parsed.success)
      return void res
        .status(400)
        .json({ detail: automationUpdateProblem(parsed.error) });
    send(
      res,
      await updateIntakeAutomation(
        createServerSupabase(),
        scopeOf(res),
        parsed.data,
      ),
    );
  }),
);
intakeRouter.post(
  "/:orgId/automation/email-webhook",
  asyncRoute(async (req, res) => {
    send(
      res,
      await generateIntakeEmailWebhook(createServerSupabase(), scopeOf(res)),
      201,
    );
  }),
);
intakeRouter.get(
  "/:orgId/requests",
  asyncRoute(async (req, res) => {
    const parsed = intakeList.safeParse(req.query);
    if (!parsed.success)
      return void res.status(400).json({ detail: "Invalid request filters." });
    send(
      res,
      await listIntakeRequests(
        createServerSupabase(),
        scopeOf(res),
        parsed.data,
      ),
    );
  }),
);
intakeRouter.post(
  "/:orgId/requests",
  asyncRoute(async (req, res) => {
    const parsed = intakeSubmit.safeParse(req.body);
    if (!parsed.success)
      return void res.status(400).json({
        detail:
          "Enter a subject, the request, the requester's name and a valid email and target date if needed.",
      });
    const result = await submitIntakeRequest(
      createServerSupabase(),
      scopeOf(res),
      parsed.data,
    );
    send(res, result, result.ok && !result.data.replayed ? 201 : 200);
  }),
);
intakeRouter.get(
  "/:orgId/requests/:requestId",
  asyncRoute(async (req, res) => {
    send(
      res,
      await getIntakeRequest(
        createServerSupabase(),
        scopeOf(res),
        req.params.requestId,
      ),
    );
  }),
);
intakeRouter.patch(
  "/:orgId/requests/:requestId",
  asyncRoute(async (req, res) => {
    const parsed = intakeEdit.safeParse(req.body);
    if (!parsed.success)
      return void res.status(400).json({ detail: "Check the request details." });
    send(
      res,
      await editIntakeRequest(
        createServerSupabase(),
        scopeOf(res),
        req.params.requestId,
        parsed.data,
      ),
    );
  }),
);
intakeRouter.post(
  "/:orgId/requests/:requestId/documents/copy",
  asyncRoute(async (req, res) => {
    const parsed = intakeDocumentCopy.safeParse(req.body);
    if (!parsed.success)
      return void res.status(400).json({ detail: "Invalid documents." });
    send(
      res,
      await copyIntakeDocuments(
        createServerSupabase(),
        { ...scopeOf(res), userEmail: res.locals.userEmail },
        req.params.requestId,
        parsed.data.document_ids,
        parsed.data.message_id,
        // Personal intake takes the actor's own unfiled documents.
        req.params.orgId === "personal" ? null : res.locals.intakeOrgId,
      ),
      201,
    );
  }),
);
intakeRouter.get(
  "/:orgId/requests/:requestId/documents",
  asyncRoute(async (req, res) => {
    send(
      res,
      await listIntakeDocuments(
        createServerSupabase(),
        scopeOf(res),
        req.params.requestId,
      ),
    );
  }),
);
for (const [path, read] of [
  ["messages", listIntakeMessages],
  ["events", listIntakeEvents],
] as const) {
  intakeRouter.get(
    `/:orgId/requests/:requestId/${path}`,
    asyncRoute(async (req, res) => {
      const parsed = intakePage.safeParse(req.query);
      if (!parsed.success)
        return void res.status(400).json({ detail: "Invalid page." });
      const result: ServiceResult<unknown[]> = await read(
        createServerSupabase(),
        scopeOf(res),
        req.params.requestId,
        parsed.data,
      );
      send(res, result);
    }),
  );
}
for (const action of Object.keys(intakeCommands) as IntakeCommandAction[]) {
  intakeRouter.post(
    `/:orgId/requests/:requestId/${action}`,
    asyncRoute(async (req, res) => {
      const parsed = intakeCommands[action].safeParse(req.body);
      if (!parsed.success)
        return void res
          .status(400)
          .json({ detail: "Check the command and note fields." });
      send(
        res,
        await commandIntakeRequest(
          createServerSupabase(),
          scopeOf(res),
          req.params.requestId,
          action,
          parsed.data,
        ),
      );
    }),
  );
}
intakeRouter.use(routerErrorHandler("[intake]"));
