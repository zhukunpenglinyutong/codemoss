import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Lock from "lucide-react/dist/esm/icons/lock";
import appIcon from "../../../../icon.png";

type FeatureCard = {
  titleKey: string;
  descriptionKey: string;
};

type JourneyStep = {
  titleKey: string;
  descriptionKey: string;
};

type LockScreenOverlayProps = {
  isOpen: boolean;
  onUnlock: (password: string) => Promise<boolean>;
  liveSessions: LiveSessionPreview[];
};

type LockTabId = "live" | "capabilities" | "workflow" | "elements";

type LiveSessionPreview = {
  id: string;
  workspaceName: string;
  threadName: string;
  engine: string;
  preview: string;
  updatedAt: number;
  isProcessing: boolean;
};

const capabilityNodes: FeatureCard[] = [
  {
    titleKey: "lockScreen.features.workspaceGraphTitle",
    descriptionKey: "lockScreen.features.workspaceGraphDesc",
  },
  {
    titleKey: "lockScreen.features.engineRoutingTitle",
    descriptionKey: "lockScreen.features.engineRoutingDesc",
  },
  {
    titleKey: "lockScreen.features.threadOrchestrationTitle",
    descriptionKey: "lockScreen.features.threadOrchestrationDesc",
  },
  {
    titleKey: "lockScreen.features.gitIntelligenceTitle",
    descriptionKey: "lockScreen.features.gitIntelligenceDesc",
  },
];

const capabilityHighlights: FeatureCard[] = [
  {
    titleKey: "lockScreen.features.kanbanDispatchTitle",
    descriptionKey: "lockScreen.features.kanbanDispatchDesc",
  },
  {
    titleKey: "lockScreen.features.memoryEngineTitle",
    descriptionKey: "lockScreen.features.memoryEngineDesc",
  },
  {
    titleKey: "lockScreen.features.unifiedSearchTitle",
    descriptionKey: "lockScreen.features.unifiedSearchDesc",
  },
  {
    titleKey: "lockScreen.features.terminalObservabilityTitle",
    descriptionKey: "lockScreen.features.terminalObservabilityDesc",
  },
];

const workflowSteps: JourneyStep[] = [
  {
    titleKey: "lockScreen.journey.planTitle",
    descriptionKey: "lockScreen.journey.planDesc",
  },
  {
    titleKey: "lockScreen.journey.executeTitle",
    descriptionKey: "lockScreen.journey.executeDesc",
  },
  {
    titleKey: "lockScreen.journey.reviewTitle",
    descriptionKey: "lockScreen.journey.reviewDesc",
  },
  {
    titleKey: "lockScreen.journey.deliverTitle",
    descriptionKey: "lockScreen.journey.deliverDesc",
  },
];

const elementCards: FeatureCard[] = [
  {
    titleKey: "lockScreen.elements.titlebarTitle",
    descriptionKey: "lockScreen.elements.titlebarDesc",
  },
  {
    titleKey: "lockScreen.elements.sidebarTitle",
    descriptionKey: "lockScreen.elements.sidebarDesc",
  },
  {
    titleKey: "lockScreen.elements.composerTitle",
    descriptionKey: "lockScreen.elements.composerDesc",
  },
  {
    titleKey: "lockScreen.elements.gitPanelTitle",
    descriptionKey: "lockScreen.elements.gitPanelDesc",
  },
  {
    titleKey: "lockScreen.elements.kanbanTitle",
    descriptionKey: "lockScreen.elements.kanbanDesc",
  },
  {
    titleKey: "lockScreen.elements.searchTitle",
    descriptionKey: "lockScreen.elements.searchDesc",
  },
  {
    titleKey: "lockScreen.elements.memoryTitle",
    descriptionKey: "lockScreen.elements.memoryDesc",
  },
  {
    titleKey: "lockScreen.elements.debugTitle",
    descriptionKey: "lockScreen.elements.debugDesc",
  },
];

const PASSWORD_STORAGE_PATH = "~/.ccgui/client/pwd.txt";

export function LockScreenOverlay({
  isOpen,
  onUnlock,
  liveSessions,
}: LockScreenOverlayProps) {
  const { t } = useTranslation();
  const unlockInputRef = useRef<HTMLInputElement | null>(null);
  const liveListRef = useRef<HTMLDivElement | null>(null);
  const [unlockInput, setUnlockInput] = useState("");
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [unlocking, setUnlocking] = useState(false);
  const [activeTab, setActiveTab] = useState<LockTabId>("live");

  useEffect(() => {
    if (!isOpen) {
      setUnlockInput("");
      setUnlockError(null);
      setUnlocking(false);
      setActiveTab("live");
      return;
    }
    window.setTimeout(() => {
      unlockInputRef.current?.focus();
      unlockInputRef.current?.select();
    }, 32);
  }, [isOpen]);

  const tabItems = useMemo(
    () => [
      { id: "live" as const, label: t("lockScreen.tabs.live") },
      { id: "capabilities" as const, label: t("lockScreen.tabs.capabilities") },
      { id: "workflow" as const, label: t("lockScreen.tabs.workflow") },
      { id: "elements" as const, label: t("lockScreen.tabs.elements") },
    ],
    [t],
  );

  const displayedLiveSessions = liveSessions;
  const liveRowCount = Math.max(displayedLiveSessions.length, 1);

  useEffect(() => {
    if (activeTab !== "live") {
      return;
    }
    liveListRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, [activeTab]);

  if (!isOpen) {
    return null;
  }

  const handleUnlock = async () => {
    if (unlocking) {
      return;
    }
    setUnlocking(true);
    const success = await onUnlock(unlockInput);
    setUnlocking(false);
    if (success) {
      setUnlockError(null);
      return;
    }
    setUnlockError(t("lockScreen.invalidPassword"));
  };

  return (
    <div className="panel-lock-overlay" role="dialog" aria-modal="true">
      <div className="panel-lock-overlay-backdrop" />
      <div className="panel-lock-shell" data-tauri-drag-region="false">
        <section className="panel-lock-atlas panel-lock-panel">
          <header className="panel-lock-hero">
            <div className="panel-lock-brand">
              <img src={appIcon} alt="CodePort" className="panel-lock-logo" />
              <div>
                <p className="panel-lock-brand-kicker">{t("lockScreen.brandKicker")}</p>
                <h2>{t("lockScreen.title")}</h2>
              </div>
            </div>
            <p className="panel-lock-hero-description">{t("lockScreen.description")}</p>
            <div className="panel-lock-facts">
              <article className="panel-lock-fact">
                <span>{t("lockScreen.facts.integrationsLabel")}</span>
                <strong>{t("lockScreen.facts.integrationsValue")}</strong>
              </article>
              <article className="panel-lock-fact">
                <span>{t("lockScreen.facts.workflowLabel")}</span>
                <strong>{t("lockScreen.facts.workflowValue")}</strong>
              </article>
              <article className="panel-lock-fact">
                <span>{t("lockScreen.facts.runtimeLabel")}</span>
                <strong>{t("lockScreen.facts.runtimeValue")}</strong>
              </article>
            </div>
          </header>

          <div className="panel-lock-tabs" role="tablist" aria-label={t("lockScreen.tabLabel")}>
            {tabItems.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={activeTab === tab.id}
                className={`panel-lock-tab${activeTab === tab.id ? " is-active" : ""}`}
                onClick={() => setActiveTab(tab.id)}
                data-tauri-drag-region="false"
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div
            className={`panel-lock-content${activeTab === "live" ? " is-live" : ""}`}
            role="tabpanel"
          >
            {activeTab === "live" ? (
              <>
                <div className="panel-lock-content-header">
                  <h3>{t("lockScreen.liveTitle")}</h3>
                  <p>{t("lockScreen.liveDesc")}</p>
                </div>
                {displayedLiveSessions.length === 0 ? (
                  <div className="panel-lock-live-empty">{t("lockScreen.liveEmpty")}</div>
                ) : (
                  <div
                    className="panel-lock-live-list"
                    ref={liveListRef}
                    style={{
                      gridTemplateRows: `repeat(${liveRowCount}, minmax(var(--panel-lock-live-item-min-height), 1fr))`,
                    }}
                  >
                    {displayedLiveSessions.map((session) => (
                      <article key={session.id} className="panel-lock-live-item">
                        <div className="panel-lock-live-item-head">
                          <span
                            className={`panel-lock-live-status${
                              session.isProcessing ? " is-running" : ""
                            }`}
                          />
                          <h4>{session.threadName}</h4>
                          <span className="panel-lock-live-time">
                            {new Date(session.updatedAt).toLocaleTimeString([], {
                              hour: "2-digit",
                              minute: "2-digit",
                              second: "2-digit",
                            })}
                          </span>
                        </div>
                        <p className="panel-lock-live-meta">
                          {session.workspaceName} · {session.engine} · {t("lockScreen.liveRunning")}
                        </p>
                        <p className="panel-lock-live-preview">{session.preview}</p>
                      </article>
                    ))}
                  </div>
                )}
              </>
            ) : null}

            {activeTab === "capabilities" ? (
              <>
                <div className="panel-lock-content-header">
                  <h3>{t("lockScreen.capabilityTitle")}</h3>
                  <p>{t("lockScreen.capabilityDesc")}</p>
                </div>
                <article className="panel-lock-capability-core">
                  <h4>CodePort Core</h4>
                  <p>{t("lockScreen.facts.workflowValue")}</p>
                </article>
                <div className="panel-lock-capability-grid">
                  {capabilityNodes.map((card) => (
                    <article key={card.titleKey} className="panel-lock-capability-card">
                      <h4>{t(card.titleKey)}</h4>
                      <p>{t(card.descriptionKey)}</p>
                    </article>
                  ))}
                </div>

                <div className="panel-lock-highlight-row">
                  {capabilityHighlights.map((card) => (
                    <article key={card.titleKey} className="panel-lock-highlight-card">
                      <h4>{t(card.titleKey)}</h4>
                      <p>{t(card.descriptionKey)}</p>
                    </article>
                  ))}
                </div>
              </>
            ) : null}

            {activeTab === "workflow" ? (
              <>
                <div className="panel-lock-content-header">
                  <h3>{t("lockScreen.journeyTitle")}</h3>
                  <p>{t("lockScreen.journeyDesc")}</p>
                </div>
                <div className="panel-lock-workflow-list">
                  {workflowSteps.map((step, index) => (
                    <article key={step.titleKey} className="panel-lock-workflow-item">
                      <span className="panel-lock-workflow-index">{index + 1}</span>
                      <div>
                        <h4>{t(step.titleKey)}</h4>
                        <p>{t(step.descriptionKey)}</p>
                      </div>
                    </article>
                  ))}
                </div>
              </>
            ) : null}

            {activeTab === "elements" ? (
              <>
                <div className="panel-lock-content-header">
                  <h3>{t("lockScreen.elementsTitle")}</h3>
                  <p>{t("lockScreen.elementsDesc")}</p>
                </div>
                <div className="panel-lock-card-grid">
                  {elementCards.map((card, index) => (
                    <article key={card.titleKey} className="panel-lock-card">
                      <span className="panel-lock-card-index">{(index + 1).toString().padStart(2, "0")}</span>
                      <h4>{t(card.titleKey)}</h4>
                      <p>{t(card.descriptionKey)}</p>
                    </article>
                  ))}
                </div>
              </>
            ) : null}
          </div>
        </section>

        <aside className="panel-lock-auth panel-lock-panel" data-tauri-drag-region="false">
          <span className="panel-lock-badge">
            <Lock size={14} />
            {t("lockScreen.locked")}
          </span>
          <h3>{t("lockScreen.unlockTitle")}</h3>
          <p>{t("lockScreen.unlockDesc")}</p>

          <label className="panel-lock-label" htmlFor="panel-lock-password">
            {t("lockScreen.passwordInput")}
          </label>
          <input
            id="panel-lock-password"
            ref={unlockInputRef}
            type="password"
            value={unlockInput}
            onChange={(event) => setUnlockInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void handleUnlock();
              }
            }}
            className="panel-lock-input"
            placeholder={t("lockScreen.passwordPlaceholder")}
            data-tauri-drag-region="false"
          />
          {unlockError ? (
            <p className="panel-lock-error">{unlockError}</p>
          ) : (
            <p className="panel-lock-hint">{t("lockScreen.passwordHint")}</p>
          )}

          <button
            type="button"
            className="panel-lock-button"
            onClick={() => {
              void handleUnlock();
            }}
            disabled={unlocking}
            data-tauri-drag-region="false"
          >
            {t("lockScreen.unlock")}
          </button>

          <div className="panel-lock-divider" />
          <h4>{t("lockScreen.storageTitle")}</h4>
          <p className="panel-lock-storage-note">{t("lockScreen.storageDesc")}</p>
          <p className="panel-lock-storage-label">{t("lockScreen.storagePathLabel")}</p>
          <code className="panel-lock-storage-path">{PASSWORD_STORAGE_PATH}</code>
        </aside>
      </div>
    </div>
  );
}
