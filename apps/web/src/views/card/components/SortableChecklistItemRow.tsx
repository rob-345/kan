import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import type {
  AssignableMember,
  ChecklistItemScheduleData,
} from "./ChecklistItemSchedule";
import ChecklistItemRow from "./ChecklistItemRow";

type ChecklistItem = ChecklistItemScheduleData & {
  title: string;
  clientId?: string;
};

interface SortableChecklistItemRowProps {
  item: ChecklistItem;
  members: AssignableMember[];
  cardPublicId: string;
  onCreateNewItem: () => void;
  viewOnly: boolean;
}

export default function SortableChecklistItemRow({
  item,
  members,
  cardPublicId,
  onCreateNewItem,
  viewOnly,
}: SortableChecklistItemRowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: item.publicId,
    disabled: viewOnly,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div ref={setNodeRef} style={style}>
      <ChecklistItemRow
        item={item}
        members={members}
        cardPublicId={cardPublicId}
        onCreateNewItem={onCreateNewItem}
        viewOnly={viewOnly}
        dragHandleAttributes={attributes}
        dragHandleListeners={listeners}
        isDragging={isDragging}
      />
    </div>
  );
}
