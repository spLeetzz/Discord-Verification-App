import sharp from "sharp";
import Tesseract from "tesseract.js";
import type { Worker } from "tesseract.js";

export async function probe(): Promise<string> {
  const buf = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#fff" } })
    .png()
    .toBuffer();
  const worker: Worker = await Tesseract.createWorker("eng", Tesseract.OEM.LSTM_ONLY);
  await worker.terminate();
  return buf.toString("base64");
}
