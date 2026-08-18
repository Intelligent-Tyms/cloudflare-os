// Email notification for direct workspace shares, delivered through the central team
// directory's notification endpoint (same credentials as team-directory.ts). Deployments
// without a directory have no mailer, so sharing there stays silent and the share UI falls
// back to "copy the workspace link". Notification is strictly best-effort: a share must
// never fail, block, or surface an error because an email could not be sent, so this module
// reports success as a boolean and never throws.

/** Whether this deployment can send share-notification emails at all. */
export function hasShareNotifications(env: Cloudflare.Env): boolean {
  return Boolean(env.CENTRAL_TEAM_API_URL && env.CENTRAL_TEAM_API_TOKEN);
}

/**
 * Ask the directory to email `recipientEmail` that `sharedBy` shared this workspace with them.
 * Returns whether an email actually went out. The directory declines silently (false) for
 * recipients who are not members of the deployment, and builds the workspace URL itself from
 * `workspaceId` -- the raw ids here carry no secrets, since the share already granted access.
 */
export async function notifyWorkspaceShared(env: Cloudflare.Env, opts: {
  recipientEmail: string;
  sharedBy: string;
  workspaceId: string;
  workspaceTitle: string;
  role: "build" | "use";
}): Promise<boolean> {
  if (!hasShareNotifications(env)) return false;
  try {
    let response = await fetch(`${env.CENTRAL_TEAM_API_URL}/notifications/workspace-shared`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.CENTRAL_TEAM_API_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(opts),
    });
    let data = (await response.json().catch(() => ({}))) as {notified?: boolean};
    if (!response.ok) {
      console.warn(`share notification failed (${response.status})`);
      return false;
    }
    return data.notified === true;
  } catch (err) {
    console.warn("share notification failed:", err);
    return false;
  }
}
