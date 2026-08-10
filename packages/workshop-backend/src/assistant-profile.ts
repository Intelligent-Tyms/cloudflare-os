// Per-user assistant personalization: validation of user-submitted AssistantProfile objects
// before they are stored on the user durable object. (The system-prompt formatter for the
// profile will live here too.)

import { AssistantProfile, MAX_ASSISTANT_FIELD_LENGTH, MAX_ASSISTANT_NAME_LENGTH, MAX_ASSISTANT_PERSONA_LENGTH } from "@gadgets/workshop-shared/api";

// Trim and validate a user-submitted assistant profile, throwing a descriptive error on any
// violation. Returns the canonical (trimmed, known-fields-only) form to store.
export function validateAssistantProfile(profile: AssistantProfile): AssistantProfile {
  let clean: AssistantProfile = {
    assistantName: cleanField("assistant name", profile.assistantName, MAX_ASSISTANT_NAME_LENGTH),
    persona: cleanField("persona", profile.persona, MAX_ASSISTANT_PERSONA_LENGTH),
    role: cleanField("role", profile.role, MAX_ASSISTANT_FIELD_LENGTH),
    targets: cleanField("targets", profile.targets, MAX_ASSISTANT_FIELD_LENGTH),
    goals: cleanField("goals", profile.goals, MAX_ASSISTANT_FIELD_LENGTH),
    timeZone: cleanField("time zone", profile.timeZone, 64),
  };

  if (clean.timeZone !== "") {
    // Validate against the runtime's own IANA database rather than a hardcoded list.
    try {
      new Intl.DateTimeFormat("en", { timeZone: clean.timeZone }).resolvedOptions();
    } catch {
      throw new Error(`Unknown time zone: ${clean.timeZone}`);
    }
  }

  return clean;
}

function cleanField(field: string, value: string, max: number): string {
  if (typeof value !== "string") {
    throw new Error(`Assistant profile ${field} must be a string.`);
  }
  let trimmed = value.trim();
  if (trimmed.length > max) {
    throw new Error(
        `Assistant profile ${field} is too long (${trimmed.length} > ${max} characters).`);
  }
  return trimmed;
}
