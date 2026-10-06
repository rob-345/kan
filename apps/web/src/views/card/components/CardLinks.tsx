import { t } from "@lingui/core/macro";
import { useEffect, useRef, useState } from "react";
import {
  HiArrowPath,
  HiEllipsisHorizontal,
  HiOutlineLink,
  HiOutlineTrash,
} from "react-icons/hi2";

import Button from "~/components/Button";
import Dropdown from "~/components/Dropdown";
import Input from "~/components/Input";
import { LinkPreview } from "~/components/LinkPreview";
import { usePopup } from "~/providers/popup";
import { api } from "~/utils/api";
import { invalidateCard } from "~/utils/cardInvalidation";

interface CardLink {
  publicId: string;
  url: string;
  title: string | null;
}

export function CardLinks({
  links,
  cardPublicId,
  isReadOnly = false,
  isAdding,
  setIsAdding,
}: {
  links: CardLink[];
  cardPublicId: string;
  isReadOnly?: boolean;
  isAdding: boolean;
  setIsAdding: (value: boolean) => void;
}) {
  if (links.length === 0 && (!isAdding || isReadOnly)) return null;

  return (
    <div className="mt-6">
      <h2 className="text-md mb-3 flex items-center gap-2 font-medium text-light-1000 dark:text-dark-1000">
        <HiOutlineLink className="h-4 w-4" />
        {t`Links`}
      </h2>
      <div className="flex flex-col gap-2">
        {links.map((link) => (
          <CardLinkItem
            key={link.publicId}
            link={link}
            cardPublicId={cardPublicId}
            isReadOnly={isReadOnly}
          />
        ))}
      </div>
      {!isReadOnly && isAdding && (
        <NewLinkForm
          cardPublicId={cardPublicId}
          onDone={() => setIsAdding(false)}
        />
      )}
      {!isReadOnly && !isAdding && links.length > 0 && (
        <div className="mt-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            iconLeft={<HiOutlineLink className="h-4 w-4" />}
            onClick={() => setIsAdding(true)}
          >
            {t`Add link`}
          </Button>
        </div>
      )}
    </div>
  );
}

function CardLinkItem({
  link,
  cardPublicId,
  isReadOnly,
}: {
  link: CardLink;
  cardPublicId: string;
  isReadOnly: boolean;
}) {
  const utils = api.useUtils();
  const { showPopup } = usePopup();

  const removeLink = api.link.delete.useMutation({
    onMutate: async () => {
      await utils.card.byId.cancel({ cardPublicId });
      const previousState = utils.card.byId.getData({ cardPublicId });
      utils.card.byId.setData({ cardPublicId }, (oldCard) =>
        oldCard
          ? {
              ...oldCard,
              links: oldCard.links.filter(
                (existing) => existing.publicId !== link.publicId,
              ),
            }
          : oldCard,
      );
      return { previousState };
    },
    onError: (_error, _args, context) => {
      utils.card.byId.setData({ cardPublicId }, context?.previousState);
      showPopup({
        header: t`Unable to remove link`,
        message: t`Please try again later, or contact customer support.`,
        icon: "error",
      });
    },
    onSettled: async () => {
      await invalidateCard(utils, cardPublicId);
    },
  });

  const refreshPreview = api.link.refresh.useMutation({
    onSuccess: (preview) => {
      utils.link.preview.setData({ url: link.url }, preview);
    },
    onError: () => {
      showPopup({
        header: t`Unable to refresh preview`,
        message: t`Please try again later.`,
        icon: "error",
      });
    },
  });

  const actions = isReadOnly ? undefined : (
    <div className="rounded-[5px] bg-light-50/80 dark:bg-dark-100/80">
      <Dropdown
        ariaLabel={t`Link options`}
        items={[
          {
            label: t`Refresh preview`,
            action: () =>
              refreshPreview.mutate({ linkPublicId: link.publicId }),
            icon: <HiArrowPath className="h-[16px] w-[16px] text-dark-900" />,
          },
          {
            label: t`Remove link`,
            action: () => removeLink.mutate({ linkPublicId: link.publicId }),
            icon: (
              <HiOutlineTrash className="h-[16px] w-[16px] text-dark-900" />
            ),
          },
        ]}
      >
        <HiEllipsisHorizontal className="h-5 w-5 text-light-900 dark:text-dark-800" />
      </Dropdown>
    </div>
  );

  return <LinkPreview url={link.url} title={link.title} actions={actions} />;
}

function NewLinkForm({
  cardPublicId,
  onDone,
}: {
  cardPublicId: string;
  onDone: () => void;
}) {
  const utils = api.useUtils();
  const { showPopup } = usePopup();
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const urlInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    urlInputRef.current?.focus();
  }, []);

  const addLink = api.link.add.useMutation({
    onSuccess: async (link) => {
      utils.link.preview.setData({ url: link.url }, link.preview);
      await invalidateCard(utils, cardPublicId);
      setUrl("");
      setTitle("");
      onDone();
    },
    onError: (error) => {
      showPopup({
        header: t`Unable to add link`,
        message:
          error.data?.code === "BAD_REQUEST"
            ? t`Enter a valid web address, like https://example.com.`
            : t`Please try again later, or contact customer support.`,
        icon: "error",
      });
    },
  });

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!url.trim()) return;
    addLink.mutate({
      cardPublicId,
      url: url.trim(),
      title: title.trim() || undefined,
    });
  };

  return (
    <form
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key === "Escape") onDone();
      }}
      className="mt-2 flex flex-col gap-2 rounded-lg border border-light-300 p-3 dark:border-dark-400"
    >
      <Input
        ref={urlInputRef}
        type="text"
        inputMode="url"
        value={url}
        onChange={(event) => setUrl(event.target.value)}
        placeholder={t`Paste a link, e.g. https://example.com`}
        aria-label={t`Link address`}
      />
      <Input
        type="text"
        value={title}
        maxLength={255}
        onChange={(event) => setTitle(event.target.value)}
        placeholder={t`Display text (optional)`}
        aria-label={t`Link display text`}
      />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          {t`Cancel`}
        </Button>
        <Button
          type="submit"
          size="sm"
          isLoading={addLink.isPending}
          disabled={!url.trim() || addLink.isPending}
        >
          {t`Add link`}
        </Button>
      </div>
    </form>
  );
}
