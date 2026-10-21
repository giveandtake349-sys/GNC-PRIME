import { Router, type Request, type Response } from "express";
import { routeChat } from "../gateway/router.js";
import { GNC_MODELS, type GncModelId } from "../gateway/types.js";

export const chatRouter = Router();

// POST /api/chat { model, message } -> { reply, engineUsed }
//
// AUTH — honest placeholder:
// - DEV_AUTH=1 (local dev only): accept the `x-dev-user` header as the user.
// - Otherwise: 501. Own JWT auth verification lands in the next build step.
//   There is deliberately no fake auth here.
chatRouter.post("/chat", async (req: Request, res: Response) => {
  if (process.env.DEV_AUTH === "1") {
    const devUser = req.header("x-dev-user");
    if (!devUser) {
      res.status(401).json({ error: "DEV_AUTH is on: send an x-dev-user header" });
      return;
    }
  } else {
    res.status(501).json({
      error:
        "Auth not implemented yet: own JWT auth lands in the next step. For local dev set DEV_AUTH=1 and send an x-dev-user header.",
    });
    return;
  }

  const { model, message } = (req.body ?? {}) as {
    model?: string;
    message?: string;
  };
  if (!message || typeof message !== "string") {
    res.status(400).json({ error: "message is required" });
    return;
  }
  const modelId = (model ?? "gnc-flash") as GncModelId;
  if (!GNC_MODELS.some((m) => m.id === modelId)) {
    res.status(400).json({ error: `Unknown model: ${modelId}` });
    return;
  }

  try {
    const result = await routeChat(modelId, message);
    res.json({ reply: result.reply, engineUsed: result.engineUsed });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: msg });
  }
});
