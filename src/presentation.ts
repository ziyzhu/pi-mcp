export const managedCapabilities = { read: true, send: true, steer: true, followUp: true, stop: true, interactions: true, fork: false };
export const savedCapabilities = { read: true, send: false, steer: false, followUp: false, stop: false, interactions: false, fork: true };

export function messagePage(messages: unknown[], before?: number, limit = 10): { messages: unknown[]; before: number | null } {
  const end = Math.min(before ?? messages.length, messages.length);
  const start = Math.max(0, end - Math.min(limit, 20));
  return {
    messages: messages.slice(start, end).map((message) => {
      const text = JSON.stringify(message);
      return text.length <= 32_768 ? message : { truncated: true, preview: text.slice(0, 32_768) };
    }),
    before: start || null,
  };
}
