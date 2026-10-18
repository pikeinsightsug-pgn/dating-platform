// Profile photo cropper: lets a member zoom, reposition and crop a photo to the 4:3 shape used
// on Discover cards, shows the final result, and returns a JPEG Blob ready for the existing
// private upload. Works with touch (drag, pinch), mouse (drag, wheel) and keyboard (arrows, +/-).
// Requires assets/member-core.js (window.FYP.decodeImage).
(function (root) {
  "use strict";

  const OUT_W = 1200;
  const OUT_H = 900;
  const MAX_ZOOM = 4;
  const MAX_BYTES = 5 * 1024 * 1024;
  const DECODE_MESSAGE = "This photo could not be opened on this device. If your phone saves photos as HEIC, change the camera setting to “Most compatible”, or take a screenshot of the photo and choose that.";

  const STYLE = `
.crop-dialog{border:0;border-radius:20px;padding:0;width:min(94vw,480px);max-height:94vh;box-shadow:0 20px 60px #2a0d1a55;color:#2c2027}
.crop-dialog::backdrop{background:#1d0a1399}
.crop-body{padding:18px;display:grid;gap:12px}
.crop-body h2{margin:0;font-size:20px}.crop-body p{margin:0;font-size:14px;color:#6a5b64;line-height:1.45}
.crop-stage{position:relative;width:100%;aspect-ratio:4/3;border-radius:14px;overflow:hidden;background:#2c2027;touch-action:none;cursor:grab;outline-offset:3px}
.crop-stage:active{cursor:grabbing}
.crop-stage canvas{display:block;width:100%;height:100%}
.crop-stage::after{content:"";position:absolute;inset:0;pointer-events:none;border:2px solid #ffffffcc;border-radius:14px;
  background:linear-gradient(#ffffff55,#ffffff55) 33.33% 0/1px 100% no-repeat,linear-gradient(#ffffff55,#ffffff55) 66.66% 0/1px 100% no-repeat,
  linear-gradient(#ffffff55,#ffffff55) 0 33.33%/100% 1px no-repeat,linear-gradient(#ffffff55,#ffffff55) 0 66.66%/100% 1px no-repeat}
.crop-zoom{display:flex;align-items:center;gap:10px}.crop-zoom input{flex:1;accent-color:#a21f59;min-height:32px}
.crop-zoom button{width:40px;height:40px;padding:0;border-radius:50%;font-size:20px;line-height:1}
.crop-result{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:14px;background:#fde8f0;display:block}
.crop-actions{display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap}.crop-actions button{min-height:44px}
.crop-error{color:#a21f59;font-weight:600}.crop-dialog .hidden{display:none!important}`;

  let dialog = null;
  let els = null;

  function build() {
    const style = document.createElement("style");
    style.textContent = STYLE;
    document.head.append(style);
    dialog = document.createElement("dialog");
    dialog.className = "crop-dialog";
    dialog.setAttribute("aria-labelledby", "crop-title");
    dialog.innerHTML = `
<div class="crop-body" id="crop-adjust">
  <h2 id="crop-title">Adjust your photo</h2>
  <p>Drag to reposition. Pinch, scroll or use the slider to zoom. The frame shows exactly what members will see.</p>
  <div class="crop-stage" id="crop-stage" tabindex="0" role="img" aria-label="Photo crop area. Use arrow keys to move and plus or minus to zoom."><canvas id="crop-canvas" width="${OUT_W}" height="${OUT_H}"></canvas></div>
  <div class="crop-zoom"><button type="button" class="secondary" id="crop-out" aria-label="Zoom out">−</button>
    <input id="crop-zoom" type="range" min="1" max="${MAX_ZOOM}" step="0.01" value="1" aria-label="Zoom">
    <button type="button" class="secondary" id="crop-in" aria-label="Zoom in">+</button></div>
  <div class="crop-actions"><button type="button" class="secondary" id="crop-cancel">Cancel</button><button type="button" id="crop-preview">Preview crop</button></div>
</div>
<div class="crop-body hidden" id="crop-confirm">
  <h2>Your new profile photo</h2>
  <p>This is how your photo will appear to approved members.</p>
  <img id="crop-result" class="crop-result" alt="Cropped profile photo">
  <p id="crop-error" class="crop-error hidden" role="alert"></p>
  <div class="crop-actions"><button type="button" class="secondary" id="crop-back">Adjust again</button><button type="button" id="crop-use">Use this photo</button></div>
</div>`;
    document.body.append(dialog);
    const $ = id => dialog.querySelector("#" + id);
    els = {
      adjust: $("crop-adjust"), confirm: $("crop-confirm"), stage: $("crop-stage"), canvas: $("crop-canvas"),
      zoom: $("crop-zoom"), zoomIn: $("crop-in"), zoomOut: $("crop-out"), cancel: $("crop-cancel"),
      preview: $("crop-preview"), result: $("crop-result"), error: $("crop-error"), back: $("crop-back"), use: $("crop-use")
    };
  }

  function encode(canvas, quality) {
    return new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", quality));
  }

  // Opens the cropper for one file. Resolves with { blob, type, extension } or null if cancelled.
  async function openPhotoCropper(file) {
    let image;
    try { image = await root.FYP.decodeImage(file); }
    catch (error) { throw Object.assign(new Error(DECODE_MESSAGE), { code: "PHOTO_DECODE" }); }
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    if (!width || !height) throw Object.assign(new Error(DECODE_MESSAGE), { code: "PHOTO_DECODE" });
    if (!dialog) build();

    const ctx = els.canvas.getContext("2d");
    const cover = Math.max(OUT_W / width, OUT_H / height); // zoom 1 always fills the frame
    let zoom = 1, x = 0, y = 0; // x, y: image centre offset from the frame centre, in output pixels
    let resultUrl = null;

    function clamp() {
      const s = cover * zoom;
      const maxX = Math.max(0, (width * s - OUT_W) / 2);
      const maxY = Math.max(0, (height * s - OUT_H) / 2);
      x = Math.min(maxX, Math.max(-maxX, x));
      y = Math.min(maxY, Math.max(-maxY, y));
    }
    function draw(target) {
      const s = cover * zoom;
      const c = target.getContext("2d");
      c.imageSmoothingQuality = "high";
      c.fillStyle = "#ffffff";
      c.fillRect(0, 0, OUT_W, OUT_H); // transparent PNG areas become white, not black, in the JPEG
      c.drawImage(image, OUT_W / 2 + x - (width * s) / 2, OUT_H / 2 + y - (height * s) / 2, width * s, height * s);
    }
    function render() { clamp(); draw(els.canvas); els.zoom.value = String(zoom); }
    function setZoom(value) { zoom = Math.min(MAX_ZOOM, Math.max(1, value)); render(); }
    function toOutput(px) { return px * OUT_W / (els.stage.clientWidth || OUT_W); }

    const pointers = new Map();
    let pinchStart = 0, zoomAtPinch = 1;
    function onDown(event) {
      try { els.stage.setPointerCapture(event.pointerId); } catch (error) { /* capture is optional */ }
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinchStart = Math.hypot(a.x - b.x, a.y - b.y); zoomAtPinch = zoom;
      }
    }
    function onMove(event) {
      const last = pointers.get(event.pointerId);
      if (!last) return;
      const now = { x: event.clientX, y: event.clientY };
      pointers.set(event.pointerId, now);
      if (pointers.size === 1) {
        x += toOutput(now.x - last.x); y += toOutput(now.y - last.y); render();
      } else if (pointers.size === 2 && pinchStart > 0) {
        const [a, b] = [...pointers.values()];
        setZoom(zoomAtPinch * Math.hypot(a.x - b.x, a.y - b.y) / pinchStart);
      }
    }
    function onUp(event) { pointers.delete(event.pointerId); if (pointers.size < 2) pinchStart = 0; }
    function onWheel(event) { event.preventDefault(); setZoom(zoom * (event.deltaY < 0 ? 1.08 : 1 / 1.08)); }
    function onKey(event) {
      const step = 20;
      const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
      if (moves[event.key]) { x += moves[event.key][0]; y += moves[event.key][1]; render(); }
      else if (event.key === "+" || event.key === "=") setZoom(zoom * 1.1);
      else if (event.key === "-") setZoom(zoom / 1.1);
      else return;
      event.preventDefault();
    }
    function showStep(confirming) {
      els.adjust.classList.toggle("hidden", confirming);
      els.confirm.classList.toggle("hidden", !confirming);
      els.error.classList.add("hidden");
    }

    return new Promise(resolve => {
      let output = null;
      const listeners = [
        [els.stage, "pointerdown", onDown], [els.stage, "pointermove", onMove], [els.stage, "pointerup", onUp],
        [els.stage, "pointercancel", onUp], [els.stage, "wheel", onWheel, { passive: false }], [els.stage, "keydown", onKey],
        [els.zoom, "input", () => setZoom(Number(els.zoom.value))],
        [els.zoomIn, "click", () => setZoom(zoom * 1.15)], [els.zoomOut, "click", () => setZoom(zoom / 1.15)],
        [els.cancel, "click", () => finish(null)],
        [els.back, "click", () => showStep(false)],
        [els.preview, "click", async () => {
          els.preview.disabled = true;
          const canvas = document.createElement("canvas");
          canvas.width = OUT_W; canvas.height = OUT_H;
          draw(canvas);
          let blob = await encode(canvas, 0.88);
          if (blob && blob.size > MAX_BYTES) blob = await encode(canvas, 0.7);
          els.preview.disabled = false;
          output = blob;
          if (resultUrl) URL.revokeObjectURL(resultUrl);
          resultUrl = blob ? URL.createObjectURL(blob) : "";
          els.result.src = resultUrl;
          showStep(true);
          if (!blob || blob.size > MAX_BYTES) {
            output = null;
            els.error.textContent = "This photo could not be prepared on this device. Choose a different photo.";
            els.error.classList.remove("hidden");
          }
          els.use.disabled = !output;
          els.use.focus();
        }],
        [els.use, "click", () => output && finish({ blob: output, type: "image/jpeg", extension: "jpg" })],
        [dialog, "cancel", event => { event.preventDefault(); finish(null); }]
      ];
      listeners.forEach(([node, type, fn, options]) => node.addEventListener(type, fn, options));
      function finish(value) {
        listeners.forEach(([node, type, fn, options]) => node.removeEventListener(type, fn, options));
        pointers.clear();
        if (resultUrl) URL.revokeObjectURL(resultUrl);
        if (typeof image.close === "function") image.close();
        dialog.close();
        resolve(value);
      }
      showStep(false);
      render();
      dialog.showModal();
      els.stage.focus();
    });
  }

  root.FYP = Object.assign(root.FYP || {}, { openPhotoCropper, CROP_SIZE: { width: OUT_W, height: OUT_H } });
})(typeof window !== "undefined" ? window : globalThis);
