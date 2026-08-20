import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";

const LAST_SELECTED_MODEL_KEY = "lastSelectedModel";

/** Sentinel used for UI values and localStorage so an explicit null choice can persist. */
export const NO_AGENT_OPTION_VALUE = "__gadgets_no_agent__";

export function getStoredSelectedModel(
  models: AiChatAuthorInfo[],
): string | null {
  const storedModel = localStorage.getItem(LAST_SELECTED_MODEL_KEY);

  if (storedModel === NO_AGENT_OPTION_VALUE) {
    return null;
  }

  if (storedModel && models.some((model) => model.id === storedModel)) {
    return storedModel;
  }

  // Default: Return the first configured model, or null if none are configured.
  return models[0]?.id ?? null;
}

/**
 * Validate a model selection against the currently offered models, falling back to the stored
 * selection (which self-validates) and then the first offered model. `null` stays null -- that's
 * the explicit "No agent" choice. Selections can go stale several ways: a model inferred from an
 * old chat's messages, an active agent started before an admin disabled its model, or a
 * localStorage id from before a catalog change -- the server refuses disabled models, so an
 * unvalidated selection would send and then error.
 */
export function validateModelSelection(
  modelId: string | null,
  models: AiChatAuthorInfo[],
): string | null {
  if (modelId === null || models.some((model) => model.id === modelId)) {
    return modelId;
  }
  return getStoredSelectedModel(models);
}

export function persistSelectedModel(modelId: string | null): void {
  localStorage.setItem(
    LAST_SELECTED_MODEL_KEY,
    modelId ?? NO_AGENT_OPTION_VALUE,
  );
}

export function toModelSelectValue(modelId: string | null): string {
  return modelId ?? NO_AGENT_OPTION_VALUE;
}

export function fromModelSelectValue(value: string): string | null {
  return value === NO_AGENT_OPTION_VALUE ? null : value;
}
