import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  countMissingMinutes,
  dateRange,
  fillMissingCandles,
  isDateString,
  normalizeRawCandle
} from "../src/shared/candles";
import type { DatasetResponse, RawBithumbCandle } from "../src/shared/types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const dataRoot = path.join(rootDir, "data", "bithumb");
const port = Number(process.env.API_PORT ?? 5174);

const app = express();

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/datasets", async (_req, res, next) => {
  try {
    const datasets: DatasetResponse["datasets"] = [];
    const markets = await listDirectories(dataRoot);

    for (const market of markets) {
      const marketPath = path.join(dataRoot, market);
      const intervals = [];
      const intervalNames = await listDirectories(marketPath);

      for (const interval of intervalNames) {
        const intervalPath = path.join(marketPath, interval);
        const files = (await fs.readdir(intervalPath))
          .filter((file) => /^\d{4}-\d{2}-\d{2}\.json$/.test(file))
          .sort();

        const dates = [];
        for (const file of files) {
          const date = file.replace(".json", "");
          const raw = await readCandlesFile(path.join(intervalPath, file));
          dates.push({
            date,
            count: raw.length,
            missing: countMissingMinutes(raw, date)
          });
        }

        intervals.push({ interval, dates });
      }

      datasets.push({ market, intervals });
    }

    res.json({ datasets });
  } catch (error) {
    next(error);
  }
});

app.get("/api/candles", async (req, res, next) => {
  try {
    const market = String(req.query.market ?? "KRW-USDT");
    const interval = String(req.query.interval ?? "1m");
    const from = String(req.query.from ?? "");
    const to = String(req.query.to ?? from);

    if (!/^[A-Z0-9-]+$/.test(market) || !/^[a-z0-9]+$/.test(interval)) {
      res.status(400).json({ error: "Invalid market or interval" });
      return;
    }

    if (!isDateString(from) || !isDateString(to) || from > to) {
      res.status(400).json({ error: "Invalid date range" });
      return;
    }

    const raw: RawBithumbCandle[] = [];
    for (const date of dateRange(from, to)) {
      const filePath = path.join(dataRoot, market, interval, `${date}.json`);
      raw.push(...(await readCandlesFile(filePath)));
    }

    const candles = fillMissingCandles(raw.map(normalizeRawCandle), from, to);
    res.json({ market, interval, from, to, candles });
  } catch (error) {
    next(error);
  }
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = error instanceof Error ? error.message : "Unexpected error";
  res.status(500).json({ error: message });
});

app.listen(port, () => {
  console.log(`Backtest API listening on http://localhost:${port}`);
});

async function listDirectories(dir: string) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

async function readCandlesFile(filePath: string): Promise<RawBithumbCandle[]> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(content) as unknown;
    return Array.isArray(parsed) ? (parsed as RawBithumbCandle[]) : [];
  } catch {
    return [];
  }
}
