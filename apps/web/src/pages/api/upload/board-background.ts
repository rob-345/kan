import type { NextApiRequest, NextApiResponse } from "next";
import { Upload } from "@aws-sdk/lib-storage";

import { createNextApiContext } from "@kan/api/trpc-context";
import { withApiLogging } from "@kan/api/utils/apiLogging";
import { deleteUploadedBoardBackground } from "@kan/api/utils/boardBackground";
import { assertCanEdit } from "@kan/api/utils/permissions";
import { withRateLimit } from "@kan/api/utils/rateLimit";
import * as boardRepo from "@kan/db/repository/board.repo";
import {
  BOARD_BACKGROUND_KEY_PREFIX,
  BOARD_BACKGROUND_MAX_BYTES,
} from "@kan/shared/constants";
import { createS3Client, generateUID } from "@kan/shared/utils";

import { env } from "~/env";

const ALLOWED_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
];

export const config = {
  api: {
    bodyParser: false,
  },
};

export default withRateLimit(
  { points: 30, duration: 60 },
  withApiLogging(async (req: NextApiRequest, res: NextApiResponse) => {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    try {
      const { user, db } = await createNextApiContext(req);

      if (!user) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const bucket = env.NEXT_PUBLIC_ATTACHMENTS_BUCKET_NAME;
      if (!bucket) {
        return res.status(500).json({ error: "Storage not configured" });
      }

      const boardPublicId = req.query.boardPublicId;
      if (typeof boardPublicId !== "string" || boardPublicId.length < 12) {
        return res.status(400).json({ error: "Invalid boardPublicId" });
      }

      const contentType = req.headers["content-type"];
      if (
        typeof contentType !== "string" ||
        !ALLOWED_CONTENT_TYPES.includes(contentType)
      ) {
        return res
          .status(400)
          .json({ error: "Background must be a JPEG, PNG, WebP or GIF" });
      }

      const contentLengthHeader = req.headers["content-length"];
      const contentLength = contentLengthHeader
        ? Number.parseInt(contentLengthHeader, 10)
        : NaN;

      if (!Number.isFinite(contentLength) || contentLength <= 0) {
        return res
          .status(400)
          .json({ error: "Missing or invalid content length" });
      }

      if (contentLength > BOARD_BACKGROUND_MAX_BYTES) {
        return res.status(400).json({ error: "File too large" });
      }

      const board = await boardRepo.getWorkspaceAndBoardIdByBoardPublicId(
        db,
        boardPublicId,
      );

      if (!board) {
        return res.status(404).json({ error: "Board not found" });
      }

      try {
        await assertCanEdit(
          db,
          user.id,
          board.workspaceId,
          "board:edit",
          board.createdBy ?? null,
        );
      } catch {
        return res.status(403).json({ error: "Permission denied" });
      }

      const extension = contentType.split("/")[1] ?? "img";
      const s3Key = `${BOARD_BACKGROUND_KEY_PREFIX}${boardPublicId}/${generateUID()}.${extension}`;

      const upload = new Upload({
        client: createS3Client(),
        params: {
          Bucket: bucket,
          Key: s3Key,
          Body: req,
          ContentType: contentType,
          ContentLength: contentLength,
        },
        leavePartsOnError: false,
      });

      await upload.done();

      await boardRepo.update(db, {
        boardPublicId,
        name: undefined,
        slug: undefined,
        visibility: undefined,
        backgroundColour: null,
        backgroundImage: s3Key,
      });

      await deleteUploadedBoardBackground(board.backgroundImage);

      return res.status(200).json({ success: true });
    } catch {
      return res.status(500).json({ error: "Internal server error" });
    }
  }),
);
