const { createPhysics } = require('./physics');
(async () => {
  const sim = await createPhysics();
  console.log('engine started, game version', sim.gameVersion);
  const id = sim.createCar();
  console.log('car created');
  let s;
  for (let f = 0; f < 600; f++) {
    s = sim.step(id, { up: true });
    if (f % 100 === 0) console.log(`frame ${s.frames}`, 'speed', s.speedKmh.toFixed(1), 'started', s.hasStarted, 'ckpt', s.nextCheckpointIndex, 'pos', s.position.x.toFixed(1), s.position.y.toFixed(1), s.position.z.toFixed(1));
  }
  console.log('last:', JSON.stringify({ frames: s.frames, speed: s.speedKmh, started: s.hasStarted, finished: s.hasFinished }));
  const T = Date.now();
  for (let f = 0; f < 20000; f++) sim.step(id, { up: true, left: f % 50 < 25 });
  const sec = (Date.now() - T) / 1000;
  console.log('20000 frames in', sec.toFixed(2), 's =>', Math.round(20000 / sec), 'frames/sec');
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });