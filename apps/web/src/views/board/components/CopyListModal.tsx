import { t } from "@lingui/core/macro";
import { useState } from "react";

import Button from "~/components/Button";
import Input from "~/components/Input";
import { useModal } from "~/providers/modal";
import { usePopup } from "~/providers/popup";
import { api } from "~/utils/api";

export function CopyListModal() {
  const { entityId: listPublicId, entityLabel, closeModal } = useModal();
  const { showPopup } = usePopup();
  const utils = api.useUtils();
  const [name, setName] = useState(entityLabel ? t`${entityLabel} (copy)` : "");

  const copyList = api.list.copy.useMutation({
    onSuccess: async () => {
      closeModal();
      await utils.board.byId.invalidate();
    },
    onError: () => {
      showPopup({
        header: t`Unable to copy list`,
        message: t`Please try again later, or contact customer support.`,
        icon: "error",
      });
    },
  });

  return (
    <form
      className="p-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (!listPublicId || !name.trim()) return;
        copyList.mutate({ listPublicId, name: name.trim() });
      }}
    >
      <h2 className="text-md mb-1 font-medium text-neutral-900 dark:text-dark-1000">
        {t`Copy list`}
      </h2>
      <p className="mb-4 text-sm text-light-900 dark:text-dark-900">
        {t`The copy keeps every card with its labels, members and checklists.`}
      </p>
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        aria-label={t`List name`}
        autoFocus
      />
      <div className="mt-5 flex justify-end space-x-2">
        <Button type="button" variant="secondary" onClick={() => closeModal()}>
          {t`Cancel`}
        </Button>
        <Button
          type="submit"
          isLoading={copyList.isPending}
          disabled={!name.trim()}
        >
          {t`Copy list`}
        </Button>
      </div>
    </form>
  );
}
