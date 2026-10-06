import { attachmentRouter } from "./routers/attachment";
import { boardRouter } from "./routers/board";
import { cardRouter } from "./routers/card";
import { checklistRouter } from "./routers/checklist";
import { driveFileRouter } from "./routers/driveFile";
import { feedbackRouter } from "./routers/feedback";
import { googleChatRouter } from "./routers/googleChat";
import { googleIntegrationRouter } from "./routers/googleIntegration";
import { healthRouter } from "./routers/health";
import { importRouter } from "./routers/import";
import { integrationRouter } from "./routers/integration";
import { labelRouter } from "./routers/label";
import { linkRouter } from "./routers/link";
import { listRouter } from "./routers/list";
import { memberRouter } from "./routers/member";
import { notificationRouter } from "./routers/notification";
import { permissionRouter } from "./routers/permission";
import { userRouter } from "./routers/user";
import { webhookRouter } from "./routers/webhook";
import { workspaceRouter } from "./routers/workspace";
import { createTRPCRouter } from "./trpc";

export const appRouter = createTRPCRouter({
  attachment: attachmentRouter,
  board: boardRouter,
  card: cardRouter,
  checklist: checklistRouter,
  driveFile: driveFileRouter,
  feedback: feedbackRouter,
  googleChat: googleChatRouter,
  googleIntegration: googleIntegrationRouter,
  health: healthRouter,
  label: labelRouter,
  link: linkRouter,
  list: listRouter,
  member: memberRouter,
  notification: notificationRouter,
  import: importRouter,
  permission: permissionRouter,
  user: userRouter,
  webhook: webhookRouter,
  workspace: workspaceRouter,
  integration: integrationRouter,
});

export type AppRouter = typeof appRouter;
