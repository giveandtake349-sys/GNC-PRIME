import express from "express";
import { chatRouter } from "./routes/chat.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/api", chatRouter);

const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => {
  console.log(`@gnc/api listening on http://localhost:${port}`);
});
