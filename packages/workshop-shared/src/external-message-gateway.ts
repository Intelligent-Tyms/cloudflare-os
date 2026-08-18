/** A completed Gadget response that should be delivered back to the chat gateway. */
export type GadgetResponse = {
  text: string;
};

/**
 * How the gateway actually delivered a response, reported back so the workshop can meter
 * modalities with a real per-delivery cost (synthesized voice). "text" or an absent report
 * costs nothing extra; a deduplicated re-delivery reports nothing.
 */
export type ExternalMessageDeliveryReport = {
  deliveredAs?: "voice" | "text";
};

/**
 * Service-binding RPC interface a chat gateway worker exposes for reply delivery. The
 * workshop calls it when the agent turn a gateway submitted completes. Implementations
 * must be idempotent because delivery is at-least-once when acknowledgements fail.
 */
export interface ExternalMessageDelivery {
  /** Deliver the completed Gadget response for the conversation deliveryKey addresses. */
  deliverGadgetResponse(
    deliveryKey: string,
    response: GadgetResponse,
  ): Promise<ExternalMessageDeliveryReport | void>;
}

/** External message submission accepted by the backend gateway. */
export type SubmitExternalMessageInput = {
  // Selects the Gadgets account used to submit the message.
  // The backend trusts the gateway: supplying this email grants access as that account.
  // Messages land in that account's home assistant workspace (created on first use);
  // the gateway does not pick a workspace.
  callerEmail: string;
  // Selects the chat thread to create or reuse inside the home workspace.
  chatKey: string;
  // Deduplicates the originating message and correlates the response target.
  messageKey: string;
  // User text sent to Gadgets.
  prompt: string;
  // Present when the message arrived as a voice note the gateway transcribed (prompt is
  // the transcript). Transcription runs on the platform's speech account, so accepted
  // voice notes are metered as a paid "voice" message leg.
  voiceNote?: {
    durationSeconds?: number;
  };
  // Names a service binding on the workshop worker that implements ExternalMessageDelivery
  // (injected by deploy tooling alongside the gateway's own binding). Stored durably with
  // deliveryKey as the reply route: plain strings survive restarts, unlike RPC stubs, which
  // production workerd refuses to persist.
  replyBinding: string;
  // Opaque address the gateway uses to route the reply to the right conversation.
  deliveryKey: string;
};

/** Submission result returned by the backend gateway. */
export type SubmitExternalMessageResult =
  | {
      accepted: true;
      chatPath: string;
    }
  | {
      accepted: false;
      // User-facing explanation of an actionable submission rejection.
      message: string;
    };

/** Service binding RPC interface used by chat gateway workers. */
export interface ExternalMessageGateway {
  /** Submit an external chat message for Gadget routing and execution. */
  submitExternalMessage(input: SubmitExternalMessageInput): Promise<SubmitExternalMessageResult>;
}
