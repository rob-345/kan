import { t } from "@lingui/core/macro";

import Button from "~/components/Button";
import FeedbackModal from "~/components/FeedbackModal";
import Modal from "~/components/modal";
import { NewWorkspaceForm } from "~/components/NewWorkspaceForm";
import { PageHead } from "~/components/PageHead";
import { useModal } from "~/providers/modal";
import { useWorkspace } from "~/providers/workspace";
import { DeleteGoogleChatSpaceConfirmation } from "./components/DeleteGoogleChatSpaceConfirmation";
import GoogleChatSpaceList from "./components/GoogleChatSpaceList";
import { GoogleChatSpaceModal } from "./components/GoogleChatSpaceModal";

export default function GoogleChatSettings() {
  const { modalContentType, openModal, isOpen } = useModal();
  const { workspace } = useWorkspace();

  return (
    <>
      <PageHead title={t`Settings | Google Chat`} />

      <div className="mb-8 border-t border-light-300 dark:border-dark-300">
        <h2 className="mb-4 mt-8 text-[14px] font-bold text-neutral-900 dark:text-dark-1000">
          {t`Google Chat`}
        </h2>
        <p className="mb-8 text-sm text-neutral-500 dark:text-dark-900">
          {t`Post card updates to Google Chat spaces: new cards, moves, comments, completed cards and due date reminders. Messages about the same card are grouped into one thread.`}
        </p>

        <div className="mb-4 flex items-center justify-between">
          <Button
            variant="primary"
            onClick={() => openModal("NEW_GOOGLE_CHAT_SPACE")}
          >
            {t`Add space`}
          </Button>
        </div>

        <GoogleChatSpaceList workspacePublicId={workspace.publicId} />
      </div>

      <Modal
        modalSize="md"
        isVisible={isOpen && modalContentType === "NEW_GOOGLE_CHAT_SPACE"}
      >
        <GoogleChatSpaceModal workspacePublicId={workspace.publicId} />
      </Modal>
      <Modal
        modalSize="md"
        isVisible={isOpen && modalContentType === "EDIT_GOOGLE_CHAT_SPACE"}
      >
        <GoogleChatSpaceModal workspacePublicId={workspace.publicId} isEdit />
      </Modal>
      <Modal
        modalSize="sm"
        isVisible={isOpen && modalContentType === "DELETE_GOOGLE_CHAT_SPACE"}
      >
        <DeleteGoogleChatSpaceConfirmation
          workspacePublicId={workspace.publicId}
        />
      </Modal>

      {/* Global modals */}
      <Modal
        modalSize="md"
        isVisible={isOpen && modalContentType === "NEW_FEEDBACK"}
      >
        <FeedbackModal />
      </Modal>
      <Modal
        modalSize="sm"
        isVisible={isOpen && modalContentType === "NEW_WORKSPACE"}
      >
        <NewWorkspaceForm />
      </Modal>
    </>
  );
}
