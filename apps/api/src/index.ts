import express from "express";
import { authRouter } from "./routes/auth.js";
import { chatRouter } from "./routes/chat.js";
import { conversationsRouter } from "./routes/conversations.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

// Health never touches the DB — it must answer even with no DATABASE_URL.
app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/api/auth", authRouter);
app.use("/api/conversations", conversationsRouter);
app.use("/api", chatRouter);

const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => {
  console.log(`@gnc/api listening on http://localhost:${port}`);
});
