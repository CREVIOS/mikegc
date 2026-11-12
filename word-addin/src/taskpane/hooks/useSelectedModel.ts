import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiKeyStatus } from "../api/client";
import {
  canonicalModelId,
  defaultChatModel,
  isAllowedModelId,
  isRouterModelSelected,
  type RouterSelections,
} from "@mike/model-catalog";
import { isModelAvailable } from "../lib/modelCatalog";

interface SelectedModelSources {
  sessionKey: number;
  chatModel?: string | null;
  lastSelectedModel?: string | null;
  /** The deployment's configured default chat model, if any. */
  deploymentDefaultModel?: string | null;
  routerSelections?: RouterSelections | null;
  /** Null means the key-status request failed and availability fails open. */
  apiKeyStatus: ApiKeyStatus | null;
}

function usableStoredModel(
  value: string | null | undefined,
  sources: SelectedModelSources,
): string | null {
  if (!value) return null;
  const model = canonicalModelId(value);
  if (!isAllowedModelId(model)) return null;
  if (
    sources.routerSelections &&
    !isRouterModelSelected(model, sources.routerSelections)
  ) {
    return null;
  }
  return isModelAvailable(model, sources.apiKeyStatus) ? model : null;
}

/**
 * Resolve the saved chat model first, then the profile's shared last-selected,
 * then the deployment default (OpenAI first) once key status is known.
 */
export function useSelectedModel(
  sources: SelectedModelSources,
): [string, (model: string) => void, boolean] {
  const [model, setModelState] = useState("");
  const [settingsResolved, setSettingsResolved] = useState(
    sources.chatModel !== undefined,
  );
  const manualSelection = useRef(false);
  const previousSessionKey = useRef(sources.sessionKey);
  const routerSelections = sources.routerSelections;

  useEffect(() => {
    if (previousSessionKey.current !== sources.sessionKey) {
      previousSessionKey.current = sources.sessionKey;
      manualSelection.current = false;
    }
    if (manualSelection.current) return;
    if (sources.chatModel === undefined) {
      // Existing chat settings have not loaded yet. Do not flash the shared
      // profile fallback before the chat's own model arrives.
      setModelState("");
      setSettingsResolved(false);
      return;
    }
    const next =
      usableStoredModel(sources.chatModel, sources) ??
      usableStoredModel(sources.lastSelectedModel, sources) ??
      (sources.apiKeyStatus
        ? defaultChatModel(
            (id) => usableStoredModel(id, sources) === id,
            sources.deploymentDefaultModel,
          )
        : "");
    setModelState(next);
    setSettingsResolved(true);
  }, [
    sources.sessionKey,
    sources.chatModel,
    sources.lastSelectedModel,
    sources.deploymentDefaultModel,
    sources.apiKeyStatus,
    routerSelections,
  ]); // eslint-disable-line react-hooks/exhaustive-deps

  const setModel = useCallback((raw: string): void => {
    const next = canonicalModelId(raw);
    manualSelection.current = true;
    setModelState(isAllowedModelId(next) ? next : "");
    setSettingsResolved(true);
  }, []);
  return [model, setModel, settingsResolved];
}
