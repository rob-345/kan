import type { NextApiRequest, NextApiResponse } from "next";

import { createNextApiContext } from "@kan/api/trpc-context";
import { withApiLogging } from "@kan/api/utils/apiLogging";
import { completeGoogleConnection } from "@kan/api/utils/google/connection";
import { withRateLimit } from "@kan/api/utils/rateLimit";

const queryValue = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value;

/**
 * Google redirects here after the person approves (or declines) access to
 * their Calendar and Tasks, or to the Drive files they pick. Sends them back
 * to their account settings, or to the card they started from, with the
 * outcome in the query string.
 */
export default withRateLimit(
  { points: 30, duration: 60 },
  withApiLogging(async (req: NextApiRequest, res: NextApiResponse) => {
    if (req.method !== "GET") {
      return res.status(405).json({ message: "Method not allowed" });
    }

    const { user, db } = await createNextApiContext(req);

    if (!user) {
      return res.redirect(302, "/login");
    }

    const result = await completeGoogleConnection(db, {
      userId: user.id,
      code: queryValue(req.query.code),
      state: queryValue(req.query.state),
      error: queryValue(req.query.error),
    });

    const key = result.purpose === "drive" ? "googleDrive" : "google";
    const outcome: Record<string, string> = result.ok
      ? { [key]: "connected" }
      : { [key]: "error", reason: result.reason };

    // returnTo was checked to be a path on this site when the flow started
    const target = new URL(
      result.returnTo ?? "/settings/account",
      "http://kan.invalid",
    );
    for (const [name, value] of Object.entries(outcome)) {
      target.searchParams.set(name, value);
    }
    return res.redirect(302, `${target.pathname}${target.search}`);
  }),
);
