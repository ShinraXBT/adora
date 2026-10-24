// Decodes pump.fun events from Solana transactions.
// Layouts follow the official IDLs: https://github.com/pump-fun/pump-public-docs/tree/main/idl

export const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const PUMP_AMM_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
export const PUMP_FEES_PROGRAM = 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ';

// Anchor event discriminators: sha256("event:<Name>")[0..8]
const DISC = {
  create: '1b72a94ddeeb6376', // pump CreateEvent
  trade: 'bddb7fd34ee661ee', // pump TradeEvent
  ammBuy: '67f4521f2cf57777', // pump_amm BuyEvent
  ammSell: '3e2f370aa503dc2a', // pump_amm SellEvent
  socialClaimed: '3212c141edd2eaec', // pump_fees SocialFeePdaClaimed
};

// pump_fees instructions signed by pump.fun's social claim authority once the X account is verified.
const CLAIM_IX = new Set(['e115fb85a11ec7e2', '114df0863abc3595']); // claim_social_fee_pda, _v2

// Prefix of Anchor #[event_cpi] self-invocations (EVENT_IX_TAG, little endian).
const EVENT_IX_TAG = 'e445a52e51cb9a1d';

export const SOCIAL_PLATFORM_X = 1; // SocialFeePda.platform: 0=pump, 1=twitter

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

export function base58Decode(str) {
  const bytes = [];
  for (const ch of str) {
    let carry = ALPHABET.indexOf(ch);
    if (carry < 0) throw new Error('invalid base58');
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let zeros = 0;
  while (zeros < str.length && str[zeros] === '1') zeros++;
  return Buffer.from([...new Array(zeros).fill(0), ...bytes.reverse()]);
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
  u8() {
    this.need(1);
    return this.buf[this.o++];
  }
  bool() {
    return this.u8() !== 0;
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

export function decodeEvent(buf) {
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
      case DISC.socialClaimed: {
        r.skip(8); // timestamp
        const userId = r.string();
        const platform = r.u8();
        r.skip(32); // social_fee_pda
        const recipient = r.pubkey();
        return { type: 'social-claim', userId, platform, recipient };
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

export function decodeProgramData(b64) {
  return decodeEvent(Buffer.from(b64, 'base64'));
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

// Anchor logs "Instruction: ClaimSocialFeePda" (or ...V2) for the fee-claim instruction.
export const hasSocialClaim = logs => (logs || []).some(l => l.includes('Instruction: ClaimSocialFeePda'));

function decodeClaimInstruction(data, accounts, keys) {
  if (data.length < 8 || !CLAIM_IX.has(data.subarray(0, 8).toString('hex'))) return null;
  try {
    const r = new Reader(data);
    const userId = r.string();
    const platform = r.u8();
    const recipient = keys[accounts[0]];
    return recipient ? { type: 'social-claim', userId, platform, recipient } : null;
  } catch {
    return null;
  }
}

// Social fee claims from a getTransaction result (encoding "json"): the event in the logs,
// the #[event_cpi] inner instruction, or failing both the claim instruction itself.
export function socialClaimsFromTransaction(tx) {
  const found = new Map();
  const add = ev => ev?.type === 'social-claim' && found.set(`${ev.userId}:${ev.recipient}`, ev);
  for (const ev of eventsFromLogs(tx?.meta?.logMessages)) add(ev);
  const msg = tx?.transaction?.message ?? {};
  const keys = [...(msg.accountKeys ?? []), ...(tx?.meta?.loadedAddresses?.writable ?? []), ...(tx?.meta?.loadedAddresses?.readonly ?? [])];
  const instructions = [...(msg.instructions ?? []), ...(tx?.meta?.innerInstructions ?? []).flatMap(i => i.instructions ?? [])];
  for (const ix of instructions) {
    let data;
    try {
      data = base58Decode(ix.data ?? '');
    } catch {
      continue;
    }
    if (data.subarray(0, 8).toString('hex') === EVENT_IX_TAG) add(decodeEvent(data.subarray(8)));
    else add(decodeClaimInstruction(data, ix.accounts ?? [], keys));
  }
  return [...found.values()];
}
