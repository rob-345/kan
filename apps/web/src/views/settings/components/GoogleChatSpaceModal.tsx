import { zodResolver } from "@hookform/resolvers/zod";
import { t } from "@lingui/core/macro";
import { useEffect } from "react";
import { Controller, useForm } from "react-hook-form";
import { HiXMark } from "react-icons/hi2";
import { z } from "zod";

import type { GoogleChatEvent } from "@kan/db/schema";
import { googleChatEvents } from "@kan/db/schema";

import Button from "~/components/Button";
import Input from "~/components/Input";
import { useModal } from "~/providers/modal";
import { usePopup } from "~/providers/popup";
import { api } from "~/utils/api";
import {
  defaultGoogleChatEvents,
  getGoogleChatEventLabels,
} from "./googleChatEventLabels";

const CHAT_WEBHOOK_PREFIX = "https://chat.googleapis.com/v1/spaces/";

export interface GoogleChatSpaceModalState {
  publicId: string;
  name: string;
  boardPublicId: string | null;
  events: GoogleChatEvent[];
  active: boolean;
}

interface GoogleChatSpaceModalProps {
  workspacePublicId: string;
  isEdit?: boolean;
}

export function GoogleChatSpaceModal({
  workspacePublicId,
  isEdit = false,
}: GoogleChatSpaceModalProps) {
  const { closeModal, getModalState, clearModalState } = useModal();
  const { showPopup } = usePopup();
  const utils = api.useUtils();

  const modalState = isEdit
    ? (getModalState("EDIT_GOOGLE_CHAT_SPACE") as
        | GoogleChatSpaceModalState
        | undefined)
    : undefined;

  const schema = z.object({
    name: z
      .string()
      .trim()
      .min(1, { message: t`Name is required` })
      .max(255, { message: t`Name cannot exceed 255 characters` }),
    // Optional when editing: blank keeps the saved webhook URL
    webhookUrl: z
      .string()
      .trim()
      .refine(
        (value) =>
          (isEdit && value === "") || value.startsWith(CHAT_WEBHOOK_PREFIX),
        {
          message: t`Paste the webhook URL from Google Chat. It starts with ${CHAT_WEBHOOK_PREFIX}`,
        },
      ),
    boardPublicId: z.string(),
    events: z
      .array(z.enum(googleChatEvents))
      .min(1, { message: t`Select at least one event` }),
    active: z.boolean(),
  });
  type FormValues = z.infer<typeof schema>;

  const {
    register,
    handleSubmit,
    control,
    reset,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: "",
      webhookUrl: "",
      boardPublicId: "",
      events: defaultGoogleChatEvents,
      active: true,
    },
  });

  useEffect(() => {
    if (isEdit && modalState) {
      reset({
        name: modalState.name,
        webhookUrl: "",
        boardPublicId: modalState.boardPublicId ?? "",
        events: modalState.events,
        active: modalState.active,
      });
    }
  }, [isEdit, modalState, reset]);

  useEffect(() => {
    return () => {
      if (isEdit) clearModalState("EDIT_GOOGLE_CHAT_SPACE");
    };
  }, [isEdit, clearModalState]);

  const { data: boards } = api.board.all.useQuery(
    { workspacePublicId, type: "regular" },
    { enabled: workspacePublicId.length >= 12 },
  );

  const onSuccess = (header: string, message: string) => {
    void utils.googleChat.list.invalidate({ workspacePublicId });
    showPopup({ header, message, icon: "success" });
    closeModal();
  };
  const onError = (header: string) => (error: { message: string }) => {
    showPopup({ header, message: error.message, icon: "error" });
  };

  const createSpace = api.googleChat.create.useMutation({
    onSuccess: () =>
      onSuccess(
        t`Google Chat space added`,
        t`Use Test to check that messages arrive.`,
      ),
    onError: onError(t`Unable to add Google Chat space`),
  });
  const updateSpace = api.googleChat.update.useMutation({
    onSuccess: () =>
      onSuccess(t`Google Chat space updated`, t`Your changes are saved.`),
    onError: onError(t`Unable to update Google Chat space`),
  });

  const onSubmit = (values: FormValues) => {
    const boardPublicId = values.boardPublicId || null;
    if (isEdit && modalState) {
      updateSpace.mutate({
        workspacePublicId,
        spacePublicId: modalState.publicId,
        name: values.name,
        webhookUrl: values.webhookUrl || undefined,
        boardPublicId,
        events: values.events,
        active: values.active,
      });
    } else {
      createSpace.mutate({
        workspacePublicId,
        name: values.name,
        webhookUrl: values.webhookUrl,
        boardPublicId,
        events: values.events,
      });
    }
  };

  const eventLabels = getGoogleChatEventLabels();

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      <div className="px-5 pt-5">
        <div className="flex w-full items-center justify-between pb-4 text-neutral-900 dark:text-dark-1000">
          <h2 className="text-sm font-bold">
            {isEdit ? t`Edit Google Chat space` : t`Add Google Chat space`}
          </h2>
          <button
            type="button"
            className="rounded p-1 hover:bg-light-300 focus:outline-none dark:hover:bg-dark-300"
            onClick={(e) => {
              e.preventDefault();
              closeModal();
            }}
          >
            <HiXMark size={18} className="text-light-900 dark:text-dark-900" />
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label
              htmlFor="google-chat-name"
              className="mb-1 block text-sm font-medium text-light-900 dark:text-dark-900"
            >
              {t`Name`}
            </label>
            <Input
              id="google-chat-name"
              placeholder={t`Product team`}
              {...register("name")}
              errorMessage={errors.name?.message}
            />
          </div>

          <div>
            <label
              htmlFor="google-chat-url"
              className="mb-1 block text-sm font-medium text-light-900 dark:text-dark-900"
            >
              {t`Webhook URL`}
            </label>
            <Input
              id="google-chat-url"
              type="password"
              autoComplete="off"
              placeholder={
                isEdit
                  ? t`Leave blank to keep the current URL`
                  : `${CHAT_WEBHOOK_PREFIX}…`
              }
              {...register("webhookUrl")}
              errorMessage={errors.webhookUrl?.message}
            />
            <p className="mt-1 text-xs text-neutral-500 dark:text-dark-800">
              {t`In Google Chat, open the space, then Apps & integrations → Webhooks → Add webhook, and copy its URL.`}
            </p>
          </div>

          <div>
            <label
              htmlFor="google-chat-board"
              className="mb-1 block text-sm font-medium text-light-900 dark:text-dark-900"
            >
              {t`Board`}
            </label>
            <select
              id="google-chat-board"
              {...register("boardPublicId")}
              className="block w-full rounded-md border-0 bg-dark-300 bg-white/5 py-1.5 text-sm shadow-sm ring-1 ring-inset ring-light-600 placeholder:text-dark-800 focus:ring-2 focus:ring-inset focus:ring-light-700 dark:text-dark-1000 dark:ring-dark-700 dark:focus:ring-dark-700 sm:leading-6"
            >
              <option value="">{t`All boards`}</option>
              {boards?.map((board) => (
                <option key={board.publicId} value={board.publicId}>
                  {board.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <p className="mb-2 block text-sm font-medium text-light-900 dark:text-dark-900">
              {t`Post a message when`}
            </p>
            <Controller
              name="events"
              control={control}
              render={({ field }) => (
                <div className="space-y-2">
                  {googleChatEvents.map((event) => (
                    <label
                      key={event}
                      className="flex cursor-pointer items-center space-x-2"
                    >
                      <input
                        type="checkbox"
                        checked={field.value.includes(event)}
                        onChange={(e) =>
                          field.onChange(
                            e.target.checked
                              ? [...field.value, event]
                              : field.value.filter((v) => v !== event),
                          )
                        }
                        className="text-primary-600 focus:ring-primary-500 h-4 w-4 rounded border-light-400 dark:border-dark-400"
                      />
                      <span className="text-sm text-light-900 dark:text-dark-900">
                        {eventLabels[event]}
                      </span>
                    </label>
                  ))}
                </div>
              )}
            />
            {errors.events && (
              <p className="mt-1 text-xs text-red-500">
                {errors.events.message}
              </p>
            )}
          </div>

          {isEdit && (
            <label className="flex cursor-pointer items-center space-x-2">
              <input
                type="checkbox"
                {...register("active")}
                className="text-primary-600 focus:ring-primary-500 h-4 w-4 rounded border-light-400 dark:border-dark-400"
              />
              <span className="text-sm text-light-900 dark:text-dark-900">
                {t`Active`}
              </span>
            </label>
          )}
        </div>
      </div>

      <div className="mt-8 flex items-center justify-end border-t border-light-600 px-5 pb-5 pt-5 dark:border-dark-600">
        <Button
          type="submit"
          isLoading={createSpace.isPending || updateSpace.isPending}
        >
          {isEdit ? t`Save changes` : t`Add space`}
        </Button>
      </div>
    </form>
  );
}
