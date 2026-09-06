"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { Reorder, useDragControls, type DragControls } from "motion/react";

/**
 * Workspace reorder via a dedicated drag handle on the repo row, built on
 * motion's Reorder: pressing the handle starts the drag immediately (no
 * long-press), the dragged row follows the pointer, siblings spring to their
 * new slots, and the row settles with inertia on drop. Plain clicks elsewhere
 * on the row keep working as the expand-collapse toggle.
 */

export interface RepoDragChrome {
  /** Drag in progress for this row. */
  isDragging: boolean;
  /**
   * Attach to the row's drag handle: a primary-button press starts the drag
   * right away, so the handle must stopPropagation its own click to keep it
   * from reaching the row's toggle handler.
   */
  dragHandleProps: {
    onPointerDown: (event: ReactPointerEvent) => void;
  } | null;
}

interface SortableRowProps<T extends { id?: string }> {
  item: T;
  canReorder: boolean;
  renderItem: (item: T, drag: RepoDragChrome | null) => ReactNode;
  onArm: () => void;
  /** Commit the current preview order if it differs from the base order. */
  onCommit: () => void;
  /** Drag ended without a reorder (handle pressed but never moved). */
  onAbort: () => void;
}

function SortableRow<T extends { id?: string }>({
  item,
  canReorder,
  renderItem,
  onArm,
  onCommit,
  onAbort,
}: SortableRowProps<T>) {
  const controls: DragControls = useDragControls();
  const draggingRef = useRef(false);
  const dragEndedRef = useRef(false);
  const suppressClickRef = useRef(false);
  const [dragging, setDragging] = useState(false);

  const endDrag = useCallback(
    (commit: boolean) => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      setDragging(false);
      if (commit) onCommit();
      else onAbort();
      // Swallow the click the browser fires after the gesture so it never
      // doubles as a row toggle.
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
    },
    [onAbort, onCommit],
  );

  // Keep the latest callback reachable from the pointer handlers without
  // re-binding window listeners on every render.
  const endDragRef = useRef(endDrag);
  endDragRef.current = endDrag;

  const dragHandleProps = useMemo<RepoDragChrome["dragHandleProps"]>(() => {
    if (!canReorder) return null;
    return {
      onPointerDown: (event: ReactPointerEvent) => {
        if (event.button !== 0 || draggingRef.current) return;
        draggingRef.current = true;
        dragEndedRef.current = false;
        suppressClickRef.current = true;
        setDragging(true);
        onArm();
        controls.start(event.nativeEvent);

        const pointerId = event.pointerId;
        const onPointerUp = (upEvent: PointerEvent) => {
          if (upEvent.pointerId !== pointerId) return;
          window.removeEventListener("pointerup", onPointerUp);
          window.removeEventListener("pointercancel", onPointerUp);
          // motion fires onDragEnd (post-render) when the drag actually
          // moved; fall back to a plain reset when the handle was pressed
          // but never dragged.
          window.setTimeout(() => {
            if (!dragEndedRef.current) endDragRef.current(false);
          }, 120);
        };
        window.addEventListener("pointerup", onPointerUp);
        window.addEventListener("pointercancel", onPointerUp);
      },
    };
  }, [canReorder, controls, onArm]);

  return (
    <Reorder.Item
      as="div"
      value={item.id}
      data-workspace-id={item.id}
      dragListener={false}
      dragControls={controls}
      onDragEnd={() => {
        dragEndedRef.current = true;
        endDragRef.current(true);
      }}
      onClickCapture={(event: React.MouseEvent<HTMLDivElement>) => {
        if (suppressClickRef.current) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      className={
        dragging
          ? "cursor-grabbing rounded-2lg bg-background-secondary-hover ring-1 ring-border-button-active"
          : undefined
      }
    >
      {renderItem(item, canReorder ? { isDragging: dragging, dragHandleProps } : null)}
    </Reorder.Item>
  );
}

export function WorkspaceSortableList<T extends { id?: string }>({
  items,
  disabled = false,
  onReorder,
  renderItem,
  className,
}: {
  items: T[];
  /** Searching / single workspace / missing callback → plain list. */
  disabled?: boolean;
  onReorder?: (orderedIds: string[]) => void;
  renderItem: (item: T, drag: RepoDragChrome | null) => ReactNode;
  className?: string;
}) {
  const canReorder =
    !disabled && Boolean(onReorder) && items.length >= 2 && items.every((item) => item.id);
  const baseIds = useMemo(() => items.map((item) => item.id ?? ""), [items]);
  // Preview order committed live by Reorder.Group while dragging.
  const [order, setOrder] = useState(baseIds);
  const orderRef = useRef(order);
  const draggingRef = useRef(false);

  // Follow external list changes (add / remove / backend refresh), but never
  // fight an in-flight drag.
  useEffect(() => {
    if (!draggingRef.current) {
      orderRef.current = baseIds;
      setOrder(baseIds);
    }
  }, [baseIds]);

  const itemById = useMemo(() => {
    const map = new Map<string, T>();
    items.forEach((item) => {
      if (item.id) map.set(item.id, item);
    });
    return map;
  }, [items]);

  const handleGroupReorder = useCallback((nextOrder: string[]) => {
    orderRef.current = nextOrder;
    setOrder(nextOrder);
  }, []);

  const handleArm = useCallback(() => {
    draggingRef.current = true;
  }, []);

  const handleCommit = useCallback(() => {
    draggingRef.current = false;
    const next = orderRef.current;
    const changed =
      next.length === baseIds.length && next.some((id, index) => id !== baseIds[index]);
    if (changed) onReorder?.(next);
  }, [baseIds, onReorder]);

  const handleAbort = useCallback(() => {
    draggingRef.current = false;
  }, []);

  return (
    <Reorder.Group
      as="div"
      axis="y"
      values={order}
      onReorder={handleGroupReorder}
      className={className}
      data-workspace-reorder-list="true"
    >
      {order.map((id) => {
        const item = itemById.get(id);
        if (!item) return null;
        return (
          <SortableRow
            key={id}
            item={item}
            canReorder={canReorder}
            renderItem={renderItem}
            onArm={handleArm}
            onCommit={handleCommit}
            onAbort={handleAbort}
          />
        );
      })}
    </Reorder.Group>
  );
}
