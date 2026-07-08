/* Web Worker: těžké analýzy běží mimo hlavní vlákno (render se nezasekne).
   Dostane serializovaný stav hry, postaví si vlastní simulaci a počítá. */
self.window = self;
importScripts('rng.js', 'map.js', 'sim.js');

self.onmessage = (e) => {
  const { cmd, save } = e.data;
  if (cmd === 'n1') {
    const sim = self.EG.restore(save);
    sim.msg = () => {}; // hlášky řeší hlavní vlákno
    const rep = sim.n1Report();
    self.postMessage({
      cmd: 'n1',
      critical: Array.from(sim._n1Critical || []),
      checked: rep.checked,
    });
  }
};
