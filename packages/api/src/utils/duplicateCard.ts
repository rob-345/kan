import type { dbClient } from "@kan/db/client";
import * as cardRepo from "@kan/db/repository/card.repo";
import * as cardActivityRepo from "@kan/db/repository/cardActivity.repo";
import * as checklistRepo from "@kan/db/repository/checklist.repo";
import * as labelRepo from "@kan/db/repository/label.repo";
import * as workspaceRepo from "@kan/db/repository/workspace.repo";
import { normalizeDescription } from "@kan/shared/utils";

type SourceCard = NonNullable<
  Awaited<ReturnType<typeof cardRepo.getWithListAndMembersByPublicId>>
>;

/**
 * Copies a card into a list, optionally with its labels, members and
 * checklists. Used by card duplication and list copying.
 */
export async function duplicateCard({
  db,
  sourceCard,
  targetList,
  userId,
  index,
  title,
  copyLabels,
  copyMembers,
  copyChecklists,
}: {
  db: dbClient;
  sourceCard: SourceCard;
  targetList: { id: number; workspaceId: number };
  userId: string;
  index?: number;
  title?: string;
  copyLabels: boolean;
  copyMembers: boolean;
  copyChecklists: boolean;
}) {
  const newCard = await cardRepo.create(db, {
    title: title ?? sourceCard.title,
    description: normalizeDescription(sourceCard.description),
    createdBy: userId,
    listId: targetList.id,
    workspaceId: targetList.workspaceId,
    position: "end",
    dueDate: sourceCard.dueDate ?? null,
  });

  if (index !== undefined && index >= 0) {
    await cardRepo.reorder(db, {
      cardId: newCard.id,
      newIndex: index,
      newListId: targetList.id,
    });
  }

  if (copyLabels && sourceCard.labels?.length) {
    const labelPublicIds = sourceCard.labels.map((l) => l.publicId);
    const labels = await labelRepo.getAllByPublicIds(db, labelPublicIds);
    if (labels.length) {
      const labelsInsert = labels.map((label) => ({
        cardId: newCard.id,
        labelId: label.id,
      }));
      await cardRepo.bulkCreateCardLabelRelationships(db, labelsInsert);
      const cardActivitesInsert = labels.map((cardLabel) => ({
        type: "card.updated.label.added" as const,
        cardId: newCard.id,
        labelId: cardLabel.id,
        createdBy: userId,
      }));
      await cardActivityRepo.bulkCreate(db, cardActivitesInsert);
    }
  }

  if (copyMembers && sourceCard.members?.length) {
    const memberPublicIds = sourceCard.members.map((m) => m.publicId);
    const members = await workspaceRepo.getAllMembersByPublicIds(
      db,
      memberPublicIds,
      targetList.workspaceId,
    );
    if (members.length) {
      const membersInsert = members.map((member) => ({
        cardId: newCard.id,
        workspaceMemberId: member.id,
      }));
      await cardRepo.bulkCreateCardWorkspaceMemberRelationships(
        db,
        membersInsert,
      );
      const cardActivitesInsert = members.map((member) => ({
        type: "card.updated.member.added" as const,
        cardId: newCard.id,
        workspaceMemberId: member.id,
        createdBy: userId,
      }));
      await cardActivityRepo.bulkCreate(db, cardActivitesInsert);
    }
  }

  if (copyChecklists && sourceCard.checklists?.length) {
    for (const checklist of sourceCard.checklists) {
      const newChecklist = await checklistRepo.create(db, {
        cardId: newCard.id,
        name: checklist.name,
        createdBy: userId,
      });
      if (!newChecklist?.id) continue;
      if (checklist.items?.length) {
        for (const item of checklist.items) {
          await checklistRepo.createItem(db, {
            checklistId: newChecklist.id,
            title: item.title,
            createdBy: userId,
            completed: false,
          });
        }
      }
      await cardActivityRepo.create(db, {
        type: "card.updated.checklist.added",
        cardId: newCard.id,
        toTitle: newChecklist.name,
        createdBy: userId,
      });
    }
  }

  if (
    sourceCard.startDate ||
    sourceCard.coverColour ||
    sourceCard.dueReminderMinutes != null
  ) {
    await cardRepo.update(
      db,
      {
        startDate: sourceCard.startDate,
        coverColour: sourceCard.coverColour,
        dueReminderMinutes: sourceCard.dueReminderMinutes,
      },
      { cardPublicId: newCard.publicId },
    );
  }

  return newCard;
}
