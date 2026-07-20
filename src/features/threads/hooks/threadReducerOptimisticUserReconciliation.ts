import type { ConversationItem } from "../../../types";
import { buildComparableUserMessageKey, isEquivalentUserObservation } from "../assembly/conversationNormalization";
import { isOptimisticUserMessageId } from "../utils/queuedHandoffBubble";
import { isProcessingGeneratedImageItem } from "../utils/generatedImagePlaceholder";

type MessageItem = Extract<ConversationItem, { kind: "message" }>;
type UserMessageItem = MessageItem & { role: "user" };
type GeneratedImageItem = Extract<ConversationItem, { kind: "generatedImage" }>;

function isUserMessageItem(item: ConversationItem | undefined): item is UserMessageItem {
  return item?.kind === "message" && item.role === "user";
}

function isOptimisticUserMessage(
  item: ConversationItem,
): item is UserMessageItem {
  return isUserMessageItem(item) && isOptimisticUserMessageId(item.id);
}

function dropMatchingOptimisticUserMessage(
  list: ConversationItem[],
  incoming: UserMessageItem,
) {
  let matchedIndex = -1;
  const optimisticIndexes: number[] = [];
  for (let index = 0; index < list.length; index += 1) {
    const item = list[index];
    if (!item || !isOptimisticUserMessage(item)) {
      continue;
    }
    optimisticIndexes.push(index);
    if (isEquivalentUserObservation(item, incoming)) {
      matchedIndex = index;
      break;
    }
  }
  if (matchedIndex >= 0) {
    return [...list.slice(0, matchedIndex), ...list.slice(matchedIndex + 1)];
  }
  // Conservative fallback: when there is only one optimistic user bubble and no
  // persisted real user messages yet, treat the first real user payload as its
  // authoritative replacement even if raw text shape differs.
  const hasRealUserMessage = list.some(
    (item) => isUserMessageItem(item) && !isOptimisticUserMessage(item),
  );
  if (!hasRealUserMessage && optimisticIndexes.length === 1) {
    const targetIndex = optimisticIndexes[0]!;
    return [...list.slice(0, targetIndex), ...list.slice(targetIndex + 1)];
  }
  return list;
}

export function buildOptimisticUserReplacementMap(
  localItems: ConversationItem[],
  incomingItems: ConversationItem[],
) {
  const localOptimisticUsers = localItems.filter(isOptimisticUserMessage);
  const incomingRealUsers = incomingItems.filter(
    (item): item is UserMessageItem =>
      isUserMessageItem(item) && !isOptimisticUserMessage(item),
  );
  const optimisticBucketsByKey = new Map<string, UserMessageItem[]>();
  localOptimisticUsers.forEach((item) => {
    const key = buildComparableUserMessageKey(item);
    const bucket = optimisticBucketsByKey.get(key) ?? [];
    bucket.push(item);
    optimisticBucketsByKey.set(key, bucket);
  });

  const replacementByOptimisticId = new Map<string, string>();
  const matchedIncomingIds = new Set<string>();
  incomingRealUsers.forEach((incomingUser) => {
    const key = buildComparableUserMessageKey(incomingUser);
    const bucket = optimisticBucketsByKey.get(key);
    if (!bucket || bucket.length === 0) {
      return;
    }
    const matchedOptimisticUser = bucket.shift();
    if (!matchedOptimisticUser) {
      return;
    }
    replacementByOptimisticId.set(matchedOptimisticUser.id, incomingUser.id);
    matchedIncomingIds.add(incomingUser.id);
    if (bucket.length === 0) {
      optimisticBucketsByKey.delete(key);
    } else {
      optimisticBucketsByKey.set(key, bucket);
    }
  });

  const hasLocalRealUser = localItems.some(
    (item) => isUserMessageItem(item) && !isOptimisticUserMessage(item),
  );
  const unmatchedOptimisticUsers = localOptimisticUsers.filter(
    (item) => !replacementByOptimisticId.has(item.id),
  );
  const unmatchedIncomingUsers = incomingRealUsers.filter(
    (item) => !matchedIncomingIds.has(item.id),
  );
  if (
    !hasLocalRealUser &&
    unmatchedOptimisticUsers.length === 1 &&
    unmatchedIncomingUsers.length === 1
  ) {
    replacementByOptimisticId.set(
      unmatchedOptimisticUsers[0]!.id,
      unmatchedIncomingUsers[0]!.id,
    );
  }

  return replacementByOptimisticId;
}

export function retargetGeneratedImageAnchor(
  item: GeneratedImageItem,
  replacementByOptimisticUserId: Map<string, string>,
): GeneratedImageItem {
  const anchorUserMessageId = item.anchorUserMessageId;
  if (!anchorUserMessageId) {
    return item;
  }
  const replacementAnchorId = replacementByOptimisticUserId.get(anchorUserMessageId);
  if (!replacementAnchorId) {
    return item;
  }
  return {
    ...item,
    anchorUserMessageId: replacementAnchorId,
  };
}

export function insertGeneratedImagesAfterAnchors(
  items: ConversationItem[],
  generatedImages: GeneratedImageItem[],
) {
  if (generatedImages.length === 0) {
    return items;
  }
  const next = [...items];
  const insertCountByAnchorId = new Map<string, number>();
  generatedImages.forEach((generatedImage) => {
    const anchorUserMessageId = generatedImage.anchorUserMessageId;
    const anchorIndex = anchorUserMessageId
      ? next.findIndex((item) => item.id === anchorUserMessageId)
      : -1;
    if (anchorIndex < 0 || !anchorUserMessageId) {
      next.push(generatedImage);
      return;
    }
    const previousInsertCount = insertCountByAnchorId.get(anchorUserMessageId) ?? 0;
    next.splice(anchorIndex + 1 + previousInsertCount, 0, generatedImage);
    insertCountByAnchorId.set(anchorUserMessageId, previousInsertCount + 1);
  });
  return next;
}

export function replaceOptimisticUserAndExtractAnchoredGeneratedImages(
  items: ConversationItem[],
  incomingUser: UserMessageItem,
) {
  const replacementByOptimisticUserId = buildOptimisticUserReplacementMap(
    items,
    [incomingUser],
  );
  if (replacementByOptimisticUserId.size === 0) {
    return {
      items: dropMatchingOptimisticUserMessage(items, incomingUser),
      generatedImagesToReinsert: [],
      replacedOptimisticUserInPlace: false,
    };
  }

  const replacedOptimisticUserIds = new Set(replacementByOptimisticUserId.keys());
  const generatedImagesToReinsert: GeneratedImageItem[] = [];
  const nextItems: ConversationItem[] = [];
  items.forEach((item) => {
    if (isUserMessageItem(item) && replacedOptimisticUserIds.has(item.id)) {
      nextItems.push(incomingUser);
      return;
    }
    const nextItem = isProcessingGeneratedImageItem(item)
      ? retargetGeneratedImageAnchor(item, replacementByOptimisticUserId)
      : item;
    if (
      isProcessingGeneratedImageItem(nextItem) &&
      nextItem.anchorUserMessageId === incomingUser.id
    ) {
      generatedImagesToReinsert.push(nextItem);
      return;
    }
    nextItems.push(nextItem);
  });

  return {
    items: nextItems,
    generatedImagesToReinsert,
    replacedOptimisticUserInPlace: true,
  };
}
