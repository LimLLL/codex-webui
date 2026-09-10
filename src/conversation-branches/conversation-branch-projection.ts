/** Pure DTO projection shared by branch read and mutation responses. */
import {
  BRANCH_START_SENTINEL,
  type ConversationBranchEdge,
  type ConversationBranchGroup,
  type ConversationBranchVersion,
} from '../database/schema';
import type {
  BranchGroupDto,
  BranchTreeMemberDto,
  BranchVersionDto,
} from './dto/conversation-branches.dto';

/** Projects a complete known edge set into graph members without changing topology. */
export function branchMemberDtos(
  rootThreadId: string,
  edges: ConversationBranchEdge[],
): BranchTreeMemberDto[] {
  const parentIds = new Set(edges.map((edge) => edge.parentThreadId));
  const members: BranchTreeMemberDto[] = [
    {
      threadId: rootThreadId,
      parentThreadId: null,
      hasChildren: parentIds.has(rootThreadId),
      source: 'local',
      commonPrefixTurnId: null,
    },
  ];

  for (const edge of edges) {
    if (edge.childThreadId === rootThreadId) continue;
    members.push({
      threadId: edge.childThreadId,
      parentThreadId: edge.parentThreadId,
      hasChildren: parentIds.has(edge.childThreadId),
      source: edge.source === 'adopted' ? 'adopted' : 'local',
      // Identifies which version group describes *this* fork. A thread can
      // appear in several groups — it is a branch of the group it was forked
      // into, and the original of any group created from its own later turns
      // — and only the one keyed by this prefix says how it differs from its
      // parent.
      commonPrefixTurnId:
        edge.commonPrefixTurnId === BRANCH_START_SENTINEL
          ? null
          : edge.commonPrefixTurnId,
    });
  }
  return members;
}

/** Projects one message-version group and its matching versions. */
export function branchGroupDto(
  group: ConversationBranchGroup,
  versions: ConversationBranchVersion[],
): BranchGroupDto {
  return {
    groupId: group.groupId,
    treeRootThreadId: group.treeRootThreadId,
    commonPrefixTurnId:
      group.commonPrefixTurnId === BRANCH_START_SENTINEL
        ? null
        : group.commonPrefixTurnId,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
    versions: versions
      .filter((version) => version.groupId === group.groupId)
      .map((version) => branchVersionDto(version)),
  };
}

/** Projects one persisted version without inferring unavailable provenance. */
export function branchVersionDto(
  version: ConversationBranchVersion,
): BranchVersionDto {
  return {
    versionId: version.versionId,
    groupId: version.groupId,
    threadId: version.threadId,
    versionIndex: version.versionIndex,
    kind: version.kind === 'original' ? 'original' : 'branch',
    source: version.source === 'adopted' ? 'adopted' : 'local',
    messageTurnId: version.messageTurnId,
    previewText: version.previewText,
    createdAt: version.createdAt,
    updatedAt: version.updatedAt,
  };
}
