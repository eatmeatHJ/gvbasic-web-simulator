// boot the firmware and write a few LCD pictures: node boot_demo.js out.png
const { make } = require('./sim.js');
const s = make();
s.run(100); s.snap();                 // first start-up message
s.run(200); s.snap();                 // the question about the data in the flash
s.tap('n', 12, 12); s.run(1800); s.snap();      // logo screens
s.tap(0x0D, 10, 10); s.run(150); s.snap();      // main menu
s.tap(0x06, 10, 10); s.run(400); s.snap();      // a dictionary application
s.save(process.argv[2] || 'boot_demo.png', 3);
console.log('frames run:', s.m.frame, ' pc=$' + s.m.cpu.pc.toString(16));
