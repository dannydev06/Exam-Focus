import { createWorker } from "tesseract.js";
import { pdf as pdfToImages } from "pdf-to-img";
import { createRequire } from "node:module";
import path from "node:path";

const MAX_PAGES = 40; // keeps a huge scanned textbook from running for hours

let worker: Awaited<ReturnType<typeof createWorker>> | null = null;
async function getWorker() {
  if (!worker) {
    // English language data ships inside node_modules, so OCR works offline with no keys and no limits
    const dir = path.dirname(createRequire(import.meta.url).resolve("@tesseract.js-data/eng/package.json"));
    worker = await createWorker("eng", 1, { langPath: path.join(dir, "4.0.0_best_int"), cacheMethod: "none" });
  }
  return worker;
}

/** Reads text from a scanned PDF or an image (png / jpg). Runs locally. */
export async function ocr(buffer: Buffer, mimetype: string): Promise<string> {
  const w = await getWorker();
  if (!mimetype.includes("pdf")) return (await w.recognize(buffer)).data.text;
  const pages: string[] = [];
  let n = 0;
  for await (const png of await pdfToImages(buffer, { scale: 3 })) { // ~216 dpi
    if (++n > MAX_PAGES) break;
    pages.push((await w.recognize(Buffer.from(png))).data.text);
    console.log(`OCR page ${n} done`);
  }
  return pages.join("\n\n");
}
