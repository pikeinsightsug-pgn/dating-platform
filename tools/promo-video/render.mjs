// Renders the 30-second 9:16 PikeConnection advert to an MP4.
// Usage: node tools/promo-video/render.mjs <output.mp4> [address shown at the end]
// Requires: Playwright (already a dev dependency), ffmpeg, python3.
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const output = process.argv[2] || "pikeconnection-ad.mp4";
const address = process.argv[3] || "deploy-preview-15--pikeconnection.netlify.app";
const FPS = 30, SECONDS = 30;

const music = join(tmpdir(), "pikeconnection-music.wav");
execFileSync("python3", [join(here, "make-music.py"), music], { stdio: "inherit" });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 720, height: 1280 } });
await page.goto("file://" + join(here, "ad-composition.html") + "?url=" + encodeURIComponent(address));
await page.waitForFunction(() => [...document.images].every(img => img.complete && img.naturalWidth > 0));

const ffmpeg = spawn("ffmpeg", [
  "-y", "-loglevel", "error",
  "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "mjpeg", "-i", "-",
  "-i", music,
  "-c:v", "libx264", "-preset", "slow", "-crf", "22", "-pix_fmt", "yuv420p", "-profile:v", "high",
  "-c:a", "aac", "-b:a", "128k", "-shortest", "-movflags", "+faststart",
  output
], { stdio: ["pipe", "inherit", "inherit"] });

for (let frame = 0; frame < FPS * SECONDS; frame++) {
  await page.evaluate(t => window.renderAt(t), frame / FPS);
  const jpeg = await page.screenshot({ type: "jpeg", quality: 92 });
  if (!ffmpeg.stdin.write(jpeg)) await new Promise(resolve => ffmpeg.stdin.once("drain", resolve));
}
ffmpeg.stdin.end();
const code = await new Promise(resolve => ffmpeg.on("close", resolve));
await browser.close();
if (code !== 0) throw new Error("ffmpeg failed with code " + code);
console.log("wrote", output);
