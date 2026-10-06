import { and, asc, eq, isNull } from "drizzle-orm";

import type { dbClient } from "@kan/db/client";
import { cardLinks } from "@kan/db/schema";
import { generateUID } from "@kan/shared/utils";

export const create = async (
  db: dbClient,
  linkInput: {
    cardId: number;
    url: string;
    title: string | null;
    createdBy: string;
  },
) => {
  const [result] = await db
    .insert(cardLinks)
    .values({
      publicId: generateUID(),
      cardId: linkInput.cardId,
      url: linkInput.url,
      title: linkInput.title,
      createdBy: linkInput.createdBy,
    })
    .returning({
      id: cardLinks.id,
      publicId: cardLinks.publicId,
      url: cardLinks.url,
      title: cardLinks.title,
      createdAt: cardLinks.createdAt,
    });

  return result;
};

export const getByPublicId = (db: dbClient, publicId: string) => {
  return db.query.cardLinks.findFirst({
    where: and(eq(cardLinks.publicId, publicId), isNull(cardLinks.deletedAt)),
    with: {
      card: {
        columns: {
          id: true,
          publicId: true,
        },
        with: {
          list: {
            columns: {
              id: true,
            },
            with: {
              board: {
                columns: {
                  id: true,
                  workspaceId: true,
                },
              },
            },
          },
        },
      },
    },
  });
};

export const getAllByCardId = (db: dbClient, cardId: number) => {
  return db.query.cardLinks.findMany({
    columns: {
      publicId: true,
      url: true,
      title: true,
      createdAt: true,
    },
    where: and(eq(cardLinks.cardId, cardId), isNull(cardLinks.deletedAt)),
    orderBy: asc(cardLinks.createdAt),
  });
};

export const softDelete = async (
  db: dbClient,
  args: {
    linkId: number;
    deletedAt: Date;
  },
) => {
  const [result] = await db
    .update(cardLinks)
    .set({ deletedAt: args.deletedAt })
    .where(eq(cardLinks.id, args.linkId))
    .returning({ id: cardLinks.id });

  return result;
};
