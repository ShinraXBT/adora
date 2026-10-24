// Decodes pump.fun events from Solana transaction logs ("Program data: <base64>").
// Layouts follow the official IDLs: https://github.com/pump-fun/pump-public-docs/tree/main/idl

export const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const PUMP_AMM_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

// Anchor event discriminators: sha256("event:<Name>")[0..8]
const DISC = {
  create: '1b72a94ddeeb6376', // pump CreateEvent
  trade: 'bddb7fd34ee661ee', // pump TradeEvent
  ammBuy: '67f4521f2cf57777', // pump_amm BuyEvent
  ammSell: '3e2f370aa503dc2a', // pump_amm SellEvent
};

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58(bytes) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]];
  return out;
}

class Reader {
  constructor(buf, offset = 8) {
    this.buf = buf;
    this.o = offset;
  }
  need(n) {
    if (this.o + n > this.buf.length) throw new RangeError('truncated event');
  }
  pubkey() {
    this.need(32);
    const key = base58(this.buf.subarray(this.o, this.o + 32));
    this.o += 32;
    return key;
  }
  u64() {
    this.need(8);
    const v = this.buf.readBigUInt64LE(this.o);
    this.o += 8;
    return v;
  }
  bool() {
    this.need(1);
    return this.buf[this.o++] !== 0;
  }
  string() {
    this.need(4);
    const len = this.buf.readUInt32LE(this.o);
    this.o += 4;
    this.need(len);
    const s = this.buf.toString('utf8', this.o, this.o + len);
    this.o += len;
    return s;
  }
  skip(n) {
    this.need(n);
    this.o += n;
  }
}

const lamportsToSol = v => Number(v) / 1e9;

export function decodeProgramData(b64) {
  let buf;
  try {
    buf = Buffer.from(b64, 'base64');
  } catch {
    return null;
  }
  if (buf.length < 8) return null;
  const disc = buf.subarray(0, 8).toString('hex');
  const r = new Reader(buf);
  try {
    switch (disc) {
      case DISC.create: {
        const name = r.string();
        const symbol = r.string();
        r.string(); // uri
        const mint = r.pubkey();
        r.skip(32); // bonding_curve
        const user = r.pubkey();
        const creator = r.pubkey();
        return { type: 'create', name, symbol, mint, user, creator };
      }
      case DISC.trade: {
        const mint = r.pubkey();
        const sol = lamportsToSol(r.u64());
        r.skip(8); // token_amount
        const isBuy = r.bool();
        const user = r.pubkey();
        r.skip(8 + 8 * 4 + 32 + 8 + 8); // timestamp, reserves, fee_recipient, fee_bps, fee
        const creator = r.pubkey();
        return { type: isBuy ? 'buy' : 'sell', mint, sol, user, creator };
      }
      case DISC.ammBuy:
      case DISC.ammSell: {
        // 14 x 8-byte fields (timestamp + amounts/fees) precede `pool` in both events.
        r.skip(8 * 14);
        const pool = r.pubkey();
        const user = r.pubkey();
        r.skip(32 * 4); // user token accounts, protocol fee recipient + its token account
        const creator = r.pubkey();
        return { type: disc === DISC.ammBuy ? 'amm-buy' : 'amm-sell', pool, user, creator };
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

export function eventsFromLogs(logs) {
  const events = [];
  for (const line of logs || []) {
    if (!line.startsWith('Program data: ')) continue;
    const ev = decodeProgramData(line.slice(14).split(' ')[0]);
    if (ev) events.push(ev);
  }
  return events;
}
