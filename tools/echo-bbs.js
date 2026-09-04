'use strict';
// Minimal telnet "BBS" for offline end-to-end testing. Sends an ANSI/CP437
// banner, then echoes typed lines back with a prompt. Not a real BBS — just a
// deterministic telnet peer so the modem link + proxy can be exercised without
// the public internet.
const net = require('net');
const PORT = parseInt(process.argv[2] || '2323', 10);

const ESC = '\x1b[';
const banner =
  ESC + '2J' + ESC + 'H' +
  ESC + '1;36m' + '\r\n' +
  '  +==============================================+\r\n' +
  '  |  ' + ESC + '1;33m' + 'SYNTHLINK TEST BBS' + ESC + '1;36m' + '                        |\r\n' +
  '  |  ' + ESC + '0;37m' + 'reached over a V.21 software modem link' + ESC + '1;36m' + '   |\r\n' +
  '  +==============================================+\r\n' +
  ESC + '0m' + '\r\n' +
  'Type anything and press Enter; I will echo it back.\r\n' +
  'Type ' + ESC + '1;32m' + 'BYE' + ESC + '0m' + ' to disconnect.\r\n\r\n' +
  ESC + '1;37m' + 'BBS> ' + ESC + '0m';

const server = net.createServer((sock) => {
  sock.setNoDelay(true);
  sock.write(Buffer.from(banner, 'latin1'));
  let line = '';
  sock.on('data', (buf) => {
    for (const b of buf) {
      const ch = String.fromCharCode(b);
      if (b === 0x0d || b === 0x0a) {
        if (line.trim().toUpperCase() === 'BYE') {
          sock.write(Buffer.from('\r\n' + ESC + '1;35m' + 'Goodbye!' + ESC + '0m' + '\r\n', 'latin1'));
          sock.end();
          return;
        }
        sock.write(Buffer.from('\r\n' + ESC + '0;32m' + 'you said: ' + ESC + '0m' + line +
          '\r\n' + ESC + '1;37m' + 'BBS> ' + ESC + '0m', 'latin1'));
        line = '';
      } else if (b === 0x08 || b === 0x7f) {
        line = line.slice(0, -1);
        sock.write(Buffer.from('\b \b', 'latin1'));
      } else if (b >= 0x20) {
        line += ch;
        sock.write(Buffer.from(ch, 'latin1')); // local echo
      }
    }
  });
  sock.on('error', () => {});
});

server.listen(PORT, () => {
  console.log(`echo-bbs listening on telnet :${PORT}`);
  // This peer is on loopback, and lib/netguard refuses every non-public
  // destination as a CONSTANT — there is no config key for it, deliberately. So
  // a server started the ordinary way CANNOT reach this, and what you get
  // instead is a reorder tone and a refusal in the log.
  //
  // Printed here rather than left to a document because this is the moment it
  // is needed, and because the wrong conclusion is an expensive one: the failure
  // looks like a bug in the address policy, and that policy is the control that
  // stops this server being an open proxy into its own network. It is not the
  // thing to relax to make a local test pass — the flag below is.
  console.log('point a server at it with:');
  console.log('  node server.js --allow-private-ips=127.0.0.0/8');
  console.log(`then dial 127.0.0.1:${PORT}`);
});
