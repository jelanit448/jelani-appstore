/* East Side Dash — paid-pack unlock codes.
 * Offline, self-verifying: the game checks the code locally, no server needed.
 * Jelani makes codes with ../gen-code.js after a buyer pays him on Cash App.
 * 8 chars: 6 random payload + 2 checksum (FNV-1a over SECRET + payload,
 * expressed as two base-31 digits => ~1-in-961 guess chance).
 * anyone who reads this file could forge codes, so keep the SECRET private.
 * No DOM here at all — safe under the build-time JS audit.
 */
(function () {
  'use strict';

  var SECRET = 'dash-nights-eastside-99';
  var ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

  function fnv1a(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  function checksumChars(payload) {
    var h = (fnv1a(SECRET + ':' + payload) % 961); // 31*31: two base-31 digits
    return ALPHA.charAt(Math.floor(h / 31)) + ALPHA.charAt(h % 31);
  }

  function makeCode() {
    var payload = '';
    for (var i = 0; i < 6; i++) {
      payload += ALPHA.charAt(Math.floor(Math.random() * ALPHA.length));
    }
    var c = checksumChars(payload);
    return payload.slice(0, 4) + '-' + payload.slice(4) + c;
  }

  function verifyCode(input) {
    var raw = String(input === undefined || input === null ? '' : input).toUpperCase();
    var s = '';
    for (var i = 0; i < raw.length; i++) {
      var ch = raw.charAt(i);
      if (ALPHA.indexOf(ch) >= 0) { s += ch; }
    }
    if (s.length !== 8) { return false; }
    var payload = s.slice(0, 6);
    var c = checksumChars(payload);
    return s.charAt(6) === c.charAt(0) && s.charAt(7) === c.charAt(1);
  }

  var api = { make: makeCode, verify: verifyCode };

  if (typeof module !== 'undefined' && module && module.exports) {
    module.exports = api; // node: gen-code.js
  }
  if (typeof window !== 'undefined' && window) {
    window.DashCodes = api; // browser / WebView: game.js reads window.DashCodes
  }
})();
