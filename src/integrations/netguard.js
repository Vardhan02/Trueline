'use strict';

/**
 * Outbound requests to addresses a user typed (webhooks) must not reach private networks (SSRF).
 * Checking the hostname when the webhook is saved is not enough: "127.0.0.1.nip.io" is a public name
 * for a private address, and DNS answers can change later. So the address is checked again at connect
 * time, inside the socket's own DNS lookup, which also closes the gap between "check" and "use".
 */
const net = require('node:net');
const dns = require('node:dns');
const https = require('node:https');

const blocked = new net.BlockList();
[
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15], // benchmarking
  ['224.0.0.0', 3] // multicast and reserved, up to 255.255.255.255
].forEach(([a, p]) => blocked.addSubnet(a, p, 'ipv4'));
[
  ['::', 128], // unspecified
  ['::1', 128],
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8] // multicast
].forEach(([a, p]) => blocked.addSubnet(a, p, 'ipv6'));

/** The IPv4 address hidden inside an IPv6 one (::ffff:a.b.c.d, ::a.b.c.d, 64:ff9b::a.b.c.d), or null. */
function embeddedV4(ip) {
  const m = /^(?:::(?:ffff:(?:0:)?)?|64:ff9b::)([0-9a-f.:]+)$/i.exec(ip);
  if (!m) return null;
  if (net.isIPv4(m[1])) return m[1];
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(m[1]);
  if (!hex) return null;
  const n = (parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16);
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

/** True for loopback, private, link-local, multicast and other addresses that are not on the public internet. */
function isPrivateIp(raw) {
  const ip = String(raw || '')
    .replace(/^\[|\]$/g, '')
    .replace(/%.*$/, '') // zone id, e.g. fe80::1%eth0
    .toLowerCase();
  const v = net.isIP(ip);
  if (v === 4) return blocked.check(ip, 'ipv4');
  if (v === 6) {
    const v4 = embeddedV4(ip);
    return v4 ? blocked.check(v4, 'ipv4') : blocked.check(ip, 'ipv6');
  }
  return true; // not an IP at all: refuse rather than guess
}

class BlockedAddressError extends Error {
  constructor(host) {
    super(host + ' points to a private network address, which webhooks cannot reach.');
    this.code = 'EBLOCKED';
  }
}

/** A dns.lookup replacement for sockets: resolves as usual, then refuses if any answer is private. */
function guardedLookup(hostname, options, callback) {
  const opts = typeof options === 'number' ? { family: options } : Object.assign({}, options);
  dns.lookup(hostname, Object.assign({}, opts, { all: true }), (err, list) => {
    if (err) return callback(err);
    if (!list.length || list.some((a) => isPrivateIp(a.address))) return callback(new BlockedAddressError(hostname));
    if (opts.all) return callback(null, list);
    return callback(null, list[0].address, list[0].family);
  });
}

/**
 * POST to a public https address. Resolves to { status }. No redirects are followed.
 * Same call shape as fetch for the parts webhooks use, so tests can swap in a fake.
 */
function guardedPost(url, { method = 'POST', headers = {}, body = '', signal } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      return reject(new Error('Invalid address'));
    }
    if (u.protocol !== 'https:') return reject(new Error('Only https:// addresses are allowed'));
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && isPrivateIp(host)) return reject(new BlockedAddressError(host)); // IP literals skip the lookup
    const req = https.request(
      u,
      { method, headers: Object.assign({ 'Content-Length': Buffer.byteLength(body) }, headers), lookup: guardedLookup, signal },
      (res) => {
        res.resume(); // the body is not needed; drain it so the socket is freed
        resolve({ status: res.statusCode });
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

module.exports = { isPrivateIp, guardedLookup, guardedPost, BlockedAddressError };
