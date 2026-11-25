import { PostHog } from 'posthog-node';

let client: PostHog | null = null;

export function getPostHogClient(): PostHog | null {
  if (client) return client;
  const apiKey = process.env.POSTHOG_API_KEY;
  if (!apiKey) return null;

  try {
    client = new PostHog(apiKey, {
      host: process.env.POSTHOG_HOST || 'https://app.posthog.com',
      flushAt: 1,
      flushInterval: 0,
    });
  } catch {
    client = null;
  }
  return client;
}

export function capture(
  userId: string,
  event: string,
  properties?: Record<string, unknown>
): void {
  try {
    const posthog = getPostHogClient();
    if (!posthog) return;
    posthog.capture({
      distinctId: userId,
      event,
      properties: properties || {},
    });
  } catch {
    // Fail silently in analytics
  }
}
