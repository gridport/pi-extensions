// For the live tests: /test-reload reloads the session, and every session start
// posts its reason, so a test can see that a reload happened.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function (pi: ExtensionAPI) {
  pi.on("session_start", (e, ctx) => ctx.ui.notify(`session_start:${e.reason}`, "info"));
  pi.registerCommand("test-reload", {
    description: "reload for tests",
    handler: async (_a, ctx) => {
      await ctx.reload();
    },
  });
}
