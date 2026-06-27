import { useCallback, useEffect, useState } from "react";
import { getClientStoreSync, writeClientStoreValue } from "../../../services/clientStorage";

type UseSidebarTogglesOptions = {
  isCompact: boolean;
};

function readStoredBool(key: string, defaultValue = false) {
  const stored = getClientStoreSync<boolean>("layout", key);
  if (stored === undefined) {
    return defaultValue;
  }
  return stored;
}

export function useSidebarToggles({ isCompact }: UseSidebarTogglesOptions) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [rightPanelCollapsed, setRightPanelCollapsed] = useState(() =>
    readStoredBool("rightPanelCollapsed", false),
  );

  useEffect(() => {
    writeClientStoreValue("layout", "sidebarCollapsed", sidebarCollapsed);
  }, [sidebarCollapsed]);

  useEffect(() => {
    writeClientStoreValue("layout", "rightPanelCollapsed", rightPanelCollapsed);
  }, [rightPanelCollapsed]);

  const collapseSidebar = useCallback(() => {
    if (!isCompact) {
      setSidebarCollapsed((current) => (current ? current : true));
    }
  }, [isCompact]);

  const expandSidebar = useCallback(() => {
    if (!isCompact) {
      setSidebarCollapsed((current) => (current ? false : current));
    }
  }, [isCompact]);

  const collapseRightPanel = useCallback(() => {
    if (!isCompact) {
      setRightPanelCollapsed((current) => (current ? current : true));
    }
  }, [isCompact]);

  const expandRightPanel = useCallback(() => {
    if (!isCompact) {
      setRightPanelCollapsed((current) => (current ? false : current));
    }
  }, [isCompact]);

  return {
    sidebarCollapsed,
    rightPanelCollapsed,
    collapseSidebar,
    expandSidebar,
    collapseRightPanel,
    expandRightPanel,
  };
}
