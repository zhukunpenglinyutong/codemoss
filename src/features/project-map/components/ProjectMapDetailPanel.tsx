import { useTranslation } from "react-i18next";
import ArrowLeft from "lucide-react/dist/esm/icons/arrow-left";
import ChevronLeft from "lucide-react/dist/esm/icons/chevron-left";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import Folder from "lucide-react/dist/esm/icons/folder";
import Network from "lucide-react/dist/esm/icons/network";
import Search from "lucide-react/dist/esm/icons/search";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";

import { cn } from "../../../lib/utils";
import { PROJECT_MAP_UNASSIGNED_DISCOVERIES_NODE_ID } from "../utils/incrementalGeneration";
import {
  formatProjectMapDateTime,
  translateProjectMapNodeKind,
} from "../utils/display";
import type { ProjectMapNodeRelationBucket } from "../utils/relationIndex";
import type {
  ProjectMapCandidate,
  ProjectMapActivityItem,
  ProjectMapActivityProjection,
  ProjectMapAdvisorHint,
  ProjectMapDataset,
  ProjectMapExplainPack,
  ProjectMapGraphIntegrityIssue,
  ProjectMapGraphRepairSummary,
  ProjectMapImpactResult,
  ProjectMapLens,
  ProjectMapNode,
  ProjectMapRefreshSummary,
  ProjectMapRelatedArtifact,
  ProjectMapStaleReason,
} from "../types";
import {
  ProjectMapArtifactChip,
  ProjectMapDiagramChip,
  ProjectMapSourceChip,
  dedupeProjectMapArtifactsForDisplay,
  dedupeProjectMapSourcesForDisplay,
  normalizeProjectMapArtifactForDisplay,
  type ProjectMapTraceTarget,
} from "./ProjectMapTraceChips";
import { ProjectMapRelationInspector } from "./ProjectMapRelationPanels";

function isCandidateAfterCompletedCalibration(
  dataset: ProjectMapDataset,
  node: ProjectMapNode,
): boolean {
  const generatedRun = dataset.runs.find((run) => run.id === node.generatedBy.runId);
  return Boolean(
    node.candidate &&
      generatedRun?.status === "completed" &&
      generatedRun.generationIntent === "calibrateNode" &&
      generatedRun.requestScope?.kind === "node" &&
      generatedRun.requestScope.nodeId === node.id,
  );
}

function summarizeGraphRepairActions(summary: ProjectMapGraphRepairSummary | null): {
  deterministicCleanupCount: number;
  evidenceMarkerCount: number;
  actionCount: number;
} {
  const actions = summary?.actions ?? [];
  return {
    deterministicCleanupCount: actions.filter((repairAction) => repairAction.kind !== "quarantine-evidence-gap").length,
    evidenceMarkerCount: actions.filter((repairAction) => repairAction.kind === "quarantine-evidence-gap").length,
    actionCount: actions.length,
  };
}

export type ProjectMapOrchestrationDraftState =
  | { status: "idle" }
  | {
      status: "created";
      nodeId: string;
      taskId: string;
      taskStatus: string;
      evidenceCount: number;
      riskCount: number;
    }
  | {
      status: "failed";
      nodeId: string;
      reason: "missing-workspace" | "missing-node";
    };

export function DetailPanel({
  node,
  dataset,
  pendingCandidate,
  lens,
  explainPack,
  relationBucket,
  activityProjection,
  nodeExplainHint,
  selectedRelationId,
  impactAnalysis,
  refreshSummary,
  nodeStaleReasons,
  graphIntegrityIssues,
  graphRepairSummary,
  isGraphHealthExpanded,
  orchestrationDraftState: _orchestrationDraftState,
  staleCount,
  unassignedDiscoveryCount,
  pendingReviewCandidateCount,
  canDrill,
  collapsed,
  onCollapsedChange,
  onBack,
  onBackToPrevious,
  backToPreviousLabel,
  onDrill,
  onCompleteNode,
  onCalibrateNode,
  onCreateOrchestrationTask: _onCreateOrchestrationTask,
  onOrganizeUnassigned,
  onConfirmCandidate,
  onRejectCandidate,
  onConfirmNodeCandidate,
  onRejectNodeCandidate,
  onDeleteNode,
  onOpenTrace,
  onFocusRelationNode,
  onSelectRelation,
  onGraphHealthExpandedChange,
  onRepairGraph,
  onOpenIntentCanvasArchitect,
  onOpenIntentCanvasSpotlight,
  onOpenIntentCanvasForFile,
}: {
  node: ProjectMapNode | null;
  dataset: ProjectMapDataset;
  pendingCandidate: ProjectMapCandidate | null;
  lens: ProjectMapLens | null;
  explainPack: ProjectMapExplainPack | null;
  relationBucket: ProjectMapNodeRelationBucket | null;
  activityProjection: ProjectMapActivityProjection;
  nodeExplainHint: ProjectMapAdvisorHint | null;
  selectedRelationId: string | null;
  impactAnalysis: ProjectMapImpactResult;
  refreshSummary: ProjectMapRefreshSummary;
  nodeStaleReasons: ProjectMapStaleReason[];
  graphIntegrityIssues: ProjectMapGraphIntegrityIssue[];
  graphRepairSummary: ProjectMapGraphRepairSummary | null;
  isGraphHealthExpanded: boolean;
  orchestrationDraftState: ProjectMapOrchestrationDraftState;
  staleCount: number;
  unassignedDiscoveryCount: number;
  pendingReviewCandidateCount: number;
  canDrill: boolean;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  onBack: (() => void) | null;
  onBackToPrevious: (() => void) | null;
  backToPreviousLabel: string;
  onDrill: () => void;
  onCompleteNode: () => void;
  onCalibrateNode: () => void;
  onCreateOrchestrationTask: () => void;
  onOrganizeUnassigned: () => void;
  onConfirmCandidate: (candidateId: string) => void;
  onRejectCandidate: (candidateId: string) => void;
  onConfirmNodeCandidate: (nodeId: string) => void;
  onRejectNodeCandidate: (nodeId: string) => void;
  onDeleteNode: (() => void) | null;
  onOpenTrace?: (target: ProjectMapTraceTarget) => void;
  onFocusRelationNode: (nodeId: string) => void;
  onSelectRelation: (relationId: string) => void;
  onGraphHealthExpandedChange: (expanded: boolean) => void;
  onRepairGraph: () => Promise<void>;
  onOpenIntentCanvasArchitect?: () => void;
  onOpenIntentCanvasSpotlight?: () => void;
  onOpenIntentCanvasForFile?: (path: string) => void;
}) {
  const { t } = useTranslation();
  const isCalibratedCandidate = node
    ? isCandidateAfterCompletedCalibration(dataset, node)
    : false;
  const moveSuggestedParent = pendingCandidate?.move?.suggestedParentId
    ? dataset.nodes.find((candidateNode) => candidateNode.id === pendingCandidate.move?.suggestedParentId) ?? null
    : null;
  const isUnassignedDiscoveriesNode = node?.id === PROJECT_MAP_UNASSIGNED_DISCOVERIES_NODE_ID;
  const impactRole = node
    ? impactAnalysis.changedNodes.some((item) => item.node.id === node.id)
      ? "changed"
      : impactAnalysis.affectedNodes.some((item) => item.node.id === node.id)
        ? "affected"
        : null
    : null;
  const graphRepairActionSummary = summarizeGraphRepairActions(graphRepairSummary);
  const repairIssueCount = graphIntegrityIssues.length;
  const canRunGraphRepair = repairIssueCount > 0;
  const repairActionLabel =
    graphIntegrityIssues.some((issue) => issue.kind !== "missing-node-evidence")
      ? t("projectMap.repair.cleanupAction")
      : t("projectMap.repair.markEvidenceAction");
  const nodeRelatedActivity = node
    ? activityProjection.items.filter((item) => item.nodeIds.includes(node.id)).slice(0, 6)
    : [];
  const explainPackRelationCount = explainPack?.relations.length ?? 0;
  const explainPackEvidenceCount = explainPack
    ? explainPack.evidenceSources.length + explainPack.evidenceRecords.length + explainPack.governanceEvidence.length
    : 0;
  const primaryFileSource = node?.sources.find((source) => source.path?.trim()) ?? null;

  return (
    <aside
      className={cn("project-map-detail-panel", collapsed && "is-collapsed")}
      aria-label={t("projectMap.detailPanel")}
    >
      <div
        className="project-map-detail-control-group"
        role="group"
        aria-label={t("projectMap.viewNavigation")}
      >
        <button
          className="project-map-detail-toggle"
          type="button"
          aria-expanded={!collapsed}
          onClick={() => onCollapsedChange(!collapsed)}
        >
          {collapsed ? <ChevronLeft aria-hidden /> : <ChevronRight aria-hidden />}
          <span>
            {collapsed
              ? t("projectMap.expandDetail")
              : t("projectMap.collapseDetail")}
          </span>
        </button>
        {!collapsed && onBackToPrevious ? (
          <button
            className="project-map-back-button is-previous"
            type="button"
            onClick={onBackToPrevious}
          >
            <ArrowLeft aria-hidden />
            <span>{backToPreviousLabel}</span>
          </button>
        ) : null}
        {!collapsed && onBack ? (
          <button className="project-map-back-button" type="button" onClick={onBack}>
            <Network aria-hidden />
            <span>{t("projectMap.backToOverview")}</span>
          </button>
        ) : null}
      </div>
      {collapsed ? (
        <div className="project-map-detail-peek">
          <span className="project-map-node-kind">
            {node ? translateProjectMapNodeKind(t, node.nodeKind) : t("projectMap.inspector")}
          </span>
          <strong>{node?.title ?? t("projectMap.emptyInspector")}</strong>
        </div>
      ) : null}
      {!collapsed ? (
        <>
          {node ? (
            <>
          <div className="project-map-inspector-heading">
            <span className="project-map-node-kind">{translateProjectMapNodeKind(t, node.nodeKind)}</span>
            <h3>{node.title}</h3>
            <p>{node.summary}</p>
            <div className="project-map-inspector-badges">
              {lens ? <span>{lens.title}</span> : null}
              {lens ? <span>{t(`projectMap.lensStatus.${lens.status}`)}</span> : null}
              <span className={`confidence-${node.confidence}`}>
                {t(`projectMap.confidence.${node.confidence}`)}
              </span>
              {node.stale ? <span>{t("projectMap.status.stale")}</span> : null}
              {node.candidate ? <span>{t("projectMap.status.candidate")}</span> : null}
            </div>
          </div>
          {node.candidate || pendingCandidate ? (
            <section className="project-map-candidate-notice">
              <h4>
                {t(
                  isCalibratedCandidate
                    ? "projectMap.candidateNotice.calibratedTitle"
                    : "projectMap.candidateNotice.title",
                )}
              </h4>
              <p>
                {pendingCandidate?.kind === "parentMove" && moveSuggestedParent
                  ? t("projectMap.candidateNotice.parentMoveBody", {
                      parent: moveSuggestedParent.title,
                      reason: pendingCandidate.move?.reason ?? "-",
                    })
                  : t(
                      isCalibratedCandidate
                        ? "projectMap.candidateNotice.calibratedBody"
                        : "projectMap.candidateNotice.body",
                    )}
              </p>
              <div className="project-map-candidate-actions">
                <button
                  type="button"
                  className="is-primary"
                  onClick={() =>
                    pendingCandidate
                      ? onConfirmCandidate(pendingCandidate.id)
                      : onConfirmNodeCandidate(node.id)
                  }
                >
                  {t("projectMap.candidateNotice.confirm")}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    pendingCandidate
                      ? onRejectCandidate(pendingCandidate.id)
                      : onRejectNodeCandidate(node.id)
                  }
                >
                  {t("projectMap.candidateNotice.reject")}
                </button>
              </div>
            </section>
          ) : null}
          {isUnassignedDiscoveriesNode ? (
            <section className="project-map-candidate-notice">
              <h4>{t("projectMap.unassignedOrganizer.title")}</h4>
              <p>
                {t("projectMap.unassignedOrganizer.body", {
                  count: unassignedDiscoveryCount,
                  candidates: pendingReviewCandidateCount,
                })}
              </p>
              <div className="project-map-candidate-actions">
                <button
                  type="button"
                  className="is-primary"
                  disabled={unassignedDiscoveryCount === 0}
                  onClick={onOrganizeUnassigned}
                >
                  {t("projectMap.unassignedOrganizer.organize")}
                </button>
              </div>
            </section>
          ) : null}

          <div
            className="project-map-inspector-zones"
            aria-label={t("projectMap.detail.inspectorZones", {
              defaultValue: "Node understanding zones",
            })}
          >
            <section className="project-map-inspector-zone is-understand">
              <header className="project-map-inspector-zone-header">
                <span>01</span>
                <div>
                  <h4>{t("projectMap.detail.understandZone", { defaultValue: "Understand" })}</h4>
                  <p>
                    {t("projectMap.detail.understandZoneHint", {
                      defaultValue: "What this node means, what matters, and what can break.",
                    })}
                  </p>
                </div>
              </header>
              <section>
                <h4>{t("projectMap.detail.coreDescription")}</h4>
                <p>{node.detail.coreDescription}</p>
              </section>
              <InspectorList title={t("projectMap.detail.keyFacts")} items={node.detail.keyFacts} />
              <InspectorList title={t("projectMap.detail.keyLogic")} items={node.detail.keyLogic} />
              <InspectorList
                title={t("projectMap.detail.riskSignals")}
                items={node.detail.riskSignals}
                emptyLabel={t("projectMap.none")}
              />
              {impactAnalysis.inputFiles.length > 0 ? (
                <section>
                  <h4>{t("projectMap.impact.title", { defaultValue: "Impact" })}</h4>
                  {impactAnalysis.source ? (
                    <p>
                      {t("projectMap.impact.source", {
                        defaultValue: "Source: {{source}} · {{count}} files",
                        source: impactAnalysis.source.label,
                        count: impactAnalysis.source.fileCount,
                      })}
                    </p>
                  ) : null}
                  <p>
                    {t("projectMap.impact.summary", {
                      defaultValue:
                        "{{changed}} changed · {{affected}} affected · {{unmapped}} unmapped · {{ignored}} ignored",
                      changed: impactAnalysis.riskSummary.changedCount,
                      affected: impactAnalysis.riskSummary.affectedCount,
                      unmapped: impactAnalysis.riskSummary.unmappedCount,
                      ignored: impactAnalysis.riskSummary.ignoredCount,
                    })}
                  </p>
                  {impactRole ? (
                    <p>
                      {t("projectMap.impact.nodeRole", {
                        defaultValue: "This node is {{role}} by the current file set.",
                        role: impactRole,
                      })}
                    </p>
                  ) : null}
                  {impactAnalysis.unmappedFiles.length > 0 ? (
                    <ul>
                      {impactAnalysis.unmappedFiles.slice(0, 5).map((filePath) => (
                        <li key={filePath}>{filePath}</li>
                      ))}
                    </ul>
                  ) : null}
                </section>
              ) : null}
              {(node.stale || nodeStaleReasons.length > 0 || refreshSummary.changedPaths.length > 0) ? (
                <section>
                  <h4>{t("projectMap.refresh.title")}</h4>
                  <p>{refreshSummary.label}</p>
                  {nodeStaleReasons.length > 0 ? (
                    <ul>
                      {nodeStaleReasons.slice(0, 6).map((reason) => (
                        <li key={reason.id}>
                          <strong>{t(`projectMap.refresh.classification.${reason.recommendation}`)}</strong>
                          {" · "}
                          {reason.label}
                          {reason.path ? ` · ${reason.path}` : ""}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {refreshSummary.ignoredPaths.length > 0 ? (
                    <p>
                      {t("projectMap.refresh.ignored", {
                        count: refreshSummary.ignoredPaths.length,
                      })}
                    </p>
                  ) : null}
                </section>
              ) : null}
            </section>
              <section className="project-map-inspector-zone is-evidence">
              <header className="project-map-inspector-zone-header">
                <span>02</span>
                <div>
                  <h4>{t("projectMap.detail.evidenceZone", { defaultValue: "Evidence" })}</h4>
                  <p>
                    {t("projectMap.detail.evidenceZoneHint", {
                      defaultValue: "Why CodePort trusts this node and where the proof lives.",
                    })}
                  </p>
                </div>
              </header>
              {nodeExplainHint ? (
                <details className="project-map-detail-disclosure" open>
                  <summary>
                    <span>{t("projectMap.detail.explainContext")}</span>
                    <em>{nodeExplainHint.deterministic ? t("projectMap.detail.deterministic") : t("projectMap.detail.inferred")}</em>
                  </summary>
                  <p>{nodeExplainHint.summary}</p>
                  <div className="project-map-detail-mini-pills">
                    <span>{nodeExplainHint.kind}</span>
                    <span>{nodeExplainHint.severity ?? "info"}</span>
                    {nodeExplainHint.degraded ? <span>{t("projectMap.detail.degraded")}</span> : null}
                  </div>
                </details>
              ) : null}
              {explainPack ? (
                <details className="project-map-detail-disclosure">
                  <summary>
                    <span>{t("projectMap.detail.evidenceAndContext")}</span>
                    <em>
                      {t("projectMap.detail.evidenceSummary", {
                        evidence: explainPackEvidenceCount,
                        relations: explainPackRelationCount,
                      })}
                    </em>
                  </summary>
                  <section>
                    <h4>{t("projectMap.detail.explainPack", { defaultValue: "Explain Pack" })}</h4>
                    <dl className="project-map-definition-grid">
                      <div>
                        <dt>{t("projectMap.detail.relatedNodes", { defaultValue: "Related nodes" })}</dt>
                        <dd>{explainPack.relatedNodes.length}</dd>
                      </div>
                      <div>
                        <dt>{t("projectMap.detail.relations", { defaultValue: "Relations" })}</dt>
                        <dd>{explainPack.relations.length}</dd>
                      </div>
                      <div>
                        <dt>{t("projectMap.detail.riskFlags", { defaultValue: "Risk flags" })}</dt>
                        <dd>{explainPack.riskFlags.length}</dd>
                      </div>
                    </dl>
                    {explainPack.relatedNodes.length > 0 ? (
                      <ul>
                        {explainPack.relatedNodes.slice(0, 6).map((relatedNode) => (
                          <li key={relatedNode.id}>
                            <strong>{relatedNode.title}</strong>
                            {" · "}
                            {translateProjectMapNodeKind(t, relatedNode.nodeKind)}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {explainPack.evidenceSources.length > 0 ? (
                      <div className="project-map-source-list">
                        {dedupeProjectMapSourcesForDisplay(explainPack.evidenceSources).slice(0, 6).map((source) => (
                          <ProjectMapSourceChip
                            key={`${source.type}-${source.label}-${source.path ?? source.hash ?? ""}-${source.line ?? ""}`}
                            source={source}
                            onOpenTrace={onOpenTrace}
                          />
                        ))}
                      </div>
                    ) : null}
                    {explainPack.governanceEvidence.length > 0 ? (
                      <div className="project-map-governance-links">
                        {explainPack.governanceEvidence.slice(0, 8).map((link) => (
                          <span
                            key={link.id}
                            className={cn(
                              "project-map-governance-link",
                              `kind-${link.kind}`,
                              !link.deterministic && "is-inferred",
                            )}
                          >
                            <strong>{link.kind}</strong>
                            {link.path ? (
                              <button
                                type="button"
                                onClick={() => onOpenTrace?.({ path: link.path!, line: link.line })}
                              >
                                {link.label}
                              </button>
                            ) : (
                              <em>{link.label}</em>
                            )}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </section>
                </details>
              ) : null}
              <details className="project-map-detail-disclosure">
                <summary>
                  <span>{t("projectMap.detail.recentActivity")}</span>
                  <em>{t("projectMap.detail.activitySummary", { count: nodeRelatedActivity.length })}</em>
                </summary>
                {nodeRelatedActivity.length > 0 ? (
                  <ul className="project-map-detail-activity-list">
                    {nodeRelatedActivity.map((item: ProjectMapActivityItem) => (
                      <li key={item.id} className={cn(item.degraded && "is-degraded")}>
                        <strong>{item.title}</strong>
                        <span>{item.summary}</span>
                        <em>{item.sourceCategory} · {item.confidence}</em>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>{t("projectMap.detail.noRecentActivity")}</p>
                )}
              </details>
              {(node.detail.diagramArtifacts ?? []).length > 0 ? (
                <section>
                  <h4>{t("projectMap.detail.diagrams")}</h4>
                  <div className="project-map-artifact-list">
                    {(node.detail.diagramArtifacts ?? []).map((diagram) => (
                      <ProjectMapDiagramChip
                        key={`${diagram.id}-${diagram.path}`}
                        diagram={diagram}
                        onOpenTrace={onOpenTrace}
                      />
                    ))}
                  </div>
                </section>
              ) : null}
              <section>
                <h4>{t("projectMap.detail.relatedArtifacts")}</h4>
                <div className="project-map-artifact-list">
                  {dedupeProjectMapArtifactsForDisplay(
                    node.detail.relatedArtifacts
                      .map(normalizeProjectMapArtifactForDisplay)
                      .filter((artifact): artifact is ProjectMapRelatedArtifact => Boolean(artifact)),
                  )
                    .map((artifact) => (
                      <ProjectMapArtifactChip
                        key={`${artifact.type}-${artifact.label}-${artifact.path ?? artifact.ref ?? ""}-${artifact.line ?? ""}`}
                        artifact={artifact}
                        onOpenTrace={onOpenTrace}
                      />
                    ))}
                </div>
              </section>
              <section>
                <h4>{t("projectMap.evidenceTitle")}</h4>
                <div className="project-map-source-list">
                  {dedupeProjectMapSourcesForDisplay(node.sources).map((source) => (
                    <ProjectMapSourceChip
                      key={`${source.type}-${source.label}-${source.path ?? source.hash ?? ""}-${source.line ?? ""}`}
                      source={source}
                      onOpenTrace={onOpenTrace}
                    />
                  ))}
                </div>
              </section>
              <section>
                <h4>{t("projectMap.detail.generation")}</h4>
                <dl className="project-map-definition-grid">
                  <div>
                    <dt>{t("projectMap.detail.lastGeneratedAt")}</dt>
                    <dd>{formatProjectMapDateTime(node.lastGeneratedAt)}</dd>
                  </div>
                  <div>
                    <dt>{t("projectMap.detail.generatedBy")}</dt>
                    <dd>
                      {node.generatedBy.engine} / {node.generatedBy.model}
                    </dd>
                  </div>
                  <div>
                    <dt>{t("projectMap.runLogTitle")}</dt>
                    <dd>
                      {t("projectMap.runLogSummary", {
                        runId: dataset.runs[0]?.id ?? "-",
                        stale: staleCount,
                      })}
                    </dd>
                  </div>
                </dl>
              </section>
            </section>
            <section className="project-map-inspector-zone is-relations">
              <header className="project-map-inspector-zone-header">
                <span>03</span>
                <div>
                  <h4>{t("projectMap.detail.relationZone", { defaultValue: "Relations" })}</h4>
                  <p>
                    {t("projectMap.detail.relationZoneHint", {
                      defaultValue: "Follow incoming, outgoing, and degraded engineering links.",
                    })}
                  </p>
                </div>
              </header>
              <details className="project-map-detail-disclosure">
                <summary>
                  <span>{t("projectMap.detail.associations")}</span>
                  <em>
                    {t("projectMap.detail.associationSummary", {
                      incoming: relationBucket?.incoming.length ?? 0,
                      outgoing: relationBucket?.outgoing.length ?? 0,
                    })}
                  </em>
                </summary>
                <ProjectMapRelationInspector
                  bucket={relationBucket}
                  selectedRelationId={selectedRelationId}
                  onFocusNode={onFocusRelationNode}
                  onSelectRelation={onSelectRelation}
                />
              </details>
            </section>
            <section className="project-map-inspector-zone is-actions">
              <header className="project-map-inspector-zone-header">
                <span>04</span>
                <div>
                  <h4>{t("projectMap.detail.actionsZone", { defaultValue: "Actions" })}</h4>
                  <p>
                    {t("projectMap.detail.actionsZoneHint", {
                      defaultValue: "Only bounded actions are exposed here; queue work stays secondary.",
                    })}
                  </p>
                </div>
              </header>
              {(graphIntegrityIssues.length > 0 || graphRepairSummary) ? (
                <section className={cn("project-map-repair-summary", !isGraphHealthExpanded && "is-compact")}>
                  <div className="project-map-repair-summary-head">
                    <h4>{t("projectMap.repair.title")}</h4>
                    <button
                      type="button"
                      onClick={() => onGraphHealthExpandedChange(!isGraphHealthExpanded)}
                    >
                      {isGraphHealthExpanded
                        ? t("projectMap.repair.collapse", { defaultValue: "收起" })
                        : t("projectMap.repair.expand", { defaultValue: "展开" })}
                    </button>
                  </div>
                  <p>
                    {t("projectMap.repair.summary", {
                      issues: repairIssueCount,
                      actions: graphRepairActionSummary.actionCount,
                    })}
                  </p>
                  {isGraphHealthExpanded && graphRepairActionSummary.actionCount > 0 ? (
                    <p>
                      {t("projectMap.repair.result", {
                        cleanup: graphRepairActionSummary.deterministicCleanupCount,
                        evidence: graphRepairActionSummary.evidenceMarkerCount,
                      })}
                    </p>
                  ) : null}
                  {isGraphHealthExpanded && canRunGraphRepair ? (
                    <button type="button" onClick={() => void onRepairGraph()} disabled={!canRunGraphRepair}>
                      {repairActionLabel}
                    </button>
                  ) : null}
                  {isGraphHealthExpanded && (graphRepairSummary?.actions ?? []).length > 0 ? (
                    <ul>
                      {(graphRepairSummary?.actions ?? []).slice(0, 6).map((repairAction) => (
                        <li key={repairAction.id}>{repairAction.label}</li>
                      ))}
                    </ul>
                  ) : isGraphHealthExpanded && graphIntegrityIssues.length > 0 ? (
                    <ul>
                      {graphIntegrityIssues.slice(0, 6).map((issue) => (
                        <li key={issue.id}>{issue.label}</li>
                      ))}
                    </ul>
                  ) : null}
                </section>
              ) : null}
              <div className="project-map-node-actions">
                {canDrill ? (
                  <button type="button" onClick={onDrill}>
                    {t("projectMap.drillIn")}
                  </button>
                ) : null}
                {onOpenIntentCanvasArchitect ? (
                  <button type="button" onClick={onOpenIntentCanvasArchitect}>
                    <Network aria-hidden />
                    {t("projectMap.openIntentCanvasArchitect")}
                  </button>
                ) : null}
                {onOpenIntentCanvasSpotlight ? (
                  <button type="button" onClick={onOpenIntentCanvasSpotlight}>
                    <Search aria-hidden />
                    {t("projectMap.openIntentCanvasSpotlight")}
                  </button>
                ) : null}
                {onOpenIntentCanvasForFile && primaryFileSource?.path ? (
                  <button type="button" onClick={() => onOpenIntentCanvasForFile(primaryFileSource.path!)}>
                    <Folder aria-hidden />
                    {t("projectMap.openIntentCanvasForFile")}
                  </button>
                ) : null}
                <button type="button" onClick={onCompleteNode}>{t("projectMap.completeNode")}</button>
                <button type="button" onClick={onCalibrateNode}>{t("projectMap.calibrateNode")}</button>
                {onDeleteNode ? (
                  <button className="is-danger" type="button" onClick={onDeleteNode}>
                    <Trash2 aria-hidden />
                    {t("projectMap.deleteNode")}
                  </button>
                ) : null}
              </div>
            </section>
          </div>
        </>
      ) : (
        <p>{t("projectMap.emptyInspector")}</p>
      )}
      </>
      ) : null}
    </aside>
  );
}

export function InspectorList({
  title,
  items,
  emptyLabel,
}: {
  title: string;
  items: string[];
  emptyLabel?: string;
}) {
  return (
    <section>
      <h4>{title}</h4>
      {items.length > 0 ? (
        <ul>
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : (
        <p>{emptyLabel}</p>
      )}
    </section>
  );
}
