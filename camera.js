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
  let lastOrient = 0, noSensor = false;
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isIOSNonSafari = isIOS && /CriOS|FxiOS|EdgiOS|OPiOS|GSA\//.test(navigator.userAgent);
  const OK_HINT = 'The photo is taken automatically when the bubble is in the green circle.';

  // angle between the camera axis and straight down, from beta/gamma
  function onOrient(e) {
    if (e.beta == null || e.gamma == null) return;
    if (!sensorSeen) el('camHint').textContent = OK_HINT;
    sensorSeen = true; lastOrient = performance.now();
    const b = e.beta * Math.PI / 180, g = e.gamma * Math.PI / 180;
    const total = Math.acos(Math.min(1, Math.abs(Math.cos(b) * Math.cos(g)))) * 180 / Math.PI;
    tilt = { total, beta: e.beta, gamma: e.gamma, faceDown: Math.abs(e.beta) > 90 };
  }

  // second source: the gravity vector from the motion sensor
  function onMotion(e) {
    const g = e.accelerationIncludingGravity;
    if (!g || g.x == null || g.z == null) return;
    if (performance.now() - lastOrient < 500) return;     // orientation events preferred
    const n = Math.hypot(g.x, g.y, g.z);
    if (n < 5) return;                                       // moving too much
    if (!sensorSeen) el('camHint').textContent = OK_HINT;
    sensorSeen = true;
    const total = Math.acos(Math.min(1, Math.abs(g.z) / n)) * 180 / Math.PI;
    // equivalent beta/gamma for the bubble (signs differ between platforms – the
    // bubble follows the higher side like the orientation-based one)
    const s = isIOS ? -1 : 1;
    const beta = Math.asin(Math.max(-1, Math.min(1, s * g.y / n))) * 180 / Math.PI;
    const gamma = Math.asin(Math.max(-1, Math.min(1, -s * g.x / n))) * 180 / Math.PI;
    tilt = { total, beta, gamma, faceDown: false };          // the sign of z differs between platforms
  }

  function frame() {
    anim = requestAnimationFrame(frame);
    const bubble = el('camBubble'), shutter = el('camShutter'), angle = el('camAngle'), prog = el('camProgress');
    if (!tilt) {
      if (!noSensor) angle.textContent = sensorSeen ? '…' : 'Hold the phone flat above the object';
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

    // start at 2× zoom (less perspective, box sides stay out of view) where
    // the camera allows it; the button switches between 2× and 1×
    zoomed = false;
    el('camZoom').classList.remove('on');
    el('camZoom').hidden = true;
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    if (!caps.zoom || caps.zoom.max >= 2) {
      try {
        await track.applyConstraints({ advanced: [{ zoom: 2 }] });
        const set = track.getSettings ? track.getSettings() : {};
        if (set.zoom === 2 || (caps.zoom && caps.zoom.max >= 2)) {
          zoomed = true;
          el('camZoom').hidden = false;
          el('camZoom').classList.add('on');
        }
      } catch { /* no zoom on this camera / browser */ }
    }

    tilt = null; okSince = 0; busy = false; sensorSeen = false; lastOrient = 0; noSensor = false;
    el('camHint').textContent = OK_HINT;
    window.addEventListener('deviceorientation', onOrient);
    window.addEventListener('devicemotion', onMotion);
    setTimeout(() => {
      if (sensorSeen || !stream) return;
      noSensor = true;
      el('camAngle').textContent = 'Level unknown';
      el('camHint').textContent = isIOSNonSafari
        ? 'This browser does not give web pages access to the tilt sensor on iPhone. Open the page in Safari to use the level – or take the photo by hand, as flat as you can.'
        : perm === 'denied'
          ? 'Motion access was not allowed. Close this tab, open the page again and tap “Allow” when asked – or take the photo by hand, as flat as you can.'
          : 'No tilt sensor available – take the photo by hand, as flat as you can.';
    }, 1500);
    cancelAnimationFrame(anim);
    frame();
  }

  function close() {
    cancelAnimationFrame(anim);
    window.removeEventListener('deviceorientation', onOrient);
    window.removeEventListener('devicemotion', onMotion);
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
