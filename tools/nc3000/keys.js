// key codes the firmware's scan routine produces, from its table at $ED05 (column*8 + row), and a helper to press them
const fs = require('fs');
function keyTable(nor) {
  const pos = new Map();
  for (let c = 0; c < 8; c++) for (let r = 0; r < 8; r++) { const code = nor[0x6000 + 0xED05 + c * 8 + r - 0xE000]; if (code !== 0xFF && !pos.has(code)) pos.set(code, [c, r]); }
  return pos;
}
module.exports = { keyTable };
