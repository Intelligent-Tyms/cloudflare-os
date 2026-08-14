/** A completed Gadget response that should be delivered back to the chat gateway. */
export type GadgetResponse = {
  text: string;
};

/**
 * Service-binding RPC interface a chat gateway worker exposes for reply delivery. The
 * workshop calls it when the agent turn a gateway submitted completes. Implementations
 * must be idempotent because delivery is at-least-once when acknowledgements fail.
 */
export interface ExternalMessageDelivery {
  /** Deliver the completed Gadget response for the conversation deliveryKey addresses. */
  deliverGadgetResponse(deliveryKey: string, response: GadgetResponse): Promise<void>;
}

/** External message submission accepted by the backend gateway. */
export type SubmitExternalMessageInput = {
  // Selects the Gadgets account used to submit the message.
  // The backend trusts the gateway: supplying this email grants access as that account.
  callerEmail: string;
  // Selects the workspace to create or reuse.
  gadgetKey: string;
  // Selects the chat to create or reuse.
  chatKey: string;
  // Deduplicates the originating message and correlates the response target.
  messageKey: string;
  // Names the workspace if it must be created.
  gadgetTitle: string;
  // User text sent to Gadgets.
  prompt: string;
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
