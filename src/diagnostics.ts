export function diagnostic(event: string, fields: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({ timestamp: new Date().toISOString(), category: "pi-mcp", event, ...fields }));
}
