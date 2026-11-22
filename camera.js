'use strict';

/* =========================================================================
   Level camera: live camera preview with a spirit level from the phone's
   tilt sensor. The photo is taken automatically once the phone is held flat
   (camera pointing straight down) and steady, or by hand with the shutter.
   ========================================================================= */

const LevelCam = (() => {
  const LEVEL_OK = 1.0;      // degrees off level that count as "flat"
  const HOLD_MS = 700;       // hold that long before the automatic photo
  const el = (id) => document.getElementById(id);

  let stream = null, track = null, tilt = null, okSince = 0, busy = false, sensorSeen = false, anim = 0, zoomed = false;

  // angle between the camera axis and straight down, from beta/gamma
  function onOrient(e) {
    if (e.beta == null || e.gamma == null) return;
    if (!sensorSeen) el('camHint').textContent = 'The photo is taken automatically when the bubble is in the green circle.';
    sensorSeen = true;
    const b = e.beta * Math.PI / 180, g = e.gamma * Math.PI / 180;
    const total = Math.acos(Math.min(1, Math.abs(Math.cos(b) * Math.cos(g)))) * 180 / Math.PI;
    tilt = { total, beta: e.beta, gamma: e.gamma, faceDown: Math.abs(e.beta) > 90 };
  }

  function frame() {
    anim = requestAnimationFrame(frame);
    const bubble = el('camBubble'), shutter = el('camShutter'), angle = el('camAngle'), prog = el('camProgress');
    if (!tilt) {
      angle.textContent = sensorSeen ? '…' : 'Hold the phone flat above the object';
      return;
    }
    if (tilt.faceDown) {
      angle.textContent = 'Turn the phone over – screen up, camera down';
      shutter.classList.remove('ok'); bubble.classList.remove('ok'); okSince = 0; prog.style.height = '0';
      return;
    }
    // the bubble goes to the higher side, like a real spirit level (±10° fills the ring)
    const k = 70 / 10;
    const bx = Math.max(-80, Math.min(80, -tilt.gamma * k)), by = Math.max(-80, Math.min(80, -tilt.beta * k));
    bubble.style.transform = `translate(${bx}px, ${by}px)`;
    const ok = tilt.total <= LEVEL_OK;
    bubble.classList.toggle('ok', ok);
    shutter.classList.toggle('ok', ok);
    angle.textContent = ok ? `Level (${tilt.total.toFixed(1)}°) – hold still…` : `Tilted ${tilt.total.toFixed(1)}° – center the bubble`;
    const now = performance.now();
    if (ok) {
      if (!okSince) okSince = now;
      const p = Math.min(1, (now - okSince) / HOLD_MS);
      prog.style.height = `${p * 100}%`;
      if (p >= 1 && !busy) capture();
    } else {
      okSince = 0;
      prog.style.height = '0';
    }
  }

  async function open() {
    // iOS: motion sensors need permission, asked from the button tap itself
    let sensorPromise = null;
    if (window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission === 'function') {
      sensorPromise = DeviceOrientationEvent.requestPermission().catch(() => 'denied');
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert('This browser cannot open the camera inside the page. Use “Phone camera” instead.');
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 4096 }, height: { ideal: 3072 } },
      });
    } catch (err) {
      alert(`The camera could not be opened (${err.name || err}). Use “Phone camera” instead.`);
      return;
    }
    const perm = sensorPromise ? await sensorPromise : 'granted';
    track = stream.getVideoTracks()[0];
    const video = el('camVideo');
    video.srcObject = stream;
    el('camOverlay').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    try { await video.play(); } catch { /* autoplay attribute */ }

    // 2× zoom (less perspective) where the camera supports it
    zoomed = false;
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    el('camZoom').hidden = !(caps.zoom && caps.zoom.max >= 2);
    el('camZoom').classList.remove('on');

    tilt = null; okSince = 0; busy = false; sensorSeen = false;
    el('camHint').textContent = perm === 'denied'
      ? 'Motion sensor not allowed – take the photo by hand, as flat as you can.'
      : 'The photo is taken automatically when the bubble is in the green circle.';
    window.addEventListener('deviceorientation', onOrient);
    setTimeout(() => {
      if (!sensorSeen && stream) {
        el('camHint').textContent = 'No tilt sensor found on this device – take the photo by hand, as flat as you can.';
        el('camAngle').textContent = 'Level unknown';
      }
    }, 1500);
    cancelAnimationFrame(anim);
    frame();
  }

  function close() {
    cancelAnimationFrame(anim);
    window.removeEventListener('deviceorientation', onOrient);
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null; track = null;
    el('camVideo').srcObject = null;
    el('camOverlay').classList.add('hidden');
    document.body.style.overflow = '';
  }

  async function capture() {
    if (busy || !stream) return;
    busy = true;
    const angle = tilt && !tilt.faceDown ? tilt.total : null;
    el('camAngle').textContent = '📸';
    let bmp = null;
    // full-resolution still photo where supported (Chrome on Android) …
    if ('ImageCapture' in window) {
      try {
        const blob = await new ImageCapture(track).takePhoto();
        bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      } catch { bmp = null; }
    }
    // … otherwise the current video frame
    if (!bmp) {
      const v = el('camVideo');
      const c = document.createElement('canvas');
      c.width = v.videoWidth; c.height = v.videoHeight;
      c.getContext('2d').drawImage(v, 0, 0);
      bmp = await createImageBitmap(c);
      c.width = c.height = 0;
    }
    close();
    await processPhoto(bmp, angle);
  }

  async function toggleZoom() {
    if (!track) return;
    zoomed = !zoomed;
    try {
      await track.applyConstraints({ advanced: [{ zoom: zoomed ? 2 : 1 }] });
      el('camZoom').classList.toggle('on', zoomed);
    } catch { zoomed = !zoomed; }
  }

  el('levelCamBtn').addEventListener('click', open);
  el('camClose').addEventListener('click', close);
  el('camShutter').addEventListener('click', capture);
  el('camZoom').addEventListener('click', toggleZoom);

  return { open, close };
})();
