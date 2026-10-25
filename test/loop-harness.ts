// A fake pi and session for loop.ts: records what it sends, notifies and
// saves, and lets a test set whether the session is idle or has messages queued.
import ext from "../extensions/loop.ts";

export const T = (s: string) => new Date(s).getTime(); // local time

export function env(entries: any[] = []) {
  const handlers: Record<string, (...args: any[]) => any> = {};
  let tool: any, command: any;
  const sent: string[] = [],
    notes: [string, string][] = [];
  const state = { idle: true, pending: false };
  const pi: any = {
    on: (e: string, h: (...args: any[]) => any) => (handlers[e] = h),
    registerTool: (t: any) => (tool = t),
    registerCommand: (_n: string, c: any) => (command = c),
    appendEntry: (customType: string, data: unknown) =>
      entries.push({ type: "custom", customType, data: structuredClone(data) }),
    sendUserMessage: (m: string) => sent.push(m),
  };
  const ctx: any = {
    isIdle: () => state.idle,
    hasPendingMessages: () => state.pending,
    ui: { notify: (m: string, t: string) => notes.push([t, m]), setStatus: () => {} },
    sessionManager: { getEntries: () => entries },
  };
  ext(pi);
  const create = (cron: string, prompt: string, recurring = true) =>
    tool.execute("c", { action: "create", cron, prompt, recurring }, undefined, undefined, ctx);
  const list = async () =>
    (await tool.execute("l", { action: "list" }, undefined, undefined, ctx)).content[0].text as string;
  return { handlers, sent, notes, entries, state, ctx, create, list, command: () => command };
}
