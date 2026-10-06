import type { NextApiRequest, NextApiResponse } from "next";

import { withApiLogging } from "@kan/api/utils/apiLogging";
import {
  buildChatResponse,
  getChatAppConfig,
  handleChatAppEvent,
  normalizeChatEvent,
  verifyChatRequest,
} from "@kan/api/utils/google/chatApp";
import { withRateLimit } from "@kan/api/utils/rateLimit";
import { createDrizzleClient } from "@kan/db/client";
import { createLogger } from "@kan/logger";

const log = createLogger("google-chat-app");
const db = createDrizzleClient();

/**
 * The HTTP endpoint of the Kan app for Google Chat. Google posts here when
 * someone messages or mentions the app, or adds or removes it from a space,
 * and shows the JSON reply in Chat.
 */
export default withRateLimit(
  { points: 300, duration: 60 },
  withApiLogging(async (req: NextApiRequest, res: NextApiResponse) => {
    if (req.method !== "POST") {
      return res.status(405).json({ message: "Method not allowed" });
    }

    if (!getChatAppConfig()) {
      return res
        .status(503)
        .json({ message: "The Google Chat app isn't set up" });
    }

    if (!(await verifyChatRequest(req.headers.authorization))) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const event = normalizeChatEvent(req.body);
    if (!event) {
      return res.status(400).json({ message: "Not a Google Chat event" });
    }

    try {
      const text = await handleChatAppEvent(db, event);
      return res.status(200).json(buildChatResponse(event, text));
    } catch (error) {
      log.error({ err: error, type: event.type }, "Chat app event failed");
      return res
        .status(200)
        .json(
          buildChatResponse(
            event,
            "Something went wrong on my side. Please try again.",
          ),
        );
    }
  }),
);
