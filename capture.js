// capture.js — records the game's real physics setup messages (Init + CreateCar),
// keeping the exact data types, so a headless physics runner can replay them later.
// Load it BEFORE the game's own scripts in index.html. It does not change how the game plays.
(function () {
  const captured = { gameVersion: null, init: null, createCars: [] };

  function toBase64(u8) {
    let s = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < u8.length; i += CHUNK) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
    }
    return btoa(s);
  }

  // Turns a message into plain JSON while remembering typed arrays (Float32Array etc.)
  function encode(v) {
    if (v === null || v === undefined || typeof v !== 'object') return v;
    if (ArrayBuffer.isView(v)) {
      const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      return { __type: v.constructor.name, b64: toBase64(bytes) };
    }
    if (v instanceof ArrayBuffer) {
      return { __type: 'ArrayBuffer', b64: toBase64(new Uint8Array(v)) };
    }
    if (Array.isArray(v)) return v.map(encode);
    const out = {};
    for (const key of Object.keys(v)) out[key] = encode(v[key]);
    return out;
  }

  const OriginalWorker = window.Worker;
  window.Worker = function (...args) {
    const w = new OriginalWorker(...args);
    try {
      if (args[0] && String(args[0]).includes('simulation_worker')) {
        const originalPostMessage = w.postMessage.bind(w);
        w.postMessage = function (msg, ...rest) {
          try {
            if (msg && msg.messageType === 0 && !captured.init) {
              captured.init = encode(msg);
              captured.gameVersion = msg.version;
              console.log('[capture] Init captured. Game version:', msg.version, '| track parts:', msg.trackParts && msg.trackParts.length);
            }
            if (msg && msg.messageType === 3) {
              captured.createCars.push(encode(msg));
              if (captured.createCars.length > 5) captured.createCars.shift();
              console.log('[capture] CreateCar captured (keeping the last 5).');
            }
          } catch (e) {
            console.warn('[capture] error (the game is not affected):', e);
          }
          return originalPostMessage(msg, ...rest);
        };
      }
    } catch (e) {}
    return w;
  };
  window.Worker.prototype = OriginalWorker.prototype;

  window.PolyCapture = {
    download() {
      if (!captured.init || !captured.createCars.length) {
        console.warn('[capture] Nothing captured yet. Start a race first, then try again.');
        return;
      }
      const blob = new Blob([JSON.stringify(captured)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'physics_inputs.json';
      a.click();
      console.log('[capture] Downloaded physics_inputs.json');
    },
  };

  console.log('[capture] Ready. Start a race, then run PolyCapture.download()');
})();