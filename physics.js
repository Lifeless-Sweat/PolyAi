// physics.js — runs PolyTrack's real physics engine headlessly in Node (no game, no UI).
// It loads the game's own simulation_worker.bundle.js + polytrack_physics.wasm, and exposes
// a function that advances the car by exactly one frame with the controls you give it.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;

// Turns the data saved by capture.js back into real objects (typed arrays included).
function rehydrate(v) {
  if (v && typeof v === 'object') {
    if (v.__type) {
      const buf = Buffer.from(v.b64, 'base64');
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      return v.__type === 'ArrayBuffer' ? ab : new globalThis[v.__type](ab);
    }
    if (Array.isArray(v)) return v.map(rehydrate);
    const out = {};
    for (const k of Object.keys(v)) out[k] = rehydrate(v[k]);
    return out;
  }
  return v;
}

// Reads the 227-byte car state the engine writes after each frame (same layout the game decodes).
function decodeCarState(arrayBuffer) {
  const all = new Uint8Array(arrayBuffer);
  const e = all.subarray(4); // first 4 bytes = car id
  const n = new DataView(e.buffer, e.byteOffset, e.byteLength);
  let i = 0;
  const frames = e[i] | (e[i + 1] << 8) | (e[i + 2] << 16); i += 3;
  const speedKmh = n.getFloat32(i, true); i += 4;
  const flags = e[i]; i += 1;
  const hasStarted = !!(flags & 1), hasFinished = !!(flags & 2), hasCheckpointToRespawnAt = !!(flags & 4);
  const contact = [!!(flags & 8), !!(flags & 16), !!(flags & 32), !!(flags & 64)];
  let finishFrames = null;
  if (hasFinished) { finishFrames = e[i] | (e[i + 1] << 8) | (e[i + 2] << 16); i += 3; }
  const nextCheckpointIndex = n.getUint16(i, true); i += 2;
  const position = { x: n.getFloat32(i, true), y: n.getFloat32(i + 4, true), z: n.getFloat32(i + 8, true) }; i += 12;
  const quaternion = { x: n.getFloat32(i, true), y: n.getFloat32(i + 4, true), z: n.getFloat32(i + 8, true), w: n.getFloat32(i + 12, true) }; i += 16;
  const numImpulses = n.getUint8(i); i += 1;
  const collisionImpulses = [];
  for (let k = 0; k < numImpulses; k++) { collisionImpulses.push(n.getFloat32(i, true)); i += 4; }
  const wheelContact = [null, null, null, null];
  for (let k = 0; k < 4; k++) {
    if (contact[k]) {
      const p = { x: n.getFloat32(i, true), y: n.getFloat32(i + 4, true), z: n.getFloat32(i + 8, true) }; i += 12;
      const nr = { x: n.getFloat32(i, true), y: n.getFloat32(i + 4, true), z: n.getFloat32(i + 8, true) }; i += 12;
      wheelContact[k] = { position: p, normal: nr };
    }
  }
  const read4 = () => { const a = []; for (let k = 0; k < 4; k++) { a.push(n.getFloat32(i, true)); i += 4; } return a; };
  const wheelSuspensionLength = read4();
  const wheelSuspensionVelocity = read4();
  const wheelDeltaRotation = read4();
  const wheelSkidInfo = read4();
  const steering = n.getFloat32(i, true); i += 4;
  const cb = e[i];
  const controls = { up: !!(cb & 1), right: !!(cb & 2), down: !!(cb & 4), left: !!(cb & 8), reset: !!(cb & 16) };
  const brakeLightEnabled = !!(cb & 32);
  return {
    frames, speedKmh, hasStarted, finishFrames, hasFinished, nextCheckpointIndex, hasCheckpointToRespawnAt,
    position, quaternion, collisionImpulses, wheelContact, wheelSuspensionLength, wheelSuspensionVelocity,
    wheelDeltaRotation, wheelSkidInfo, steering, brakeLightEnabled, controls,
  };
}

// Starts the engine. Returns an object with createCar(), step(), decodeCarState().
async function createPhysics(inputsPath = path.join(ROOT, 'physics_inputs.json')) {
  const inputs = JSON.parse(fs.readFileSync(inputsPath, 'utf8'));
  const wasmBytes = new Uint8Array(fs.readFileSync(path.join(ROOT, 'polytrack_physics.wasm')));

  // --- the few things the worker file expects from a browser worker ---
  const realProcess = globalThis.process;
  globalThis.self = globalThis;
  globalThis.onmessage = null;
  globalThis.postMessage = () => {};
  globalThis.addEventListener = () => {};
  globalThis.location = { href: 'file://' + path.join(ROOT, 'lib', 'polytrack_physics.js') };
  globalThis.setInterval = () => 0; // the worker's own real-time loops are not needed
  globalThis.importScripts = (p) => {
    const file = path.join(ROOT, p);
    vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: file });
    const original = globalThis.PolyTrackPhysics;
    globalThis.PolyTrackPhysics = (opts = {}) => original({ ...opts, wasmBinary: wasmBytes });
  };

  // The worker file gets one tiny addition so we can reach its step function directly.
  let code = fs.readFileSync(path.join(ROOT, 'simulation_worker.bundle.js'), 'utf8');
  const marker = '$o.length=0,onmessage=r;';
  if (!code.includes(marker)) throw new Error('simulation_worker.bundle.js does not look like the expected 0.6.3 file');
  code = code.replace(marker, marker + 'globalThis.__poly={step:n,handle:r};');

  globalThis.process = undefined; // one library inside the worker file misbehaves when it sees Node
  try {
    vm.runInThisContext(code, { filename: 'simulation_worker.bundle.js' });
  } finally {
    globalThis.process = realProcess;
  }

  const t0 = Date.now();
  while (!globalThis.__poly) {
    if (Date.now() - t0 > 20000) throw new Error('Physics engine did not start within 20 seconds');
    await new Promise((r) => setTimeout(r, 10));
  }
  const poly = globalThis.__poly;

  // Setup data captured from the real game (isRealtime false = we step the frames ourselves)
  const init = rehydrate(inputs.init);
  init.isRealtime = false;
  poly.handle({ data: init });

  return {
    inputs,
    gameVersion: inputs.gameVersion,
    decodeCarState,
    // Puts a car on a track. `which` picks one of the captured CreateCar messages (default: the last one).
    createCar(which = inputs.createCars.length - 1, carId = 0) {
      const msg = rehydrate(inputs.createCars[which]);
      msg.carId = carId;
      msg.carRecording = null;
      poly.handle({ data: msg });
      return carId;
    },
    // Advances one frame. Returns the decoded car state.
    step(carId, controls) {
      const c = controls || {};
      const buf = poly.step({ id: carId }, {
        up: !!c.up, right: !!c.right, down: !!c.down, left: !!c.left, reset: !!c.reset,
      });
      return decodeCarState(buf);
    },
  };
}

module.exports = { createPhysics, decodeCarState, rehydrate };