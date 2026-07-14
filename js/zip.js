/* Minimal ZIP writer (STORE method, no compression) for bulk downloads.
   ZIP.make([{name, data}]) -> Blob. `data` may be a string (UTF-8 encoded)
   or a Uint8Array. File names are flagged as UTF-8. */
(function (global) {
  'use strict';

  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var i = 0; i < 256; i++) {
      var c = i;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function make(entries) {
    var enc = new TextEncoder();
    var d = new Date();
    var dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    var dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();

    var parts = [], centrals = [], offset = 0, cdSize = 0;

    entries.forEach(function (e) {
      var nameB = enc.encode(e.name);
      var dataB = typeof e.data === 'string' ? enc.encode(e.data) : e.data;
      var crc = crc32(dataB);

      var lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true);  // local file header signature
      lh.setUint16(4, 20, true);          // version needed
      lh.setUint16(6, 0x0800, true);      // flags: UTF-8 names
      lh.setUint16(8, 0, true);           // method: store
      lh.setUint16(10, dosTime, true);
      lh.setUint16(12, dosDate, true);
      lh.setUint32(14, crc, true);
      lh.setUint32(18, dataB.length, true); // compressed size
      lh.setUint32(22, dataB.length, true); // uncompressed size
      lh.setUint16(26, nameB.length, true);
      lh.setUint16(28, 0, true);          // extra length
      parts.push(new Uint8Array(lh.buffer), nameB, dataB);

      var ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true);  // central directory signature
      ch.setUint16(4, 20, true);          // version made by
      ch.setUint16(6, 20, true);          // version needed
      ch.setUint16(8, 0x0800, true);
      ch.setUint16(10, 0, true);
      ch.setUint16(12, dosTime, true);
      ch.setUint16(14, dosDate, true);
      ch.setUint32(16, crc, true);
      ch.setUint32(20, dataB.length, true);
      ch.setUint32(24, dataB.length, true);
      ch.setUint16(28, nameB.length, true);
      // extra/comment lengths, disk number, attributes: all zero
      ch.setUint32(42, offset, true);     // local header offset
      centrals.push(new Uint8Array(ch.buffer), nameB);
      cdSize += 46 + nameB.length;
      offset += 30 + nameB.length + dataB.length;
    });

    var eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054b50, true);  // end-of-central-directory signature
    eocd.setUint16(8, entries.length, true);
    eocd.setUint16(10, entries.length, true);
    eocd.setUint32(12, cdSize, true);
    eocd.setUint32(16, offset, true);     // central directory offset
    centrals.push(new Uint8Array(eocd.buffer));

    return new Blob(parts.concat(centrals), { type: 'application/zip' });
  }

  global.ZIP = { make: make };
})(typeof window !== 'undefined' ? window : this);
